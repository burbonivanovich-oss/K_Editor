#!/usr/bin/env node
/**
 * Кандидаты для квартального отчёта «где поменялась нормативка».
 *
 * Скрипт не решает, изменилась ли норма — это знание, а не вычисление.
 * Он собирает фактуру, по которой решение принимает человек или
 * /npa-changes: какая статья на какие нормы ссылается, когда её последний
 * раз проверяли и не просрочен ли reviewDate.
 *
 * Нужен потому, что /maintain-content выводит единый план в чат: статьи
 * с реально изменившейся нормой перемешаны там с упавшим SEO-баллом и
 * устаревшими ссылками, а постоянного артефакта, который можно отдать
 * юристу или редактору, не остаётся.
 *
 * Запуск:
 *   node scripts/npa-change-candidates.mjs
 *   node scripts/npa-change-candidates.mjs --json
 *   node scripts/npa-change-candidates.mjs --since 2026-04-01
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Переопределяется в тестах: гонять аудит по живому корпусу значит
// зависеть от того, что редакция выпустила на этой неделе.
const ROOT = process.env.NPA_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const BLOG_DIR = join(ROOT, "src", "content", "blog");
const SOURCES = join(ROOT, "src", "data", "factcheck", "sources.json");
const MARKERS = join(ROOT, ".claude", "factchecked");

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
};
const AS_JSON = process.argv.includes("--json");
const SINCE = arg("since");

const FZ_RE = /(\d{1,3})[-\s]?ФЗ/g;
/* «постановлени\w*» не совпадало ни разу: \w в JS — это [A-Za-z0-9_], и
 * кириллическое окончание «-ем», «-я» в него не входит. Из-за этого ПП в
 * отчёте не появлялись вообще, хотя в статьях их три штуки (найдено
 * аудитом 12.08.2026). Берём проверенный вариант из audit-npa-references. */
const PP_RE = /(?:[Пп]остановлен[а-яё]+\s+[Пп]равительства(?:\s+РФ)?|ПП(?:\s+РФ)?)\s*(?:от\s+\d{1,2}[.\/]\d{1,2}[.\/]\d{4}\s+)?№\s*(\d{1,4})/giu;

const today = new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) =>
  Math.round((new Date(b) - new Date(a)) / 86400000);

const whitelist = existsSync(SOURCES)
  ? JSON.parse(readFileSync(SOURCES, "utf8")).npaWhitelist ?? {}
  : {};

if (!existsSync(BLOG_DIR)) {
  console.error(`Нет каталога ${BLOG_DIR}`);
  process.exit(1);
}

const files = readdirSync(BLOG_DIR).filter((f) => /\.mdx?$/.test(f));
const rows = [];

for (const file of files) {
  const raw = readFileSync(join(BLOG_DIR, file), "utf8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) continue;
  const fm = fmMatch[1];
  const body = raw.slice(fmMatch[0].length);
  const slug = file.replace(/\.(md|mdx)$/, "");

  if (/^draft:\s*true/m.test(fm)) continue;

  const pubDate = (fm.match(/^pubDate:\s*["']?([\d-]+)/m) ?? [])[1] ?? null;
  const reviewDate = (fm.match(/^reviewDate:\s*["']?([\d-]+)/m) ?? [])[1] ?? null;
  const category = (fm.match(/categories:\s*\[?\s*["']?([\w-]+)/m) ?? [])[1] ?? null;

  const norms = new Set();
  for (const m of body.matchAll(FZ_RE)) norms.add(`ФЗ-${m[1]}`);
  for (const m of body.matchAll(PP_RE)) norms.add(`ПП-${m[1]}`);
  if (!norms.size) continue;

  // Маркер фактчека — единственный след того, что нормы вообще сверяли.
  // Формат — JSON {date, hash}: hash считает scripts/factcheck/write-marker.mjs
  // от содержимого статьи на момент проверки. Несовпадение с текущим
  // содержимым — статью правили после факчека, маркер больше не действует.
  const marker = join(MARKERS, slug);
  let checkedAt = null;
  let staleHash = false;
  if (existsSync(marker)) {
    let markerData = null;
    try {
      markerData = JSON.parse(readFileSync(marker, "utf8"));
    } catch {
      /* повреждённый или до-хешевый маркер — ниже как «не проводился» */
    }
    if (markerData?.date) {
      checkedAt = markerData.date;
      if (markerData.hash) {
        const currentHash = createHash("sha256").update(raw).digest("hex");
        staleHash = markerData.hash !== currentHash;
      }
    }
  }

  const flags = [];
  if (!checkedAt) flags.push("фактчек не проводился");
  else if (staleHash) flags.push("статья изменена после факчека");
  else if (daysBetween(checkedAt, today) > 180) flags.push(`фактчек ${daysBetween(checkedAt, today)} дн. назад`);
  if (reviewDate && reviewDate < today) flags.push(`reviewDate просрочен (${reviewDate})`);
  if (!reviewDate) flags.push("нет reviewDate");

  if (SINCE && checkedAt && checkedAt >= SINCE) continue;

  rows.push({
    slug,
    category,
    pubDate,
    reviewDate,
    checkedAt,
    norms: [...norms].sort(),
    // Тема нормы из whitelist помогает заметить, что статья ссылается
    // на норму из чужой области — тот же сигнал, что в audit-npa.
    normTopics: [...norms].map((n) => {
      const [type, num] = n.split("-");
      const key = type === "ФЗ" ? "fz" : "pp";
      return whitelist[key]?.[num]?.topic ?? null;
    }).filter(Boolean),
    flags,
  });
}

// Сначала то, что дольше всех не проверяли: там вероятнее всего и
// разъехалась нормативка.
rows.sort((a, b) => (a.checkedAt ?? "0000").localeCompare(b.checkedAt ?? "0000"));

if (AS_JSON) {
  console.log(JSON.stringify({ generatedAt: today, count: rows.length, rows }, null, 2));
} else {
  console.log(`Статей со ссылками на НПА: ${rows.length}`);
  console.log("─".repeat(70));
  for (const r of rows) {
    console.log(`${r.slug}  [${r.category ?? "—"}]`);
    console.log(`  нормы:   ${r.norms.join(", ")}`);
    console.log(`  фактчек: ${r.checkedAt ?? "нет маркера"}`);
    if (r.flags.length) console.log(`  ⚠ ${r.flags.join("; ")}`);
  }
  console.log("─".repeat(70));
  console.log("Дальше — /npa-changes: сверить нормы с первоисточниками и");
  console.log("отобрать те, где норма действительно изменилась.");
}
