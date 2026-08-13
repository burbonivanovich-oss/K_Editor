#!/usr/bin/env node
// Стадия 1 /create-article, шаг 2b: сверяет тему новой статьи с каталогом
// уже опубликованных статей kontur.ru/market (src/data/interlinking/market-articles.json).
//
// Это НЕ дубль-блокер по образцу проверки src/content/blog/*.md — задача
// модуля не совпадает с задачей Маркета (см. AGENTS.md: «Своего сайта у
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
import { tokenize, jaccard } from '../lib/text-similarity.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
/* Корень подменяется в тестах и в прогоне гейта на фикстуре. Без этого
 * скрипт всегда читает живой каталог Маркета: на тестовых данных он
 * отвечает правду про чужой каталог — то есть врёт тихо. */
const ROOT = process.env.MARKET_ROOT || join(__dir, '..', '..');

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Использование: node scripts/audit/check-market-duplication.mjs "<тема>"');
  process.exit(1);
}

const CATALOG_PATH = join(ROOT, 'src/data/interlinking/market-articles.json');
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

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
