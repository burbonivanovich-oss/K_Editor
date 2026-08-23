#!/usr/bin/env node
/**
 * Инварианты задачи: чем тему завели, тем она и остаётся.
 *
 * 13.08.2026 редактор поставила в таблицу «Актуализировать статью
 * https://kontur.ru/market/spravka/38077-…». В состоянии цикла эта тема
 * оказалась с `kind: "new"`, и по ней написали новую статью в
 * `src/content/blog/` — вместо разбора правок к существующему тексту. В
 * `src/content/updates/` при этом лежит только README: ни одного
 * документа актуализации не появилось ни разу.
 *
 * Причина не в разборе ячейки — он как раз различает «написать» и
 * «актуализировать» (`lib/update-task.mjs`). Причина в том, что тип
 * задачи ничем не удерживался: любая последующая правка строки
 * переписывала его вместе с заголовком, а несоответствие «тип update, а
 * материализована статья» никто не проверял.
 *
 * Отсюда два правила:
 *
 *   1. `kind` и `sourceUrl` неизменяемы после intake. Меняется ячейка —
 *      меняется заголовок и просьба редактора, но не то, что это за
 *      работа. Если редактор действительно хочет другой тип, это новая
 *      тема, а не правка старой (cycle-state пишет расхождение в
 *      `kindConflict`, чтобы рутина показала его человеку).
 *   2. У задачи типа `update` есть документ актуализации, нет новой
 *      статьи в блоге, и документ проходит `check-update-doc`.
 *
 * Про список известного долга. Три находки на момент разбора аудита —
 * это не «новая поломка», а незакрытые редакционные решения: что делать
 * с уже написанной статьёй по задаче на актуализацию, решает человек, а
 * не скрипт. Они перечислены в `src/data/task-invariants-debt.json` —
 * явно, парами «тема + код находки», с датой. Список не делает их
 * решёнными: они печатаются каждым прогоном и висят в health. Он лишь
 * отделяет известное от нового, чтобы `--strict` в CI краснел на новом.
 *
 * Запуск:
 *   node scripts/check-task-invariants.mjs            # отчёт
 *   node scripts/check-task-invariants.mjs --strict   # exit 1 при новых находках
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isMain } from './lib/is-main.mjs';
import { parseTopicCell } from './lib/update-task.mjs';

const ROOT = process.env.CYCLE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

export const TASK_KINDS = ['new', 'update'];

/** Статусы, где работы по теме ещё не было — тип может быть не определён. */
const NOT_STARTED = ['candidate', 'dropped'];

/** Статусы, в которых материал по теме обязан существовать. */
const MATERIALIZED = ['review', 'accepted', 'released'];

const hasBlogArticle = (root, slug) => {
  const dir = join(root, 'src/content/blog');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((x) => /\.mdx?$/.test(x) && x.replace(/\.mdx?$/, '').endsWith(slug));
  return f ? join('src/content/blog', f) : null;
};

const hasUpdateDoc = (root, slug) => {
  const dir = join(root, 'src/content/updates');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((x) => /\.mdx?$/.test(x) && x.replace(/\.mdx?$/, '').endsWith(slug));
  return f ? join('src/content/updates', f) : null;
};

/**
 * @param {object} state — содержимое editorial-cycle.json.
 * @returns {Array<{slug, code, problem}>}
 */
export function checkTaskInvariants(state, { root = ROOT, runDocCheck = true } = {}) {
  const problems = [];
  const add = (slug, code, problem) => problems.push({ slug, code, problem });

  for (const t of state?.plan || []) {
    const slug = t.slug || '(без slug)';
    if (t.status === 'dropped') continue;

    if (t.kindConflict) {
      add(slug, 'kind-conflict',
        `ячейку переписали на другой тип задачи (${t.kindConflict.declared ?? 'нет'}), тема осталась «${t.kind}» — решает человек: либо новая тема, либо вернуть текст ячейки`);
    }

    /* Что говорит сама ячейка редактора. Сверять с записанным типом
     * обязательно: тема «Актуализировать статью https://…» лежала в
     * состоянии как `kind: "new"`, и именно так задача на разбор правок
     * превратилась в новую статью. Тип, записанный при intake, — это
     * решение; расхождение с текстом ячейки — находка, а не мелочь. */
    /* Смотрим все сохранённые виды ячейки, а не один: у темы 38077
     * `rawTopic` уже переписан красивым заголовком, и директива
     * «Актуализировать статью …» осталась только в `originalTitle`. Взять
     * что-то одно значит снова не увидеть подмену. */
    const cells = [t.originalTitle, t.rawTopic, t.title].filter(Boolean);
    const parsed = cells.map((c) => parseTopicCell(c));
    const idx = parsed.findIndex((x) => x.kind === 'update');
    const declared = (idx === -1 ? parsed[0] : parsed[idx]) ?? { kind: null, sourceUrl: null };
    const declaredCell = idx === -1 ? (cells[0] ?? '') : cells[idx];
    if (TASK_KINDS.includes(t.kind) && TASK_KINDS.includes(declared.kind) && declared.kind !== t.kind) {
      add(slug, 'kind-drift',
        `в ячейке задача типа «${declared.kind}» («${String(declaredCell).slice(0, 60)}…»), а в состоянии «${t.kind}»`);
    }

    const kind = TASK_KINDS.includes(t.kind) ? t.kind : declared.kind;

    if (!TASK_KINDS.includes(kind)) {
      if (NOT_STARTED.includes(t.status)) continue;
      add(slug, 'no-kind', `тип задачи не определён (kind: ${JSON.stringify(t.kind)}) — по такой теме непонятно, писать статью или разбирать правки`);
      continue;
    }

    const blog = hasBlogArticle(root, slug);
    const doc = hasUpdateDoc(root, slug);

    if (kind === 'update') {
      if (!t.sourceUrl && !declared.sourceUrl) add(slug, 'no-source', 'задача на актуализацию без исходной ссылки — нечего актуализировать');
      if (blog) {
        add(slug, 'materialized-as-article',
          `задача на актуализацию, но по ней написана новая статья ${blog} — документ актуализации в src/content/updates/ так и не появился`);
      }
      if (MATERIALIZED.includes(t.status) && !doc) {
        add(slug, 'no-update-doc', `статус «${t.status}», а документа актуализации src/content/updates/*${slug}.md нет`);
      }
      if (doc && runDocCheck) {
        try {
          execFileSync('node', [join(ROOT, 'scripts/check-update-doc.mjs'), join(root, doc)],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
          const out = ((e.stdout || '') + (e.stderr || '')).trim().split('\n').slice(0, 3).join(' ');
          add(slug, 'bad-update-doc', `документ ${doc} не проходит check-update-doc: ${out}`);
        }
      }
    } else {
      if (t.sourceUrl) add(slug, 'source-on-new', `тип «new», но записана исходная ссылка ${t.sourceUrl} — это признак задачи на актуализацию`);
      if (MATERIALIZED.includes(t.status) && !blog) {
        add(slug, 'no-article', `статус «${t.status}», а статьи в src/content/blog/ нет`);
      }
    }
  }

  return problems;
}

/** Известные незакрытые решения: пары «slug + код находки». */
export function knownDebt(root = ROOT) {
  const p = join(root, 'src/data/task-invariants-debt.json');
  if (!existsSync(p)) return new Set();
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return new Set((data.issues || []).map((i) => `${i.slug}::${i.code}`));
  } catch {
    return new Set();
  }
}

if (isMain(import.meta.url)) {
  const strict = process.argv.includes('--strict');
  const path = process.env.CYCLE_STATE_PATH || join(ROOT, 'src/data/editorial-cycle.json');
  if (!existsSync(path)) { console.log('Состояния цикла нет — проверять нечего.'); process.exit(0); }

  const state = JSON.parse(readFileSync(path, 'utf8'));
  const problems = checkTaskInvariants(state);
  const live = (state.plan || []).filter((t) => t.status !== 'dropped').length;
  const debt = knownDebt();
  const isKnown = (p) => debt.has(`${p.slug}::${p.code}`);
  const known = problems.filter(isKnown);
  const fresh = problems.filter((p) => !isKnown(p));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ topics: live, problems, known: known.length, fresh: fresh.length }, null, 2));
    process.exit(strict && fresh.length ? 1 : 0);
  }

  console.log(`Тем в работе: ${live}\n`);
  if (!problems.length) {
    console.log('✓ Тип задачи у всех определён, актуализации не превратились в новые статьи.');
    process.exit(0);
  }

  const show = (title, list) => {
    if (!list.length) return;
    console.log(title);
    const byCode = {};
    for (const p of list) (byCode[p.code] ||= []).push(p);
    for (const [code, items] of Object.entries(byCode)) {
      console.log(`  ${code} — ${items.length}:`);
      for (const p of items.slice(0, 5)) console.log(`    • ${p.slug}: ${p.problem}`);
      if (items.length > 5) console.log(`    … и ещё ${items.length - 5}`);
    }
  };

  show('Ждут решения человека (src/data/task-invariants-debt.json):', known);
  show(fresh.length ? '\n✖ Новые расхождения:' : '', fresh);
  if (!fresh.length) console.log('\n✓ Новых расхождений нет.');
  process.exit(strict && fresh.length ? 1 : 0);
}
