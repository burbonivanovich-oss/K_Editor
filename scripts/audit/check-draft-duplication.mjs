#!/usr/bin/env node
/**
 * Есть ли в репозитории статья по этой же теме — включая черновики.
 *
 * Рутина C 13.08.2026 обнаружила это посреди работы: тема «Касса от банка
 * или отдельно» дословно повторяла черновик, написанный четырьмя днями
 * раньше и не заведённый в цикл. Сессия остановилась и спросила владельца,
 * что делать, — батч встал на несколько часов.
 *
 * Вопрос был правильный, момент неправильный: узнавать о дубле нужно до
 * ресёрча, а не после. И ответ на него не требует человека, если правило
 * записано заранее.
 *
 * Скрипт отвечает на вопрос до начала работы: с чем именно совпадает,
 * насколько и в каком состоянии найденный текст. Решение по правилу —
 * в .claude/commands/cycle-batch.md, шаг 1б.
 *
 * Запуск:
 *   node scripts/audit/check-draft-duplication.mjs "<тема или целевой запрос>"
 *   node scripts/audit/check-draft-duplication.mjs "<тема>" --json
 *
 * Коды: 0 — чисто, 1 — найден дубль (порог 0.4), 2 — пограничное совпадение.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stemTokens } from '../wordstat/relevance.mjs';

/* Сравниваем по основам слов, а не по словам целиком.
 *
 * Первая версия брала tokenize из lib/text-similarity и на живом случае
 * дала 0.30 там, где для человека дубль очевиден: «Касса от банка или
 * отдельно: как банки предлагают онлайн-кассы» против «Онлайн-кассы от
 * банка или своя касса». Мешали дефис («онлайн-кассы» одним токеном) и
 * падежи («банк» против «банка»). На основах те же пары дают 0.36 по
 * заголовкам и 0.43 по целевому запросу. */
const tokens = (s) => new Set(stemTokens(s));
const jaccard = (a, b) => {
  let common = 0;
  for (const v of a) if (b.has(v)) common++;
  const union = a.size + b.size - common;
  return union ? common / union : 0;
};

const ROOT = process.env.DUP_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLOG = join(ROOT, 'src', 'content', 'blog');

/* Пороги подобраны на живых парах 13.08.2026: настоящий дубль дал 0.43
 * по целевому запросу, соседняя тема кластера («маркировка шин» против
 * «онлайн-кассы от банка») — 0.15. */
const DUPLICATE = 0.4;
const BORDERLINE = 0.25;

const args = process.argv.slice(2);
const AS_JSON = args.includes('--json');
const query = args.find((a) => !a.startsWith('--'));

if (!query) {
  console.error('Использование: check-draft-duplication.mjs "<тема>" [--json]');
  process.exit(2);
}

function articles() {
  if (!existsSync(BLOG)) return [];
  return readdirSync(BLOG)
    .filter((f) => /\.mdx?$/.test(f))
    .map((f) => {
      const raw = readFileSync(join(BLOG, f), 'utf8');
      const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      const kw = fm.match(/keywords:\s*\n((?:\s+-\s+[^\n]+\n?)+)/)?.[1] ?? '';
      return {
        file: f,
        title: fm.match(/title:\s*["'](.+?)["']/)?.[1] ?? f,
        draft: /^draft:\s*true/m.test(fm),
        keywords: (kw.match(/(?<=-\s)(.+)/g) ?? []).map((k) => k.trim().replace(/^["']|["']$/g, '')),
      };
    });
}

const q = tokens(query);
const hits = [];
for (const a of articles()) {
  // Сравниваем и с заголовком, и с целевыми запросами: тема может
  // совпадать по запросу при разных заголовках — это тот же дубль.
  const score = Math.max(
    jaccard(q, tokens(a.title)),
    ...a.keywords.map((k) => jaccard(q, tokens(k))),
    0,
  );
  if (score >= BORDERLINE) hits.push({ ...a, score: Number(score.toFixed(2)) });
}
hits.sort((a, b) => b.score - a.score);

if (AS_JSON) {
  console.log(JSON.stringify({ query, threshold: DUPLICATE, hits }, null, 2));
} else if (!hits.length) {
  console.log(`✓ «${query}» — совпадений в репозитории нет, тему можно писать.`);
} else {
  for (const h of hits) {
    const state = h.draft ? 'черновик' : 'выпущена';
    console.log(`${h.score}  [${state}]  ${h.title}`);
    console.log(`        ${h.file}`);
  }
  console.log(
    hits[0].score >= DUPLICATE
      ? '\n✖ Это дубль. По правилу (cycle-batch.md, шаг 1б) новую статью не писать: довести существующую.'
      : '\n⚠ Пограничное совпадение — сузить угол и сослаться на существующий материал.',
  );
}

process.exit(!hits.length ? 0 : hits[0].score >= DUPLICATE ? 1 : 2);
