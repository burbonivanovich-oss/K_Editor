#!/usr/bin/env node
// Стадия 1 /create-article, шаг 2b: сверяет тему новой статьи с каталогом
// уже опубликованных статей kontur.ru/market (src/data/interlinking/market-articles.json).
//
// Это НЕ дубль-блокер по образцу проверки src/content/blog/*.md — задача
// модуля не совпадает с задачей Маркета (см. CLAUDE.md: «Своего сайта у
// модуля нет», Маркет — принимающий проект, зарабатывающий на продажах).
// Совпадение темы здесь не повод остановиться, а сигнал:
//   1) не писать статью, которая просто пересказывает то же самое другими
//      словами — либо взять более узкий/другой угол, либо явно
//      дополнить то, чего в статье Маркета нет (см. постмортем
//      2026-08-06: у существующей статьи про ТС ПИоТ не было штрафов);
//   2) обязательно перелинковаться со найденной статьёй Маркета —
//      это прямой путь к продажам, из-за которого каталог вообще собран.
//
// Использование:
//   node scripts/audit/check-market-duplication.mjs "<тема или заголовок>"

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Использование: node scripts/audit/check-market-duplication.mjs "<тема>"');
  process.exit(1);
}

const CATALOG_PATH = join(ROOT, 'src/data/interlinking/market-articles.json');
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

// Минимальный стоп-лист — не претендует на полноту, только убирает самый
// частый шум, который иначе раздувает пересечение между несвязанными темами.
const STOPWORDS = new Set([
  'и', 'в', 'на', 'с', 'по', 'для', 'от', 'до', 'из', 'к', 'о', 'об', 'у',
  'а', 'но', 'или', 'не', 'же', 'ли', 'бы', 'то', 'это', 'эти', 'этот', 'эта',
  'что', 'как', 'какой', 'какие', 'кто', 'кому', 'чего', 'все', 'всё', 'вся',
  'при', 'за', 'уже', 'если', 'нужно', 'нужен', 'нужна', 'можно', 'года',
  'году', 'год',
]);

function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[«»"'.,:;!?()–—/№]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccard(a, b) {
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const queryTokens = tokenize(query);
const THRESHOLD = 0.3;

const scored = catalog.articles
  .map((a) => ({ ...a, score: jaccard(queryTokens, tokenize(a.title)) }))
  .filter((a) => a.score >= THRESHOLD)
  .sort((a, b) => b.score - a.score || b.viewsTotal - a.viewsTotal)
  .slice(0, 5);

console.log(`Тема: «${query}»`);
console.log(`Каталог: ${catalog.articles.length} статей Маркета (${catalog.generatedFrom})`);
console.log('');

if (scored.length === 0) {
  console.log('✓ Совпадений ≥ 0.3 не найдено — прямого пересечения с каталогом Маркета нет.');
  process.exit(0);
}

console.log(`⚠ Найдено близких статей в каталоге Маркета: ${scored.length}`);
console.log('  Не блокер — реши, брать ли другой угол, и обязательно добавь ссылку на верхний матч.\n');
for (const a of scored) {
  console.log(`  [${a.score.toFixed(2)}] ${a.title}`);
  console.log(`         ${a.url} (${a.viewsTotal} просмотров, ${a.rubric2})`);
}
