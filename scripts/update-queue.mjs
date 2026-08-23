#!/usr/bin/env node
/**
 * Очередь актуализации: список чужих статей → темы цикла.
 *
 * Редакция отдаёт не одну статью, а пачку ссылок на материалы Маркета,
 * которые пора освежить. Руками это разбирать нельзя: 1348 статей в
 * каталоге, у каждой свой трафик, часть тем мы уже закрыли своими
 * текстами, часть ссылок в пачке повторяется.
 *
 * Скрипт делает детерминированную часть — ту, где ошибиться легко, а
 * заметить ошибку трудно:
 *   • сводит ссылку с каталогом Маркета (заголовок, просмотры);
 *   • снимает дубли внутри пачки — по числовому id, а не по строке;
 *   • отсекает то, что уже заведено в цикл;
 *   • находит наши статьи по той же теме — их надо не переписать
 *     заново, а перелинковать с обновляемой;
 *   • сортирует по просмотрам.
 *
 * Порядок по просмотрам — не про охват модуля. Статьи Маркета
 * зарабатывают принимающему проекту (AGENTS.md: «статьи существуют ради
 * продаж принимающего проекта»), и устаревший абзац на странице с 68 000
 * просмотров стоит дороже, чем на странице с двумя сотнями.
 *
 * Что решает ИИ, а не скрипт: устарела ли статья на самом деле, что
 * именно в ней править и стоит ли трогать её вообще. Скрипт сужает
 * список и расставляет порядок — процедура в
 * `.claude/commands/update-article.md`.
 *
 * Запуск:
 *   node scripts/update-queue.mjs --file urls.txt          # пачка от редакции
 *   node scripts/update-queue.mjs --file urls.txt --json   # для add-candidates
 *   node scripts/update-queue.mjs --from-catalog --top 20  # предложить самим
 *   node scripts/update-queue.mjs --from-catalog --top 20 --rubric Общепит
 *
 * Коды: 0 — очередь построена, 1 — ошибка входа, 2 — все ссылки отсеяны.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marketArticleId, lookupCatalog } from './lib/update-task.mjs';
import { stemTokens } from './wordstat/relevance.mjs';
import { isMain } from './lib/is-main.mjs';

const ROOT = process.env.UPDATE_QUEUE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = join(ROOT, 'src/data/interlinking/market-articles.json');
const STATE_PATH = process.env.CYCLE_STATE_PATH || join(ROOT, 'src/data/editorial-cycle.json');
const BLOG_DIR = join(ROOT, 'src/content/blog');

/* Порог пересечения с нашим корпусом. Тот же, что в
 * check-draft-duplication: там он выставлен по живым парам 13.08.2026,
 * и второй порог для той же задачи означал бы два разных ответа на
 * вопрос «это про одно и то же». */
const OVERLAP = 0.25;

const tokens = (s) => new Set(stemTokens(s || ''));
const jaccard = (a, b) => {
  let common = 0;
  for (const v of a) if (b.has(v)) common++;
  const union = a.size + b.size - common;
  return union ? common / union : 0;
};

const readJson = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
};

/** Ссылки из свободного текста: редакция присылает список письмом, а не CSV. */
export function extractUrls(text) {
  return [...String(text || '').matchAll(/https?:\/\/[^\s<>"'()]+/gi)]
    .map((m) => m[0].replace(/[.,;:!?»)\]]+$/, ''));
}

/** Наши выпущенные статьи — заголовок и целевые запросы. */
function ourArticles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.mdx?$/.test(f))
    .map((f) => {
      const fm = readFileSync(join(dir, f), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      return {
        file: f,
        title: fm.match(/title:\s*["'](.+?)["']/)?.[1] ?? f,
        draft: /^draft:\s*true/m.test(fm),
        konturUrl: fm.match(/^konturUrl:\s*["']?(https?:\/\/\S+?)["']?\s*$/m)?.[1] ?? null,
      };
    });
}

/**
 * Построить очередь.
 *
 * @param {string[]} urls        ссылки от редакции
 * @param {object[]} catalog     каталог Маркета
 * @param {object[]} plan        план цикла (что уже заведено)
 * @param {object[]} ours        наши статьи
 */
export function buildQueue({ urls, catalog = [], plan = [], ours = [] }) {
  const rows = [];
  const seen = new Set();
  const skipped = { duplicate: [], inCycle: [], unknown: [] };

  /* Уже заведённые в цикл — по id материала, а не по URL: в состоянии
   * ссылка лежит в том виде, в каком её напечатал редактор.
   *
   * У тем, заведённых до разбора ячейки, поля sourceUrl нет вовсе —
   * ссылка осталась внутри исходного текста темы. Их тоже надо узнавать,
   * иначе первая же пачка от редакции заведёт их по второму разу. */
  const inCycle = new Map();
  for (const t of plan) {
    if (t.status === 'dropped') continue;
    const candidates = [t.sourceUrl, t.rawTopic, t.originalTitle, t.title].filter(Boolean);
    for (const c of candidates) {
      const id = marketArticleId(c) || marketArticleId(extractUrls(c)[0]);
      if (id) { inCycle.set(id, t); break; }
    }
  }

  for (const url of urls) {
    const id = marketArticleId(url);
    const key = id || url;
    if (seen.has(key)) { skipped.duplicate.push(url); continue; }
    seen.add(key);

    if (inCycle.has(id)) { skipped.inCycle.push({ url, slug: inCycle.get(id).slug }); continue; }

    const hit = lookupCatalog(url, catalog);
    if (!hit) skipped.unknown.push(url);

    const title = hit?.title || null;
    /* Наши статьи по той же теме. Это не блокер: чужую статью мы
     * актуализируем, а свою — используем как источник фактов и как
     * цель перелинковки. Блокером было бы обратное — молча переписать
     * то, что уже написано. */
    const related = title
      ? ours
        .map((a) => ({ ...a, score: Number(jaccard(tokens(title), tokens(a.title)).toFixed(2)) }))
        .filter((a) => a.score >= OVERLAP || (a.konturUrl && marketArticleId(a.konturUrl) === id))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
      : [];

    rows.push({
      sourceUrl: url,
      sourceId: id,
      sourceTitle: title,
      views: hit?.viewsTotal ?? 0,
      rubric: hit?.rubric2 || hit?.rubric1 || null,
      inCatalog: Boolean(hit),
      related,
    });
  }

  rows.sort((a, b) => b.views - a.views);
  return { rows, skipped };
}

/** Строка очереди → тема для `cycle-state.mjs add-candidates`. */
export function toCandidate(r) {
  return {
    title: `Актуализация: ${r.sourceTitle || r.sourceUrl}`,
    sourceUrl: r.sourceUrl,
    sourceTitle: r.sourceTitle,
    // P0 достаётся тому, что реально читают: порог — верхний дециль
    // каталога, ниже него разница в просмотрах уже не про деньги.
    priority: r.views >= 20000 ? 'P0' : r.views >= 5000 ? 'P1' : 'P2',
    cluster: r.rubric || '',
    why: r.views
      ? `Актуализация материала Маркета, ${r.views.toLocaleString('ru-RU')} просмотров за период выгрузки`
      : 'Актуализация материала Маркета (нет в выгрузке Метрики)',
  };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
  const AS_JSON = argv.includes('--json');

  const catalog = readJson(CATALOG_PATH, { articles: [] }).articles || [];
  const plan = readJson(STATE_PATH, { plan: [] }).plan || [];
  const ours = ourArticles(BLOG_DIR);

  let urls;
  if (argv.includes('--from-catalog')) {
    const top = Number(arg('top', 20));
    const rubric = arg('rubric', null);
    urls = catalog
      .filter((a) => !rubric || [a.rubric1, a.rubric2].some((r) => (r || '').toLowerCase().includes(rubric.toLowerCase())))
      .sort((a, b) => (b.viewsTotal || 0) - (a.viewsTotal || 0))
      .slice(0, top)
      .map((a) => a.url);
  } else {
    const file = arg('file');
    if (!file || !existsSync(file)) {
      console.error('Использование: update-queue.mjs --file <список ссылок> [--json]');
      console.error('           или: update-queue.mjs --from-catalog --top 20 [--rubric Общепит]');
      process.exit(1);
    }
    urls = extractUrls(readFileSync(file, 'utf8'));
  }

  if (!urls.length) {
    console.error('✖ Ссылок не найдено.');
    process.exit(1);
  }

  const { rows, skipped } = buildQueue({ urls, catalog, plan, ours });

  if (AS_JSON) {
    console.log(JSON.stringify(rows.map(toCandidate), null, 2));
  } else {
    console.log(`Очередь актуализации: ${rows.length} из ${urls.length} ссылок\n`);
    for (const r of rows) {
      const views = r.views ? `${r.views.toLocaleString('ru-RU')} просм.` : 'нет в выгрузке';
      console.log(`  ${r.sourceTitle || r.sourceUrl}`);
      console.log(`     ${views}${r.rubric ? ` · ${r.rubric}` : ''} · ${r.sourceUrl}`);
      for (const a of r.related) {
        console.log(`     ↔ наша статья (${a.score}${a.draft ? ', черновик' : ''}): ${a.title}`);
      }
    }
    const say = (label, list) => { if (list.length) console.log(`\n${label}: ${list.length}`); };
    say('Повторы в списке', skipped.duplicate);
    say('Уже в цикле', skipped.inCycle);
    say('Нет в каталоге Маркета — заголовок и трафик неизвестны', skipped.unknown);
    for (const u of skipped.unknown) console.log(`   • ${u}`);
    for (const x of skipped.inCycle) console.log(`   • ${x.url} → ${x.slug}`);
  }

  process.exit(rows.length ? 0 : 2);
}
