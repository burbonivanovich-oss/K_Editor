#!/usr/bin/env node
/**
 * Метрики редакционного процесса: что происходит с текстом после бота.
 *
 * Смысл — измерять то, что показывает реальное качество, а не то, что
 * легко посчитать. Балл ставит тот же контур, который писал; проверки
 * говорят про форму. А вот сколько абзацев редакция переписала руками,
 * сколько тем сняла, сколько промоблоков выкинула из готового текста и
 * насколько статьи похожи друг на друга — это внешние сигналы, их
 * подделать нельзя.
 *
 * Четыре среза (F-04 внешнего аудита):
 *
 *   переделки  — журнал `docs/editorial-feedback.md`: что бот написал и
 *                на что редакция это заменила при приёмке;
 *   отказы     — темы в статусе dropped против всего плана;
 *   промо      — блоки, которые были в плане `src/data/visuals/<slug>.md`,
 *                но в опубликованный текст не попали;
 *   повторяемость — корпусная одинаковость (check-corpus-repetition.mjs).
 *
 * Цифры без порогов: это приборная панель, а не гейт. Порог здесь
 * означал бы, что мы знаем норму переделок, — мы её не знаем, и первый
 * же выставленный наугад порог начнут обходить.
 *
 * Запуск:
 *   node scripts/editorial-metrics.mjs
 *   node scripts/editorial-metrics.mjs --json
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { checkCorpusRepetition } from './audit/check-corpus-repetition.mjs';

const ROOT = process.env.METRICS_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (p, fallback = null) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
};

/** Правки редакции из журнала: по статьям и по видам. */
export function reworkMetrics(root = ROOT) {
  const journal = join(root, 'docs/editorial-feedback.md');
  if (!existsSync(journal)) return { entries: 0, articles: 0, byKind: {}, note: 'журнала правок ещё нет' };

  const text = readFileSync(journal, 'utf8');
  const entries = text.split(/^## /m).slice(1);
  const articles = new Set();
  const byKind = {};
  for (const e of entries) {
    const slug = (e.split('\n')[0].split('·')[1] || '').trim();
    if (slug) articles.add(slug);
    for (const m of e.matchAll(/^\*\*(.+?)\.?\*\*/gm)) {
      const kind = m[1].trim().toLowerCase();
      byKind[kind] = (byKind[kind] || 0) + 1;
    }
  }
  return { entries: entries.length, articles: articles.size, byKind };
}

/** Отказы редакции: тема снята, работа не пошла в дело. */
export function dropMetrics(root = ROOT) {
  const state = readJson(join(root, 'src/data/editorial-cycle.json'), { plan: [] });
  const plan = state.plan || [];
  const dropped = plan.filter((t) => t.status === 'dropped');
  const afterWork = dropped.filter((t) => t.docId || t.docUrl || t.articleSlug);
  return {
    total: plan.length,
    dropped: dropped.length,
    droppedAfterWork: afterWork.length,
    share: plan.length ? Number((dropped.length / plan.length).toFixed(2)) : 0,
  };
}

/** Промоблоки: было в плане — осталось ли в тексте. */
export function promoMetrics(root = ROOT) {
  const visualsDir = join(root, 'src/data/visuals');
  const blogDir = join(root, 'src/content/blog');
  if (!existsSync(visualsDir) || !existsSync(blogDir)) return { planned: 0, kept: 0, removed: 0, byArticle: [] };

  const byArticle = [];
  let planned = 0;
  let kept = 0;
  for (const f of readdirSync(visualsDir).filter((x) => /\.mdx?$/.test(x))) {
    const slug = f.replace(/\.mdx?$/, '');
    const article = readdirSync(blogDir).find((x) => x.replace(/\.mdx?$/, '') === slug);
    if (!article) continue;

    /* В плане id промоблоков стоят в таблице обратными кавычками, в
     * статье — маркером [Промоблок: id]. Сравниваем множества. */
    /* Только раздел с подводками: в остальном плане тоже встречаются
     * числа в кавычках — номера тегов, версии, суммы. */
    const visual = readFileSync(join(visualsDir, f), 'utf8');
    const section = visual.slice(visual.search(/^##\s+Подводки/im) + 1).split(/^##\s/m)[0];
    const plan = new Set([...section.matchAll(/`(\d{3,})`/g)].map((m) => m[1]));
    const inText = new Set([...readFileSync(join(blogDir, article), 'utf8')
      .matchAll(/^\[Промоблок:\s*([^\]]+)\]\s*$/gim)].map((m) => m[1].trim()));
    if (!plan.size) continue;

    const removed = [...plan].filter((id) => !inText.has(id));
    planned += plan.size;
    kept += plan.size - removed.length;
    if (removed.length) byArticle.push({ slug, removed });
  }
  return { planned, kept, removed: planned - kept, byArticle };
}

export function editorialMetrics(root = ROOT) {
  const rep = checkCorpusRepetition({ root });
  return {
    rework: reworkMetrics(root),
    drops: dropMetrics(root),
    promo: promoMetrics(root),
    repetition: {
      articles: rep.formal.total,
      withFaq: rep.formal.withFaq,
      promoCounts: rep.formal.promoCounts,
      sameOutline: rep.outline.length,
      sameEnding: rep.ending.length,
      sameFaq: rep.faq.length,
      repeatedPhrases: rep.phrases.length,
    },
  };
}

if (isMain(import.meta.url)) {
  const m = editorialMetrics();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(m, null, 2));
    process.exit(0);
  }

  console.log('Метрики редакционного процесса\n');

  console.log('Переделки редакции (docs/editorial-feedback.md)');
  if (m.rework.note) console.log(`  ${m.rework.note}`);
  else {
    console.log(`  записей: ${m.rework.entries}, статей затронуто: ${m.rework.articles}`);
    for (const [kind, n] of Object.entries(m.rework.byKind).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.log(`    ${kind}: ${n}`);
    }
  }

  console.log('\nОтказы редакции');
  console.log(`  снято тем: ${m.drops.dropped} из ${m.drops.total} (${Math.round(m.drops.share * 100)}%)`);
  if (m.drops.droppedAfterWork) console.log(`  из них после начала работы: ${m.drops.droppedAfterWork}`);

  console.log('\nПромоблоки: план против текста');
  console.log(`  запланировано ${m.promo.planned}, осталось в тексте ${m.promo.kept}, убрано ${m.promo.removed}`);
  for (const a of m.promo.byArticle.slice(0, 5)) console.log(`    ${a.slug}: убрано ${a.removed.join(', ')}`);

  console.log('\nПовторяемость корпуса');
  const r = m.repetition;
  console.log(`  статей ${r.articles}, с FAQ ${r.withFaq}, промоблоков на статью: ${Object.entries(r.promoCounts).map(([n, c]) => `${n} → ${c}`).join(', ')}`);
  console.log(`  одинаковых каркасов ${r.sameOutline}, финалов ${r.sameEnding}, вопросов ${r.sameFaq}, дословных повторов ${r.repeatedPhrases}`);

  console.log('\nПорогов здесь нет намеренно: нормы переделок мы не знаем,');
  console.log('а выставленный наугад порог начнут обходить.');
  process.exit(0);
}
