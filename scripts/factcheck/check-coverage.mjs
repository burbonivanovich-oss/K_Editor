#!/usr/bin/env node
/**
 * Сверка: каждое проверяемое значение из статьи есть в отчёте факчека.
 *
 * `check-report.mjs` требует доказательства по тем утверждениям, которые
 * в отчёт попали. Он бессилен против другого: утверждение в статье есть,
 * а в отчёте его нет — проверять нечего, и отчёт честно зелёный.
 *
 * Ровно так 13.08.2026 прошла ст. 15.12.1 КоАП РФ: редактор указала, что
 * норму следовало разобрать, а в отчёте её не было вовсе. Пропуск не
 * виден ни по одному признаку: 38 утверждений, все с источниками, все
 * подтверждены. Отсутствующее не оставляет следа.
 *
 * Здесь из текста статьи вытаскиваются значения, ошибка в которых имеет
 * последствия — суммы, сроки, ссылки на нормы, номера тегов и кодов, —
 * и сверяются с тем, что разбирал факчек.
 *
 * ЧТО НЕ СЧИТАЕТСЯ ЗНАЧЕНИЕМ, и почему это важнее списка того, что
 * считается. Проверка, которая ругается на номера пунктов и цифры внутри
 * ссылок, будет отключена в первую неделю — и тогда она не сработает и в
 * настоящий раз. Поэтому из текста заранее вырезаны:
 *
 *   • frontmatter — там даты публикации, а не утверждения о мире;
 *   • адреса ссылок — `/blog/2026-08-09-...-do-01-10-2026/` состоит из
 *     цифр целиком, и ни одна не является утверждением этой статьи;
 *   • подписи внутренних ссылок — это заголовки наших же статей, факты
 *     в них проверены там;
 *   • маркеры `[Промоблок: 8526]` и `[Врезка: …]` — служебные
 *     идентификаторы;
 *   • нумерация списков и заголовков;
 *   • годы без числа и месяца («в 2026 году») — слишком общо, чтобы
 *     требовать отдельной проверки.
 *
 * Запуск:
 *   node scripts/factcheck/check-coverage.mjs <slug>
 *   node scripts/factcheck/check-coverage.mjs <slug> --json
 *   node scripts/factcheck/check-coverage.mjs --all
 *
 * Коды: 0 — всё разобрано, 1 — есть непокрытое, 2 — нет статьи/отчёта.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.FACTCHECK_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLOG = join(ROOT, 'src/content/blog');
const RESULTS = join(ROOT, 'src/data/factcheck/results');

/** Текст без того, что значениями не является. */
export function strip(raw) {
  let t = raw.replace(/^---\n[\s\S]*?\n---/, '');            // frontmatter
  t = t.replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, (m, anchor) =>  // ссылки
    (/^https?:/.test(m.slice(m.indexOf('(') + 1)) ? ' ' : ' '));
  t = t.replace(/\[(Промоблок|Врезка)[^\]]*\]/gi, ' ');       // служебные маркеры
  t = t.replace(/^\s*\d+[.)]\s+/gm, ' ');                     // нумерация списков
  t = t.replace(/^#{1,6}\s+/gm, ' ');                         // заголовки
  t = t.replace(/`[^`]*`/g, ' ');                             // код
  return t;
}

/* Что вытаскиваем. Каждый шаблон — про класс, где неверная цифра меняет
 * решение читателя: сколько заплатит, по какой норме, до какого числа,
 * какой тег настраивать. */
const PATTERNS = [
  { kind: 'money', re: /\d[\d\s]*(?:\s?[₽]|\s+(?:руб(?:лей|ля|\.)?|тыс(?:яч)?|млн))/gi },
  { kind: 'npa', re: /(?:ст(?:атья|\.)\s*\d+(?:\.\d+)?|ч(?:асть|\.)\s*\d+\s+ст\.?\s*\d+(?:\.\d+)?)/gi },
  { kind: 'npa', re: /№\s*\d{2,}|\b\d{2,3}-ФЗ\b/gi },
  { kind: 'date', re: /\b\d{1,2}\.\d{2}\.\d{4}\b/g },
  { kind: 'date', re: /\b\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\p{L}*\s+\d{4}/giu },
  { kind: 'tech', re: /(?:тег|реквизит|код(?:а|ы)?)\s*№?\s*\d{3,}/gi },
  { kind: 'tech', re: /\bФФД\s*\d\.\d\b/gi },
  { kind: 'percent', re: /\b\d+(?:[.,]\d+)?\s*%/g },
];

/**
 * Значимые числовые «ядра» строки.
 *
 * Сравнивать значение целиком нельзя: «28 декабря 2025» в статье и «28
 * декабря 2025 года» в отчёте дают разные строки, а «ч. 2 ст. 14.5» и
 * «ст. 14.5 КоАП» — разные наборы цифр подряд. Первая версия сверки
 * именно из-за этого объявила непокрытыми два утверждения, которые в
 * отчёте были: ложная тревога здесь опаснее пропуска, её быстро
 * научатся игнорировать.
 *
 * Поэтому из строки берутся отдельные числа, склейки пробелов внутри
 * числа схлопываются («10 000» → «10000»), а односимвольные отбрасываются:
 * «2» из «ч. 2» совпало бы с чем угодно.
 */
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[йя]', 'июн', 'июл',
  'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

/**
 * «1 октября 2026» и «01.10.2026» — одна дата и должны давать один ключ.
 * Без этого статья, где дата написана словами, а отчёт — цифрами, вечно
 * числится непроверенной, и сверку выключают.
 */
export function normalizeDates(text) {
  let out = String(text ?? '');
  MONTHS.forEach((m, i) => {
    const re = new RegExp(`(\\d{1,2})\\s+${m}\\p{L}*\\s+(\\d{4})`, 'giu');
    out = out.replace(re, (_, d, y) => `${String(d).padStart(2, '0')}.${String(i + 1).padStart(2, '0')}.${y}`);
  });
  return out;
}

/**
 * Значимые числовые «ядра» строки.
 *
 * Сравнивать значение целиком нельзя: «ч. 2 ст. 14.5» и «ст. 14.5 КоАП» —
 * разные наборы цифр подряд. Первая версия сверки именно из-за этого
 * объявила непокрытыми два утверждения, которые в отчёте были: ложная
 * тревога здесь опаснее пропуска, её быстро научатся игнорировать.
 *
 * Разбор чисел намеренно узкий, а не «цифры с пробелами подряд». Широкий
 * шаблон склеивал соседние числа в отчёте в один ключ —
 * «28.12.2025 28.12.2025» превращалось в `2812202528122025`, и настоящая
 * дата переставала находиться. Поэтому три формы, в порядке проверки:
 * разряды тысяч («2 250 000»), дробное и точечное («14.5», «28.12.2025»),
 * и обычное число.
 */
export function significantKeys(text) {
  const runs = normalizeDates(text).match(/\d{1,3}(?:[\s\u00A0]\d{3})+|\d+(?:[.,]\d+)+|\d+/g) || [];
  return new Set(
    runs
      .map((r) => r.replace(/[\s\u00A0.,]/g, ''))
      .filter((r) => r.length >= 2),
  );
}

export function extractValues(body) {
  const found = new Map();
  for (const { kind, re } of PATTERNS) {
    for (const m of body.matchAll(re)) {
      const text = m[0].trim().replace(/\s+/g, ' ');
      const keys = significantKeys(text);
      if (!keys.size) continue;
      const id = [...keys].join('-');
      if (!found.has(id)) found.set(id, { kind, text, keys });
    }
  }
  return [...found.values()];
}

/** Всё, что факчек вообще разбирал, одной строкой для поиска. */
export function claimsHaystack(report) {
  return (report.claims || [])
    .map((c) => [c.raw, c.statement, c.expectedValue, c.quote].filter(Boolean).join(' '))
    .join('  ');
}

/** Текст без пробелов и пунктуации — для точного сравнения коротких ссылок. */
const squash = (s) => String(s ?? '').toLowerCase().replace(/[\s\u00A0.,№()«»"'-]/g, '');

export function checkCoverage(articleRaw, report) {
  const values = extractValues(strip(articleRaw));
  const hay = claimsHaystack(report);
  const hayKeys = significantKeys(hay);
  const haySquashed = squash(normalizeDates(hay));

  /* Значение разобрано, если хотя бы одно его числовое ядро встречается
   * среди того, что рассматривал факчек. Требовать совпадения всех ядер
   * — значит считать «ч. 2 ст. 14.5» и «ст. 14.5 КоАП» разными вещами.
   *
   * Короткие ядра двусмысленны только у ссылок на нормы: «ст. 1.2» даёт
   * ключ «12», который найдётся в любом отчёте, где есть хоть одна дата.
   * Для них сверяем ещё и сам текст ссылки.
   *
   * Для сумм, дат и процентов такой строгости быть не должно: «25%» из
   * статьи и «25–50%» в отчёте — одно и то же, а точное сравнение
   * текстов объявило их разными. Ложная тревога на верной работе стоит
   * дороже пропуска: сверку с ней выключат целиком. */
  const missing = values.filter((v) => {
    const keys = [...v.keys];
    if (keys.some((k) => hayKeys.has(k) && (k.length >= 3 || v.kind !== 'npa'))) return false;
    if (v.kind !== 'npa') return true;
    return !haySquashed.includes(squash(v.text));
  });
  return { total: values.length, covered: values.length - missing.length, missing };
}

function readArticle(slug) {
  for (const ext of ['.md', '.mdx']) {
    const p = join(BLOG, slug + ext);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const slugs = args.includes('--all')
    ? (existsSync(BLOG) ? readdirSync(BLOG).filter((f) => /\.mdx?$/.test(f)).map((f) => f.replace(/\.mdx?$/, '')) : [])
    : [args.find((a) => !a.startsWith('--'))].filter(Boolean);

  if (!slugs.length) {
    console.error('Использование: check-coverage.mjs <slug> [--json] | --all');
    process.exit(2);
  }

  let bad = 0;
  const all = [];
  for (const slug of slugs) {
    const raw = readArticle(slug);
    if (!raw) { console.error(`✖ Нет статьи ${slug}`); bad++; continue; }
    const rp = join(RESULTS, `${slug}.json`);
    if (!existsSync(rp)) { console.error(`✖ ${slug}: нет отчёта факчека`); bad++; continue; }

    let report;
    try { report = JSON.parse(readFileSync(rp, 'utf8')); } catch (e) {
      console.error(`✖ ${slug}: отчёт нечитаем — ${e.message}`); bad++; continue;
    }

    const r = checkCoverage(raw, report);
    all.push({ slug, ...r });
    if (args.includes('--json')) continue;

    if (!r.missing.length) {
      console.log(`✓ ${slug} — все ${r.total} значений разобраны`);
      continue;
    }
    bad++;
    console.log(`✖ ${slug} — ${r.missing.length} из ${r.total} значений не разбирались факчеком:`);
    for (const m of r.missing) console.log(`    [${m.kind}] ${m.text}`);
  }

  if (args.includes('--json')) console.log(JSON.stringify(all, null, 2));
  process.exit(bad ? 1 : 0);
}
