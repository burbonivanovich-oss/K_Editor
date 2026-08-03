#!/usr/bin/env node
// Demand watch — детерминированный анализатор спроса по ВСЕМ кластерам блога
// против актуальной частотности из Wordstat (keys.json).
//
// Сетевых запросов НЕ делает: читает собранный кеш и frontmatter статей.
// Запускается в конце weekly-workflow (после fetch/discover/diff) и пишет
// отчёт, который интерпретирует скилл /demand-watch.
//
// По каждой опубликованной статье (по её seo.keywords) считает:
//   📈 РАСТЁТ        — спрос вырос ×2 (recent3/baseline6) или trend=up
//   🔁 ПЕРЕФОРМУЛ.   — topShows ≥ 3×shows: аудитория ищет короче нашего ключа
//   📉 ПАДАЕТ        — спрос упал ×2 (кандидат на объединение/архив)
// По каждому кластеру в целом:
//   🆕 НЕПОКРЫТО     — фраза с якорным словом кластера и спросом ≥ UNCOVERED_MIN,
//                      которой нет ни в одном seo.keywords статей кластера
//
// Кластер = значение из frontmatter.categories. Анализируются все кластеры,
// присутствующие в опубликованных статьях. ONLY_CLUSTER=<slug> — ограничить.
//
// Чтение:  src/data/wordstat/keys.json, src/content/blog/*.md(x)
// Запись:  src/data/wordstat/demand-watch.md

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BLOG_DIR = join(ROOT, "src", "content", "blog");
const KEYS_FILE = join(ROOT, "src", "data", "wordstat", "keys.json");
const OUT_FILE = join(ROOT, "src", "data", "wordstat", "demand-watch.md");

const GROW_RATIO = 2; // recent3/baseline6 ≥ 2 → растёт
const DECLINE_RATIO = 0.5; // ≤ 0.5 → падает
const REFORMULATE_FACTOR = 3; // topShows ≥ 3×shows → переформулировать
const UNCOVERED_MIN = 800; // порог спроса для «непокрытой» фразы
const ONLY_CLUSTER = process.env.ONLY_CLUSTER || "";

// Общие/служебные слова — не «отличительные» при оценке покрытия и якорей.
const STOP = new Set([
  "тс", "это", "что", "такое", "для", "и", "в", "на", "по", "с", "как",
  "или", "из", "за", "от", "до", "не", "ли", "же", "а", "но", "у", "о",
  "кому", "когда", "где", "чем", "под", "при", "без", "год", "году", "2026",
  "2025", "нужен", "нужна", "нужно", "какой", "какая", "какие", "сколько",
]);

function normalize(s) {
  return String(s)
    .replace(/[«»"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokens(s) {
  return normalize(s)
    .split(/[\s,/()]+/)
    .map((t) => t.replace(/[^a-zа-я0-9]/giu, ""))
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
}

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

function scalar(fm, field) {
  const m = fm.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

function listField(fm, field) {
  const inline = fm.match(new RegExp(`^${field}:\\s*\\[(.*?)\\]`, "m"));
  if (inline) {
    return inline[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const block = fm.match(
    new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s.+\\n?)+)`, "m"),
  );
  if (!block) return [];
  return block[1]
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

function extractSeoKeywords(fm) {
  // Прямой матч keywords: (см. комментарий в extract-keys.mjs про seo-блок).
  const kwBlock = fm.match(/^\s*keywords:\s*\n((?:\s+-\s.+\n?)+)/m);
  if (!kwBlock) return [];
  return kwBlock[1]
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function growthRatio(history) {
  if (!Array.isArray(history) || history.length < 9) return null;
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const r3 = avg(history.slice(-3).map((p) => p.count));
  const b6 = avg(history.slice(-9, -3).map((p) => p.count));
  if (b6 === 0) return r3 > 0 ? Infinity : null;
  return r3 / b6;
}

function loadArticles() {
  const out = [];
  for (const file of readdirSync(BLOG_DIR)) {
    if (!file.endsWith(".md") && !file.endsWith(".mdx")) continue;
    const fm = parseFrontmatter(readFileSync(join(BLOG_DIR, file), "utf8"));
    if (!fm) continue;
    if (scalar(fm, "draft") === "true") continue;
    const cats = listField(fm, "categories");
    if (!cats.length) continue;
    out.push({
      slug: file.replace(/\.(md|mdx)$/, ""),
      title: scalar(fm, "title") || file,
      categories: cats,
      keywords: extractSeoKeywords(fm),
    });
  }
  return out;
}

function fmtNum(n) {
  return n === Infinity ? "∞" : Math.round(n).toLocaleString("ru-RU");
}

function main() {
  if (!existsSync(KEYS_FILE)) {
    console.error(`demand-watch: ${KEYS_FILE} не найден`);
    process.exit(0);
  }
  const cache = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
  const keys = cache.keys || {};
  const articles = loadArticles();

  // Кластеры из categories.
  let clusters = [...new Set(articles.flatMap((a) => a.categories))].sort();
  if (ONLY_CLUSTER) clusters = clusters.filter((c) => c === ONLY_CLUSTER);

  // Предрасчёт по фразам из keys (для непокрытого спроса).
  const phraseDemand = new Map(); // norm phrase → max demand
  const bump = (phrase, count) => {
    const n = normalize(phrase);
    if (!n) return;
    phraseDemand.set(n, Math.max(phraseDemand.get(n) || 0, count || 0));
  };
  for (const e of Object.values(keys)) {
    bump(e.phrase || "", Math.max(e.shows || 0, e.topShows || 0));
    for (const r of e.related || []) bump(r.phrase, r.count);
  }

  // Якорные токены: считаем кандидатов по каждому кластеру (токен в ≥2 статьях,
  // или все токены, если статья одна), затем оставляем только ЭКСКЛЮЗИВНЫЕ —
  // те, что являются кандидатом ровно в одном кластере. Это убирает шум от
  // общих слов («маркировка», «касса», «честный»), которые есть везде.
  const candAnchors = new Map(); // cluster → Set(token)
  const tokenClusterCount = new Map(); // token → число кластеров-кандидатов
  for (const cluster of clusters) {
    const arts = articles.filter((a) => a.categories.includes(cluster));
    const tokenArticleCount = new Map();
    for (const a of arts) {
      for (const t of new Set(a.keywords.flatMap(tokens))) {
        tokenArticleCount.set(t, (tokenArticleCount.get(t) || 0) + 1);
      }
    }
    const minArticles = arts.length >= 2 ? 2 : 1;
    const set = new Set(
      [...tokenArticleCount.entries()]
        .filter(([, c]) => c >= minArticles)
        .map(([t]) => t),
    );
    candAnchors.set(cluster, set);
    for (const t of set) {
      tokenClusterCount.set(t, (tokenClusterCount.get(t) || 0) + 1);
    }
  }

  const sections = [];
  let totalGrow = 0,
    totalReform = 0,
    totalUncovered = 0,
    totalDecline = 0;

  for (const cluster of clusters) {
    const arts = articles.filter((a) => a.categories.includes(cluster));
    const coverageText = arts.flatMap((a) => a.keywords).map(normalize).join(" | ");

    // Эксклюзивные якоря — кандидат только этого кластера.
    const anchors = new Set(
      [...candAnchors.get(cluster)].filter((t) => tokenClusterCount.get(t) === 1),
    );

    const grows = [];
    const reforms = [];
    const declines = [];
    for (const art of arts) {
      for (const kw of art.keywords) {
        const entry = keys[normalize(kw)];
        if (!entry) continue;
        const shows = entry.shows || 0;
        const topShows = entry.topShows || 0;
        const demand = Math.max(shows, topShows);
        const ratio = growthRatio(entry.history);
        if ((ratio !== null && ratio >= GROW_RATIO) || (ratio === null && entry.trend === "up")) {
          grows.push({ slug: art.slug, phrase: kw, ratio, demand, trend: entry.trend });
        }
        if (ratio !== null && ratio <= DECLINE_RATIO) {
          declines.push({ slug: art.slug, phrase: kw, ratio });
        }
        if (
          shows > 0 &&
          topShows >= REFORMULATE_FACTOR * shows &&
          entry.topPhrase &&
          normalize(entry.topPhrase) !== normalize(kw)
        ) {
          reforms.push({ slug: art.slug, phrase: kw, shows, topShows, topPhrase: entry.topPhrase });
        }
      }
    }

    // Непокрытый спрос: фразы с якорным словом, спрос ≥ порога, не покрыты.
    const uncovered = [];
    for (const [phrase, count] of phraseDemand) {
      if (count < UNCOVERED_MIN) continue;
      const phTokens = tokens(phrase);
      if (!phTokens.some((t) => anchors.has(t))) continue; // не наш кластер
      if (phTokens.length === 0) continue;
      const covered = phTokens.every((t) => coverageText.includes(t));
      if (!covered) uncovered.push({ phrase, count });
    }

    grows.sort((a, b) => b.demand - a.demand);
    reforms.sort((a, b) => b.topShows - a.topShows);
    declines.sort((a, b) => a.ratio - b.ratio);
    uncovered.sort((a, b) => b.count - a.count);

    totalGrow += grows.length;
    totalReform += reforms.length;
    totalUncovered += uncovered.length;
    totalDecline += declines.length;

    if (!grows.length && !reforms.length && !uncovered.length && !declines.length) {
      sections.push(`## Кластер: ${cluster}\n\nСтатей: ${arts.length}. Сигналов нет — спрос стабилен и покрыт.\n`);
      continue;
    }

    const L = [`## Кластер: ${cluster}`, "", `Статей: ${arts.length}.`, ""];

    if (grows.length) {
      L.push("### 📈 Растёт — обновить и расширить", "");
      L.push("| Статья | Ключ | Спрос | Рост r3/b6 | Тренд |", "|---|---|---|---|---|");
      for (const g of grows) {
        const r = g.ratio === null ? "—" : `×${g.ratio.toFixed(1)}`;
        L.push(`| ${g.slug} | ${g.phrase} | ${fmtNum(g.demand)} | ${r} | ${g.trend || "—"} |`);
      }
      L.push("");
    }
    if (reforms.length) {
      L.push("### 🔁 Переформулировать — topShows ≫ shows", "");
      L.push("| Статья | Текущий ключ | shows | topShows | Заменить на |", "|---|---|---|---|---|");
      for (const r of reforms) {
        L.push(`| ${r.slug} | ${r.phrase} | ${fmtNum(r.shows)} | ${fmtNum(r.topShows)} | ${r.topPhrase} |`);
      }
      L.push("");
    }
    if (uncovered.length) {
      L.push("### 🆕 Непокрытый спрос — новый материал/раздел", "");
      L.push("| Фраза | Спрос (max) |", "|---|---|");
      for (const u of uncovered.slice(0, 15)) L.push(`| ${u.phrase} | ${fmtNum(u.count)} |`);
      L.push("");
    }
    if (declines.length) {
      L.push("### 📉 Падает — объединение/архив", "");
      L.push("| Статья | Ключ | Падение r3/b6 |", "|---|---|---|");
      for (const d of declines) L.push(`| ${d.slug} | ${d.phrase} | ×${d.ratio.toFixed(2)} |`);
      L.push("");
    }
    sections.push(L.join("\n"));
  }

  const head = [
    "# Demand watch — спрос по кластерам (Wordstat)",
    "",
    `Сгенерирован ${todayISO()} скриптом \`scripts/wordstat/demand-watch.mjs\` ` +
      `по \`keys.json\` (lastFullUpdate: ${cache.lastFullUpdate || "—"}).`,
    `Кластеров: ${clusters.length}. Итого сигналов: 📈 ${totalGrow} · 🔁 ${totalReform} · ` +
      `🆕 ${totalUncovered} · 📉 ${totalDecline}.`,
    "Интерпретирует и предлагает правки скилл `/demand-watch`.",
    "",
    "> 🆕 «Непокрытый спрос» — эвристика по якорным словам кластера, возможен " +
      "межкластерный шум. Проверяйте интент перед тем, как писать новый материал.",
    "",
  ];

  writeFileSync(OUT_FILE, head.join("\n") + "\n" + sections.join("\n") + "\n");
  console.log(
    `demand-watch: кластеров=${clusters.length}, статей=${articles.length} → ` +
      `📈${totalGrow} 🔁${totalReform} 🆕${totalUncovered} 📉${totalDecline} → ${OUT_FILE}`,
  );
}

main();
