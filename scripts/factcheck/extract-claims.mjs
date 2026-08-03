#!/usr/bin/env node
// Извлекает claims из статьи блога: даты, суммы, ссылки на НПА, перечни.
// Эти claims дальше проверяются вручную или через скилл /factcheck.
//
// Использование:
//   node scripts/factcheck/extract-claims.mjs <slug>           # одна статья
//   node scripts/factcheck/extract-claims.mjs --all            # инвентаризация всех
//
// Вывод:
//   src/data/factcheck/claims/<slug>.json   — claims одной статьи
//   src/data/factcheck/inventory.json       — сводка по всем (с --all)

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BLOG_DIR = join(ROOT, "src", "content", "blog");
const OUT_DIR = join(ROOT, "src", "data", "factcheck");
const CLAIMS_DIR = join(OUT_DIR, "claims");

const MONTHS_RU = [
  "январ", "феврал", "март", "апрел", "ма", "июн",
  "июл", "август", "сентябр", "октябр", "ноябр", "декабр",
];

// Числа словами: единицы, десятки, сотни. Покрывают «пятнадцать тысяч»,
// «триста тысяч», «один миллион».
const NUMBER_WORDS = [
  "ноль", "один", "одна", "два", "две", "три", "четыре", "пять", "шесть",
  "семь", "восемь", "девять", "десять", "одиннадцать", "двенадцать",
  "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать",
  "семнадцать", "восемнадцать", "девятнадцать", "двадцать", "тридцать",
  "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят",
  "девяносто", "сто", "двести", "триста", "четыреста", "пятьсот",
  "шестьсот", "семьсот", "восемьсот", "девятьсот",
].join("|");

// Регулярки. Все возвращают группы для контекста.
// Примечание: \b с флагом u не работает с кириллицей (Cyrillic не считается
// word-char в Unicode mode). Для русских паттернов используем (?<!\d) / (?!\d)
// и явные ASCII-границы вместо \b.
const PATTERNS = {
  DATE_DMY: /(?<!\d)(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})(?!\d)/g,
  DATE_TEXT: new RegExp(
    `(?<!\\d)(\\d{1,2})\\s+(?:${MONTHS_RU.join("|")})[а-я]*\\s+(\\d{4})(?:\\s*год[а-я]*)?`,
    "giu",
  ),
  DATE_YEAR: /(?<!\d)(20\d{2})\s+год[а-я]*/giu,
  DATE_RANGE: /(?<!\d)(20\d{2})[–—\-](20\d{2})(?!\d)/g,
  // Контекстные даты без конкретного года: «с начала года»,
  // «в I квартале», «в текущем году». Сигнал устаревания —
  // факт-чек должен заменить на конкретную дату.
  DATE_CONTEXT: /(?:с\s+начала\s+(?:года|квартала|месяца)|в\s+(?:текущ[а-я]+|прошл[а-я]+|следующ[а-я]+)\s+(?:году|квартале|месяце)|в\s+[IVX]+\s+квартале(?:\s+\d{4})?|в\s+(?:первом|втором|третьем|четвёртом)\s+квартале(?:\s+\d{4})?)/giu,
  MONEY_WORDS: new RegExp(
    `(?:${NUMBER_WORDS})(?:\\s+(?:${NUMBER_WORDS})){0,2}\\s+(?:тысяч[а-я]*|миллион[а-я]*|миллиард[а-я]*)(?:\\s*руб[а-я]*)?`,
    "giu",
  ),
  MONEY: /(\d{1,3}(?:[\s ]\d{3})+|\d+)\s*(?:₽|руб[а-я]*|тыс\.?(?:\s*руб)?|млн\.?(?:\s*руб)?)/giu,
  NPA_KOAP: /ст(?:атья|\.)?\s*(\d+(?:\.\d+)?)(?:\s*ч(?:асть|\.)\s*\d+)?\s*КоАП/giu,
  NPA_UK: /ст(?:атья|\.)?\s*(\d+(?:\.\d+)?)(?:\s*ч(?:асть|\.)\s*\d+)?\s*УК\s+РФ/giu,
  NPA_NK: /ст(?:атья|\.)?\s*(\d+(?:\.\d+)?)(?:\s*п(?:ункт|\.)\s*\d+)?\s*НК\s+РФ/giu,
  // Пункты без ст.: «п. 4», «пп. 2 ч. 1», «пункт 5». Часто
  // встречается фраза «согласно п. 4 закона» без явной статьи —
  // это claim, требующий доуточнения через factcheck.
  NPA_PUNKT: /(?<![а-яА-Я])(?:пп?\.?|пункт[а-я]*)\s+(\d+(?:\.\d+)?)(?:\s*ч(?:асть|\.)\s*\d+)?(?![а-яА-Я])/giu,
  NPA_FZ: /(\d{1,4})[\-‑]ФЗ/g,
  NPA_FZ_FULL: /Федеральн[ыо][емг][ао]?\s+закон[а-я]*\s+(?:от\s+[\d.]+\s+)?№?\s*(\d{1,4})/giu,
  NPA_PP_NUMBERED: /(?:[Пп]остановлен[а-я]+\s+[Пп]равительства(?:\s+РФ)?|ПП(?:\s+РФ)?)\s*(?:от\s+(\d{1,2}[.\/]\d{1,2}[.\/]\d{4})\s+)?№\s*(\d{1,4})(?:\s+от\s+(\d{1,2}[.\/]\d{1,2}[.\/]\d{4}))?/giu,
  NPA_PRIKAZ: /[Пп]риказ[а-я]*\s+(?:Минфина|ФНС|Минпромторга|Роспотребнадзора|Минцифры|Минтруда|ЦБ\s+РФ|Минсельхоза)[а-я\s]*(?:№|N)\s*([\w\-\/]+)/giu,
  PERCENT: /(\d{1,3}(?:[.,]\d+)?)\s*%/g,
  LINK: /https?:\/\/(?:www\.)?([a-z0-9.\-]+)(?:\/[^\s)\]]*)?/gi,
};

const SOURCE_MAP = {
  "consultant.ru": "consultant.ru",
  "pravo.gov.ru": "pravo.gov.ru",
  "garant.ru": "garant.ru",
  "nalog.gov.ru": "nalog.gov.ru",
  "честныйзнак.рф": "честныйзнак.рф",
  "xn--80ajghhoc2aj1c8b.xn--p1ai": "честныйзнак.рф",
  "crpt.ru": "crpt.ru",
  "fsrar.gov.ru": "fsrar.gov.ru",
  "minfin.gov.ru": "minfin.gov.ru",
  "sfr.gov.ru": "sfr.gov.ru",
  "vetrf.ru": "vetrf.ru",
};

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  return m ? { fm: m[1], body: md.slice(m[0].length) } : { fm: "", body: md };
}

function ctx(body, idx, len) {
  const start = Math.max(0, idx - 80);
  const end = Math.min(body.length, idx + len + 80);
  return body
    .slice(start, end)
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lineFor(body, idx) {
  return body.slice(0, idx).split("\n").length;
}

function extractClaims(slug, md) {
  const { body } = parseFrontmatter(md);
  const claims = [];
  let id = 0;

  for (const [type, re] of Object.entries(PATTERNS)) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body))) {
      const raw = m[0];
      // Дедуп: тот же raw в том же окне — пропускаем
      if (
        claims.some(
          (c) =>
            c.type === type && c.raw === raw && Math.abs(c.offset - m.index) < 5,
        )
      ) {
        continue;
      }
      claims.push({
        id: `c${++id}`,
        type,
        raw,
        groups: m.slice(1).filter((g) => g != null),
        offset: m.index,
        line: lineFor(body, m.index),
        context: ctx(body, m.index, raw.length),
      });
    }
  }

  for (const c of claims) {
    if (c.type === "LINK") {
      const host = c.groups[0] || "";
      c.expected_source = SOURCE_MAP[host] || host;
    }
  }

  claims.sort((a, b) => a.offset - b.offset);
  return { slug, claims };
}

function processOne(slug) {
  let file = join(BLOG_DIR, `${slug}.md`);
  if (!existsSync(file)) {
    const mdx = join(BLOG_DIR, `${slug}.mdx`);
    if (existsSync(mdx)) file = mdx;
    else throw new Error(`не найден: ${file}`);
  }
  const md = readFileSync(file, "utf8");
  const result = extractClaims(slug, md);
  if (!existsSync(CLAIMS_DIR)) mkdirSync(CLAIMS_DIR, { recursive: true });
  const out = join(CLAIMS_DIR, `${slug}.json`);
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  return { slug, count: result.claims.length, file: out };
}

function processAll() {
  const files = readdirSync(BLOG_DIR).filter((f) => f.endsWith(".md"));
  const inventory = [];
  let totalClaims = 0;
  const byType = {};
  for (const f of files) {
    const slug = f.replace(/\.md$/, "");
    const r = processOne(slug);
    inventory.push({ slug, claims: r.count });
    totalClaims += r.count;
    const data = JSON.parse(readFileSync(r.file, "utf8"));
    for (const c of data.claims) {
      byType[c.type] = (byType[c.type] || 0) + 1;
    }
  }
  inventory.sort((a, b) => b.claims - a.claims);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, "inventory.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        articles: files.length,
        totalClaims,
        byType,
        topArticles: inventory.slice(0, 30),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`inventory: ${files.length} статей, ${totalClaims} claims`);
  console.log("по типам:");
  Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => console.log(`  ${t.padEnd(12)} ${n}`));
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: extract-claims.mjs <slug> | --all");
  process.exit(1);
}
if (arg === "--all") {
  processAll();
} else {
  const r = processOne(arg.replace(/\.md$/, ""));
  console.log(`extracted ${r.count} claims → ${r.file}`);
}
