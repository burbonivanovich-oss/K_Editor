#!/usr/bin/env node
/**
 * Повторяемость корпуса: одинаковость между статьями, а не внутри одной.
 *
 * AI-checker ищет отдельные обороты внутри текста и на всех десяти
 * статьях выдаёт 0–2 из 10 — то есть «машинного текста нет». При этом
 * корпус выглядит собранным по одному шаблону: у всех FAQ, почти у всех
 * ровно три промоблока, похожие финалы и близкие наборы H2. Ни одна
 * проверка этого не видела, потому что все смотрели на статью
 * поодиночке.
 *
 * Здесь сравниваются статьи между собой:
 *
 *   outline — набор H2. Две статьи с одинаковым каркасом отвечают на
 *             разные запросы одинаковыми словами;
 *   ending  — последний абзац. «Похожий финал» — самый заметный признак
 *             шаблона: читатель дочитывает и узнаёт конец;
 *   faq     — вопросы FAQ. Один и тот же вопрос в трёх статьях означает,
 *             что его задавали не читателю, а формату;
 *   phrases — дословные повторы длиной от шести слов, встречающиеся в
 *             трёх и более статьях.
 *
 * Это измерение, а не гейт качества текста: порог здесь — повод
 * посмотреть, а не приговор. Поэтому по умолчанию скрипт печатает срез,
 * а --strict краснеет только на дословных повторах и на совпадении
 * каркасов выше порога.
 *
 * Запуск:
 *   node scripts/audit/check-corpus-repetition.mjs
 *   node scripts/audit/check-corpus-repetition.mjs --json
 *   node scripts/audit/check-corpus-repetition.mjs --strict
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { tokenize, jaccard } from '../lib/text-similarity.mjs';

const ROOT = process.env.CORPUS_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLOG = join(ROOT, 'src/content/blog');

/** Пороги. Ниже — нормальное сходство темы, выше — общий шаблон. */
export const THRESHOLDS = {
  outline: 0.5,   // половина каркаса совпадает
  ending: 0.45,   // финалы про одно и теми же словами
  phraseWords: 6, // длина дословного повтора
  phraseArticles: 3, // в скольких статьях он должен встретиться
};

const stripFrontmatter = (raw) => raw.replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*\n?/, '');

/** Разбор статьи на то, что сравнивается между статьями. */
export function parseArticle(raw) {
  const body = stripFrontmatter(raw);
  const h2 = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1].trim());

  const faqHeadings = [...body.matchAll(/^#{2,3}[ \t].*(?:FAQ|вопрос).*$/gim)];
  let faq = [];
  if (faqHeadings.length) {
    const h = faqHeadings[faqHeadings.length - 1];
    const after = body.slice(h.index + h[0].length).split(/^##\s/m)[0];
    faq = [
      ...after.matchAll(/^\*\*(.+?)\*\*\s*$/gm),
      ...after.matchAll(/^#{3,4}\s+(.+?)\s*$/gm),
    ].map((m) => m[1].trim());
  }

  /* Финал — последний содержательный абзац: маркеры промоблоков,
   * заголовки и списки концом статьи не являются. */
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#{1,6}\s/.test(p) && !/^\[(Промоблок|Врезка)/i.test(p) && !/^[-*|]/.test(p));
  const ending = paragraphs[paragraphs.length - 1] || '';

  const promos = [...body.matchAll(/^\[Промоблок:\s*([^\]]+)\]\s*$/gim)].map((m) => m[1].trim());

  return { h2, faq, ending, promos, body };
}

/** Слова текста в сравнимом виде — для дословных повторов. */
const words = (text) => text
  .toLowerCase()
  .replace(/\[(Промоблок|Врезка)[^\]]*\]/gi, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // адрес ссылки — не проза
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean);

/* Ссылка на одну и ту же норму в разных статьях — не шаблон, а
 * предметная область: «ч. 2 ст. 14.5 КоАП РФ» обязано повторяться. Из
 * дословных повторов такие последовательности убираем, иначе список
 * заполняется ими и настоящие шаблонные обороты в нём не видно. */
const CITATION_TOKENS = /^(ст|ч|п|пп|абз|фз|коап|ук|нк|рф|пп рф|№|года?|г)$/i;
const isCitation = (phrase) => {
  const w = phrase.split(' ');
  const cite = w.filter((x) => CITATION_TOKENS.test(x) || /^\d+$/.test(x)).length;
  return cite / w.length >= 0.5;
};

/** Дословные последовательности длиной n. */
function shingles(text, n) {
  const w = words(text);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

const pairs = (arr) => arr.flatMap((a, i) => arr.slice(i + 1).map((b) => [a, b]));

/**
 * @returns {{articles, outline, ending, faq, phrases, formal}}
 */
export function checkCorpusRepetition({ root = ROOT, thresholds = THRESHOLDS } = {}) {
  const dir = join(root, 'src/content/blog');
  if (!existsSync(dir)) {
    return { articles: [], outline: [], ending: [], faq: [], phrases: [], formal: { total: 0, withFaq: 0, promoCounts: {} } };
  }

  const articles = readdirSync(dir)
    .filter((f) => /\.mdx?$/.test(f))
    .map((f) => ({ slug: f.replace(/\.mdx?$/, ''), ...parseArticle(readFileSync(join(dir, f), 'utf8')) }));

  /* Каркас и финал — попарно: одинаковость это отношение между двумя
   * статьями, а не свойство одной. */
  const outline = [];
  const ending = [];
  for (const [a, b] of pairs(articles)) {
    const o = jaccard(tokenize(a.h2.join(' ')), tokenize(b.h2.join(' ')));
    if (o >= thresholds.outline) outline.push({ a: a.slug, b: b.slug, score: Number(o.toFixed(2)) });
    const e = jaccard(tokenize(a.ending), tokenize(b.ending));
    if (a.ending && b.ending && e >= thresholds.ending) {
      ending.push({ a: a.slug, b: b.slug, score: Number(e.toFixed(2)), sample: a.ending.slice(0, 90) });
    }
  }

  /* Вопрос FAQ, встречающийся в нескольких статьях, — вопрос к формату,
   * а не к теме. Сравниваем по значимым словам: формулировки гуляют. */
  const faqIndex = new Map();
  for (const art of articles) {
    for (const q of art.faq) {
      const key = [...tokenize(q)].sort().join(' ');
      if (!key) continue;
      if (!faqIndex.has(key)) faqIndex.set(key, { question: q, slugs: [] });
      faqIndex.get(key).slugs.push(art.slug);
    }
  }
  const faq = [...faqIndex.values()]
    .filter((x) => new Set(x.slugs).size >= 2)
    .map((x) => ({ question: x.question, articles: [...new Set(x.slugs)] }));

  /* Дословные повторы. Считаем по числу статей, а не вхождений: одна
   * статья, повторяющая свою же фразу, — другая проблема. */
  const phraseIndex = new Map();
  for (const art of articles) {
    for (const sh of shingles(art.body, thresholds.phraseWords)) {
      if (!phraseIndex.has(sh)) phraseIndex.set(sh, new Set());
      phraseIndex.get(sh).add(art.slug);
    }
  }
  const phrases = [...phraseIndex.entries()]
    .filter(([phrase, slugs]) => slugs.size >= thresholds.phraseArticles && !isCitation(phrase))
    .map(([phrase, slugs]) => ({ phrase, articles: [...slugs] }))
    .sort((x, y) => y.articles.length - x.articles.length);

  /* Формальные признаки шаблона — просто счёт, без порога: он нужен,
   * чтобы «у всех ровно три промо» было видно числом. */
  const withFaq = articles.filter((a) => a.faq.length).length;
  const promoCounts = {};
  for (const a of articles) promoCounts[a.promos.length] = (promoCounts[a.promos.length] || 0) + 1;

  return {
    articles: articles.map((a) => ({ slug: a.slug, h2: a.h2.length, faq: a.faq.length, promos: a.promos.length })),
    outline, ending, faq, phrases,
    formal: { total: articles.length, withFaq, promoCounts },
  };
}

if (isMain(import.meta.url)) {
  const r = checkCorpusRepetition();
  const strict = process.argv.includes('--strict');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(strict && (r.phrases.length || r.outline.length) ? 1 : 0);
  }

  if (!r.articles.length) { console.log('Статей нет.'); process.exit(0); }

  console.log(`Статей в корпусе: ${r.formal.total}`);
  console.log(`  с FAQ: ${r.formal.withFaq}/${r.formal.total}`);
  console.log(`  промоблоков на статью: ${Object.entries(r.formal.promoCounts).map(([n, c]) => `${n} → ${c} ст.`).join(', ')}\n`);

  const section = (title, list, render) => {
    if (!list.length) { console.log(`✓ ${title}: не найдено`); return; }
    console.log(`✖ ${title}: ${list.length}`);
    for (const x of list.slice(0, 5)) console.log(`    ${render(x)}`);
    if (list.length > 5) console.log(`    … и ещё ${list.length - 5}`);
  };

  section('Совпадающие каркасы H2', r.outline, (x) => `${x.score} — ${x.a} ↔ ${x.b}`);
  section('Похожие финалы', r.ending, (x) => `${x.score} — ${x.a} ↔ ${x.b}: «${x.sample}…»`);
  section('Повторяющиеся вопросы FAQ', r.faq, (x) => `«${x.question}» — ${x.articles.length} ст.`);
  section(`Дословные повторы от ${THRESHOLDS.phraseWords} слов`, r.phrases,
    (x) => `«${x.phrase}» — ${x.articles.length} ст.`);

  console.log('\nЭто измерение, а не приговор: порог — повод посмотреть.');
  process.exit(strict && (r.phrases.length || r.outline.length) ? 1 : 0);
}
