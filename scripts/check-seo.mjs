/**
 * Статическая SEO-проверка статьи блога.
 * Использование:
 *   node scripts/check-seo.mjs <файл.md>           # файл
 *   git show ":src/..." | node scripts/check-seo.mjs  # stdin (для git hook)
 * Флаги:
 *   --label=<имя>   имя файла для вывода (при чтении из stdin)
 *   --p1            показывать P1-предупреждения (по умолчанию только P0)
 * Выход: 0 = OK, 1 = есть P0-ошибки.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args  = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);
const SHOW_P1 = flags.p1 === true;

// Чтение контента
let content, label;
if (args[0]) {
  const abs = path.resolve(args[0]);
  content = fs.readFileSync(abs, 'utf8');
  label   = args[0];
} else {
  // stdin
  content = fs.readFileSync('/dev/stdin', 'utf8');
  label   = flags.label ?? '<stdin>';
}

// Парсинг frontmatter
function parseFrontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: src };
  const raw  = m[1];
  const body = m[2];
  const fm   = {};

  // title, description, pubDate, draft
  for (const line of raw.split('\n')) {
    const kv = line.match(/^(\w+):\s*"?([^"#\n]*)"?\s*$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }

  // categories list
  const catMatch = raw.match(/categories:\s*\n((?:\s+-\s+\S+\n?)+)/);
  fm._categories = catMatch
    ? catMatch[1].match(/\S+(?=\n|$)/g)?.filter(s => s !== '-') ?? []
    : [];

  // tags list
  const tagMatch = raw.match(/tags:\s*\n((?:\s+-\s+[^\n]+\n?)+)/);
  fm._tags = tagMatch
    ? tagMatch[1].match(/(?<=-\s)(.+)/g)?.map(s => s.trim()) ?? []
    : [];

  // seo.keywords list
  const kwBlock = raw.match(/seo:\s*\n((?:\s+\S[^\n]*\n?)+)/);
  if (kwBlock) {
    const kwMatch = kwBlock[1].match(/keywords:\s*\n((?:\s+-\s+[^\n]+\n?)+)/);
    fm._keywords = kwMatch
      ? kwMatch[1].match(/(?<=-\s)(.+)/g)?.map(s => s.trim()) ?? []
      : [];
  } else {
    fm._keywords = [];
  }

  return { fm, body };
}

const { fm, body } = parseFrontmatter(content);

const p0 = [];
const p1 = [];

// ── P0 — блокирующие ─────────────────────────────────────────────────────────

if (!fm.title) {
  p0.push('Нет поля title во frontmatter');
} else {
  if (fm.title.length > 75)
    p0.push(`title слишком длинный: ${fm.title.length} симв. (макс. 75) — обрежется в Яндексе и Google`);
  else if (fm.title.length > 65)
    p1.push(`title ${fm.title.length} симв. — может обрезаться в Google (рекомендовано ≤ 65)`);
}

if (!fm.description) {
  p0.push('Нет поля description во frontmatter');
} else {
  if (fm.description.length > 165)
    p0.push(`description слишком длинный: ${fm.description.length} симв. (макс. 165) — обрежется в SERP`);
  if (fm.description.length < 100)
    p0.push(`description слишком короткий: ${fm.description.length} симв. (мин. 100)`);
}

if (fm._categories.length === 0)
  p0.push('Не указана категория (categories)');

if (fm._tags.length < 2)
  p0.push(`Мало тегов: ${fm._tags.length} (нужно минимум 2)`);

if (fm._keywords.length === 0)
  p0.push('Нет seo.keywords во frontmatter');

// Внутренние ссылки
const internalLinks = (body.match(/\(\/(?:blog|category|tag|slovar|kalkulyator)[^\)]+\)/g) ?? []);
if (internalLinks.length === 0)
  p0.push('Нет ни одной внутренней ссылки (/blog/, /category/, …)');

// ── P1 — предупреждения ───────────────────────────────────────────────────────

if (fm.description && fm.description.length < 140)
  p1.push(`description короткий: ${fm.description.length} симв. (рекомендовано 140–165)`);

if (internalLinks.length > 0 && internalLinks.length < 3)
  p1.push(`Мало внутренних ссылок: ${internalLinks.length} (рекомендовано 3+)`);

const h2count = (body.match(/^## /gm) ?? []).length;
if (h2count < 3)
  p1.push(`Мало H2-заголовков: ${h2count} (рекомендовано 5–7)`);

if (!/^#{2,3}\s.*(?:FAQ|вопрос|частые)/im.test(body))
  p1.push('Нет FAQ-блока (H2/H3 с «FAQ» или «вопрос»)');

if (fm._keywords.length > 0 && fm.title) {
  const key = fm._keywords[0].toLowerCase();
  if (!fm.title.toLowerCase().includes(key))
    p1.push(`Целевой ключ «${fm._keywords[0]}» не найден в title`);
}

// ── Вывод ─────────────────────────────────────────────────────────────────────

const hasP0 = p0.length > 0;
const hasP1 = p1.length > 0;

if (!hasP0 && (!SHOW_P1 || !hasP1)) {
  console.log(`SEO OK: ${label}`);
  process.exit(0);
}

console.log(`\nSEO-проверка: ${label}`);
console.log('─'.repeat(60));

if (hasP0) {
  console.log(`\nP0 — блокирующие (${p0.length}):`);
  for (const e of p0) console.log(`  ✗ ${e}`);
}

if (SHOW_P1 && hasP1) {
  console.log(`\nP1 — предупреждения (${p1.length}):`);
  for (const w of p1) console.log(`  ⚠ ${w}`);
}

console.log('');
process.exit(hasP0 ? 1 : 0);
