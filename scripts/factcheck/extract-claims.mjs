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
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.FACTCHECK_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
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

/**
 * Устойчивый идентификатор утверждения.
 *
 * H-01. Раньше id раздавался счётчиком в порядке обхода шаблонов:
 * `c1`, `c2`, … Такой id — не имя утверждения, а его место в очереди, и
 * он менялся от любой правки статьи: дописали абзац сверху — вся
 * нумерация уехала. Пока ссылок на реестр не было, это никого не
 * трогало; со ссылками (`claimId`) это означает, что каждое повторное
 * извлечение разом делает все ссылки корпуса неверными. Проверено:
 * первый же прогон `--all` после перехода на ссылки дал 107 утверждений,
 * указывающих на чужое место.
 *
 * Поэтому id считается из содержания: тип, нормализованный текст и номер
 * повторения этого текста в статье. Правка соседнего абзаца id не
 * трогает; исчезновение самого утверждения — трогает, и это правильно,
 * потому что утверждения больше нет.
 *
 * @param {string} prefix — «c» для regex-прохода, «s» для смыслового.
 */
function stableId(prefix, type, raw, occurrence) {
  const norm = String(raw ?? "").replace(/[\s\u00A0\u202F]+/g, " ").trim().toLowerCase();
  const h = createHash("sha1").update(`${type}|${norm}|${occurrence}`).digest("hex");
  return `${prefix}${h.slice(0, 8)}`;
}

/** Сколько раз такой же (тип, текст) уже встречался — номер повторения. */
function occurrenceCounter() {
  const seen = new Map();
  return (type, raw) => {
    const key = `${type}|${String(raw ?? "").replace(/[\s\u00A0\u202F]+/g, " ").trim().toLowerCase()}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n;
  };
}

function extractClaims(slug, md) {
  const { body } = parseFrontmatter(md);
  const claims = [];

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
        id: null,               // проставляется ниже, после сортировки по позиции
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
  /* id раздаётся после сортировки: номер повторения считается в порядке
   * появления в тексте, а не в порядке обхода шаблонов. Иначе он зависел
   * бы от того, в каком порядке перечислены PATTERNS. */
  const nth = occurrenceCounter();
  for (const c of claims) c.id = stableId("c", c.type, c.raw, nth(c.type, c.raw));
  return { slug, claims };
}

/**
 * H-03. Утверждения смыслового прохода, уже лежащие в файле.
 *
 * Смысловой проход — единственный способ увидеть то, чего regex не
 * видит: «единого справочника кодов нет», «продажа запрещена». Их
 * добавляет `merge`, и до этой правки любой следующий прогон
 * `extract-claims` их стирал: `processOne` перезаписывал файл целиком
 * результатом regex-прохода, а `--all` звал `processOne` для каждой
 * статьи. Сейчас в корпусе таких утверждений 21 в трёх файлах — один
 * прогон `--all` уничтожал их все, молча и без следа.
 */
function keptSemantic(out) {
  if (!existsSync(out)) return [];
  try {
    const prev = JSON.parse(readFileSync(out, "utf8"));
    return (prev.claims || []).filter((c) => c.foundBy === "semantic");
  } catch {
    /* Файл нечитаем — сохранять нечего, но и падать не за что: regex-проход
     * восстановит машинную часть, а про смысловую честно скажет «ноль». */
    return [];
  }
}

/**
 * Перенести смысловые утверждения на новые позиции в тексте.
 *
 * Позиция считается заново по цитате, а не переносится как есть: между
 * прогонами текст мог сдвинуться, и старый offset указывал бы в другое
 * место. Цитата, которой в статье больше нет, не выбрасывается —
 * помечается `stale`: исчезнувшее утверждение это событие, о котором
 * нужно знать, а не отсутствие события.
 */
function rehomeSemantic(semantic, body, regexClaims) {
  const carried = [];
  const stale = [];
  for (const c of semantic) {
    const raw = String(c.raw || "").trim();
    const offset = raw ? body.indexOf(raw) : -1;
    if (offset === -1) {
      stale.push({ ...c, stale: true, staleNote: "цитаты больше нет в тексте статьи" });
      continue;
    }
    // Regex мог дорасти до этого места — тогда утверждение уже покрыто.
    const dup = regexClaims.some(
      (r) => r.raw === raw || (Math.abs(r.offset - offset) < 5 && String(r.raw).includes(raw)),
    );
    if (dup) continue;
    carried.push({
      ...c,
      offset,
      line: lineFor(body, offset),
      context: ctx(body, offset, raw.length),
    });
  }
  return { carried, stale };
}

function processOne(slug, { force = false } = {}) {
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

  const { body } = parseFrontmatter(md);
  const { carried, stale } = rehomeSemantic(keptSemantic(out), body, result.claims);
  const keep = force ? carried : [...carried, ...stale];
  result.claims = [...result.claims, ...keep].sort((a, b) => a.offset - b.offset);

  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  return { slug, count: result.claims.length, file: out, carried: carried.length, stale };
}

/**
 * Влить утверждения, найденные смысловым проходом.
 *
 * Формат входного файла — массив объектов { raw, why } или { raw, type }:
 * `raw` — точная цитата из текста статьи, `why` — зачем это проверять.
 * Всё остальное (offset, line, context) скрипт считает сам по тексту:
 * позицию нельзя доверять пересказу, иначе контекст уедет.
 *
 * Цитата, которой в статье нет, — не утверждение, а пересказ. Такие
 * отбрасываются с явным сообщением: молча принять пересказ значит
 * проверять то, чего в тексте не написано.
 */
function mergeClaims(slug, semanticFile) {
  const claimsPath = join(CLAIMS_DIR, `${slug}.json`);
  if (!existsSync(claimsPath)) {
    throw new Error(`сначала обычный проход: node scripts/factcheck/extract-claims.mjs ${slug}`);
  }
  const articlePath = [join(BLOG_DIR, `${slug}.md`), join(BLOG_DIR, `${slug}.mdx`)].find(existsSync);
  if (!articlePath) throw new Error(`не найдена статья ${slug}`);

  const { body } = parseFrontmatter(readFileSync(articlePath, "utf8"));
  const data = JSON.parse(readFileSync(claimsPath, "utf8"));
  const incoming = JSON.parse(readFileSync(semanticFile, "utf8"));
  if (!Array.isArray(incoming)) throw new Error("ожидается массив утверждений");

  /* Номер повторения для смысловых утверждений считается по уже
   * лежащим в файле — иначе два merge одной цитаты дали бы один id. */
  const semanticNth = (type, raw) => data.claims.filter(
    (c) => c.foundBy === "semantic" && c.type === type
      && String(c.raw).trim().toLowerCase() === String(raw).trim().toLowerCase(),
  ).length;
  const added = [];
  const notFound = [];

  for (const item of incoming) {
    const raw = (item.raw || "").trim();
    if (!raw) continue;
    const offset = body.indexOf(raw);
    if (offset === -1) { notFound.push(raw); continue; }
    // Уже нашла регулярка — не задваиваем.
    if (data.claims.some((c) => c.raw === raw || (Math.abs(c.offset - offset) < 5 && c.raw.includes(raw)))) continue;
    const type = item.type || "SEMANTIC";
    const claim = {
      id: stableId("s", type, raw, semanticNth(type, raw)),
      type,
      raw,
      groups: [],
      offset,
      line: lineFor(body, offset),
      context: ctx(body, offset, raw.length),
      foundBy: "semantic",
      why: item.why || "",
    };
    data.claims.push(claim);
    added.push(claim);
  }

  data.claims.sort((a, b) => a.offset - b.offset);
  writeFileSync(claimsPath, JSON.stringify(data, null, 2) + "\n");
  return { added, notFound, total: data.claims.length, file: claimsPath };
}

function processAll({ force = false } = {}) {
  const files = readdirSync(BLOG_DIR).filter((f) => f.endsWith(".md"));
  const inventory = [];
  let totalClaims = 0;
  let carried = 0;
  const staleAll = [];
  const byType = {};
  for (const f of files) {
    const slug = f.replace(/\.md$/, "");
    const r = processOne(slug, { force });
    carried += r.carried;
    for (const c of r.stale) staleAll.push({ slug, raw: c.raw });
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
  if (carried) console.log(`смысловых утверждений перенесено: ${carried}`);
  return { staleAll };
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: extract-claims.mjs <slug> | --all | merge <slug> --file <json>");
  process.exit(1);
}
const FORCE = process.argv.includes("--force");

/* Исчезнувшая цитата — не мелочь и не повод молчать. Она означает одно
 * из двух: статью правили после смыслового прохода (тогда утверждение
 * нужно перепроверить) или в merge попал пересказ. Оба случая требуют
 * человека, поэтому прогон завершается ненулевым кодом. */
function reportStale(stale) {
  if (!stale.length) return;
  console.error(`\n✖ Смысловых утверждений без цитаты в тексте: ${stale.length}`);
  for (const c of stale) {
    console.error(`   • ${c.slug ? c.slug + ": " : ""}${String(c.raw).slice(0, 90)}`);
  }
  console.error(
    FORCE
      ? "  --force: помеченные stale утверждения удалены из файла."
      : "  Оставлены в файле с пометкой stale. Проверить и либо поправить цитату,\n" +
        "  либо удалить утверждение осознанно (--force удаляет их молча).",
  );
  process.exit(1);
}

if (arg === "--all") {
  const { staleAll } = processAll({ force: FORCE });
  reportStale(staleAll);
} else if (arg === "merge") {
  const slug = (process.argv[3] || "").replace(/\.md$/, "");
  const i = process.argv.indexOf("--file");
  const file = i === -1 ? null : process.argv[i + 1];
  if (!slug || !file) {
    console.error("usage: extract-claims.mjs merge <slug> --file <json со смысловыми утверждениями>");
    process.exit(1);
  }
  const r = mergeClaims(slug, file);
  console.log(`✅ добавлено смысловых утверждений: ${r.added.length}, всего ${r.total} → ${r.file}`);
  for (const c of r.added) console.log(`   + ${c.raw}${c.why ? ` — ${c.why}` : ""}`);
  if (r.notFound.length) {
    console.error(`\n✖ Не найдено в тексте статьи (${r.notFound.length}) — это пересказ, а не цитата:`);
    for (const raw of r.notFound) console.error(`   • ${raw}`);
    process.exit(1);
  }
} else {
  const slug = arg.replace(/\.md$/, "");
  const r = processOne(slug, { force: FORCE });
  console.log(
    `extracted ${r.count} claims → ${r.file}` +
    (r.carried ? ` (смысловых перенесено: ${r.carried})` : ""),
  );
  reportStale(r.stale.map((c) => ({ slug, raw: c.raw })));
}
