#!/usr/bin/env node
// Сравнивает последнюю discovery-выгрузку с предыдущей по тем же seeds.
// Генерит markdown-отчёт с категориями NEW/RISING/FALLING/DROPPED для
// каждого seed-а + общий блок «самые громкие изменения».
//
// Окружение:
//   RISE_THRESHOLD=2.0   — порог отношения count_now/count_prev для RISING
//   MIN_COUNT=10         — минимальный count, ниже него фразу не считаем
//                          сигналом (фильтр шума на длинном хвосте)
//
// Чтение: src/data/wordstat/discoveries/YYYY-MM-DD/*.json (две самые свежие даты)
// Запись: src/data/wordstat/discoveries/diffs/YYYY-MM-DD.md

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DISC_DIR = join(ROOT, "src", "data", "wordstat", "discoveries");
// WS_NS — namespace набора тем (kontur). Пусто = корень discoveries.
const WS_NS = process.env.WS_NS || "";
const BASE = WS_NS ? join(DISC_DIR, WS_NS) : DISC_DIR;
const DIFFS_DIR = join(BASE, "diffs");

const RISE_THRESHOLD = parseFloat(process.env.RISE_THRESHOLD || "2.0");
const MIN_COUNT = parseInt(process.env.MIN_COUNT || "10", 10);

function listSnapshotDirs() {
  return readdirSync(BASE)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .filter((n) => statSync(join(BASE, n)).isDirectory())
    .sort();
}

function loadSnapshot(date) {
  const dir = join(BASE, date);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const bySeed = new Map();
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
    bySeed.set(data.seed, {
      seed: data.seed,
      slug: data.slug,
      category: data.category,
      cluster: data.cluster,
      phrases: data.phrases || [],
    });
  }
  return bySeed;
}

function diffSeed(prev, curr) {
  const prevMap = new Map(prev.phrases.map((p) => [p.phrase, p.count]));
  const currMap = new Map(curr.phrases.map((p) => [p.phrase, p.count]));

  const NEW = [];
  const DROPPED = [];
  const RISING = [];
  const FALLING = [];

  for (const [phrase, count] of currMap) {
    if (count < MIN_COUNT) continue;
    if (!prevMap.has(phrase)) {
      NEW.push({ phrase, count });
    } else {
      const prevCount = prevMap.get(phrase);
      // Фраза была ниже порога шума, а теперь выше — это прорыв, самый
      // интересный случай для детектора трендов. Раньше он терялся:
      // в NEW не попадал (фраза есть в прошлом снапшоте), а здесь
      // отсекался порогом. Ровно рост с 5 до 500 и уходил в тишину.
      if (prevCount < MIN_COUNT) {
        if (prevCount <= 0) {
          NEW.push({ phrase, count });
        } else {
          RISING.push({
            phrase,
            prev: prevCount,
            now: count,
            ratio: count / prevCount,
            breakout: true,
          });
        }
        continue;
      }
      const ratio = count / prevCount;
      if (ratio >= RISE_THRESHOLD) {
        RISING.push({ phrase, prev: prevCount, now: count, ratio });
      } else if (ratio <= 1 / RISE_THRESHOLD) {
        FALLING.push({ phrase, prev: prevCount, now: count, ratio });
      }
    }
  }
  for (const [phrase, count] of prevMap) {
    if (count < MIN_COUNT) continue;
    if (!currMap.has(phrase)) {
      DROPPED.push({ phrase, prev: count });
    }
  }

  NEW.sort((a, b) => b.count - a.count);
  RISING.sort((a, b) => b.now - b.prev - (a.now - a.prev));
  FALLING.sort((a, b) => a.now - a.prev - (b.now - b.prev));
  DROPPED.sort((a, b) => b.prev - a.prev);

  return { NEW, RISING, FALLING, DROPPED };
}

function fmtNum(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function renderSection(title, items, formatter, limit = 10) {
  if (!items.length) return "";
  const shown = items.slice(0, limit);
  const more = items.length > limit ? ` _(+${items.length - limit} ещё)_` : "";
  return `**${title} (${items.length}):**${more}\n` + shown.map(formatter).join("\n") + "\n\n";
}

function renderReport(prevDate, currDate, perSeed) {
  const lines = [];
  lines.push(`# Wordstat discovery diff: ${currDate} vs ${prevDate}`);
  lines.push("");
  lines.push(
    `Изменения за неделю по ${perSeed.length} seed-ам. Пороги: RISING ≥ ×${RISE_THRESHOLD}, ` +
      `MIN_COUNT ≥ ${MIN_COUNT}. Шум ниже порога отфильтрован, ` +
      `⚡ — фраза пробила порог снизу.`,
  );
  lines.push("");

  // Топ-30 NEW фраз по всем seeds — главное обнаружение
  const allNew = [];
  for (const s of perSeed) {
    for (const n of s.diff.NEW) {
      allNew.push({ ...n, seed: s.seed, cluster: s.cluster });
    }
  }
  allNew.sort((a, b) => b.count - a.count);
  lines.push("## 🆕 Самые громкие новые запросы за неделю");
  lines.push("");
  lines.push("| Запрос | Частота | Seed | Кластер |");
  lines.push("|---|---:|---|---|");
  for (const n of allNew.slice(0, 30)) {
    lines.push(`| ${n.phrase} | ${fmtNum(n.count)} | ${n.seed} | ${n.cluster} |`);
  }
  lines.push("");

  // Топ-20 RISING — самые крупные приросты по абсолютной величине
  const allRising = [];
  for (const s of perSeed) {
    for (const r of s.diff.RISING) {
      allRising.push({ ...r, seed: s.seed, cluster: s.cluster });
    }
  }
  allRising.sort((a, b) => b.now - b.prev - (a.now - a.prev));
  if (allRising.length) {
    lines.push("## 📈 Самые крупные приросты");
    lines.push("");
    lines.push("| Запрос | Было | Стало | ×ratio | Seed |");
    lines.push("|---|---:|---:|---:|---|");
    for (const r of allRising.slice(0, 20)) {
      lines.push(
        `| ${r.phrase}${r.breakout ? " ⚡" : ""} | ${fmtNum(r.prev)} | ${fmtNum(r.now)} | ${r.ratio.toFixed(1)} | ${r.seed} |`,
      );
    }
    lines.push("");
  }

  // Подробно по seed-ам (только те, где есть изменения)
  lines.push("## По seed-ам");
  lines.push("");
  for (const s of perSeed) {
    const { NEW, RISING, FALLING, DROPPED } = s.diff;
    if (!NEW.length && !RISING.length && !FALLING.length && !DROPPED.length) continue;
    lines.push(`### ${s.seed} _(${s.cluster}, ${s.category})_`);
    lines.push("");
    lines.push(
      renderSection("NEW", NEW, (n) => `- ${n.phrase} — ${fmtNum(n.count)}`),
    );
    lines.push(
      renderSection(
        "RISING",
        RISING,
        (r) =>
          `- ${r.phrase} — ${fmtNum(r.prev)} → ${fmtNum(r.now)} (×${r.ratio.toFixed(1)})${r.breakout ? " — пробил порог шума" : ""}`,
      ),
    );
    lines.push(
      renderSection(
        "FALLING",
        FALLING,
        (r) =>
          `- ${r.phrase} — ${fmtNum(r.prev)} → ${fmtNum(r.now)} (×${r.ratio.toFixed(1)})`,
        5,
      ),
    );
    lines.push(
      renderSection(
        "DROPPED",
        DROPPED,
        (d) => `- ${d.phrase} — было ${fmtNum(d.prev)}`,
        5,
      ),
    );
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function main() {
  const dirs = listSnapshotDirs();
  if (dirs.length < 2) {
    console.log(
      `diff: нужно ≥2 снапшота, найдено ${dirs.length}. Дождитесь следующего ` +
        `weekly-прогона discover.mjs.`,
    );
    return;
  }
  const [, ...rest] = dirs.reverse();
  const currDate = dirs[0];
  const prevDate = rest[0];

  const prev = loadSnapshot(prevDate);
  const curr = loadSnapshot(currDate);

  const perSeed = [];
  for (const [seed, c] of curr) {
    const p = prev.get(seed);
    if (!p) {
      // Сид новый, ещё не было базы — пропускаем
      continue;
    }
    perSeed.push({
      seed,
      slug: c.slug,
      category: c.category,
      cluster: c.cluster,
      diff: diffSeed(p, c),
    });
  }

  // Сортируем по сумме изменений: где больше всего движения — выше
  perSeed.sort((a, b) => {
    const movA = a.diff.NEW.length + a.diff.RISING.length + a.diff.FALLING.length + a.diff.DROPPED.length;
    const movB = b.diff.NEW.length + b.diff.RISING.length + b.diff.FALLING.length + b.diff.DROPPED.length;
    return movB - movA;
  });

  const report = renderReport(prevDate, currDate, perSeed);
  if (!existsSync(DIFFS_DIR)) mkdirSync(DIFFS_DIR, { recursive: true });
  const outFile = join(DIFFS_DIR, `${currDate}.md`);
  writeFileSync(outFile, report);
  console.log(
    `diff: сравнили ${perSeed.length} seeds (${prevDate} → ${currDate}) → ${outFile}`,
  );
}

main();
