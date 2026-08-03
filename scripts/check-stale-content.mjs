/**
 * Проверяет статьи, которые не обновлялись более 6 месяцев.
 * Запуск: node scripts/check-stale-content.mjs
 * Опции:
 *   --months=N   порог в месяцах (по умолчанию 6)
 *   --json       вывод в JSON вместо таблицы
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = path.resolve(__dirname, '../src/content/blog');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const MONTHS = parseInt(args.months ?? '6', 10);
const AS_JSON = args.json === true;
const NOW = new Date();

function monthsAgo(n) {
  const d = new Date(NOW);
  d.setMonth(d.getMonth() - n);
  return d;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*"?([^"#\n]*)"?\s*$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

const threshold = monthsAgo(MONTHS);
const stale = [];
const ok = [];

for (const file of fs.readdirSync(BLOG_DIR).filter(f => f.endsWith('.md'))) {
  const content = fs.readFileSync(path.join(BLOG_DIR, file), 'utf8');
  const fm = parseFrontmatter(content);

  if (fm.draft === 'true') continue;

  const lastDate = fm.updatedDate
    ? new Date(fm.updatedDate)
    : fm.pubDate
      ? new Date(fm.pubDate)
      : null;

  if (!lastDate || isNaN(lastDate)) continue;

  const ageMonths = Math.floor((NOW - lastDate) / (1000 * 60 * 60 * 24 * 30));
  const entry = {
    file,
    title: fm.title ?? file,
    lastDate: lastDate.toISOString().slice(0, 10),
    ageMonths,
    hasUpdatedDate: !!fm.updatedDate,
    categories: content.match(/categories:\s*\n\s*-\s*(\S+)/)?.[1] ?? '—',
  };

  if (lastDate < threshold) {
    stale.push(entry);
  } else {
    ok.push(entry);
  }
}

stale.sort((a, b) => a.lastDate.localeCompare(b.lastDate));

if (AS_JSON) {
  console.log(JSON.stringify({ threshold: threshold.toISOString().slice(0, 10), stale, ok }, null, 2));
  process.exit(stale.length ? 1 : 0);
}

console.log(`\nПорог: статьи без обновления более ${MONTHS} мес. (до ${threshold.toISOString().slice(0, 10)})\n`);

if (stale.length === 0) {
  console.log(`Все ${ok.length} статьи актуальны.`);
  process.exit(0);
}

console.log(`Требуют обновления: ${stale.length} из ${stale.length + ok.length}\n`);
console.log('Файл'.padEnd(55) + 'Последнее обновление'.padEnd(22) + 'Возраст   Категория');
console.log('─'.repeat(100));
for (const s of stale) {
  const age = `${s.ageMonths} мес.`.padEnd(10);
  const marker = s.hasUpdatedDate ? '' : ' ⚠ нет updatedDate';
  console.log(s.file.padEnd(55) + s.lastDate.padEnd(22) + age + s.categories + marker);
}

console.log(`\nДействие: запустите /blog rewrite <файл> или обновите updatedDate и дополните статью.`);
process.exit(1);
