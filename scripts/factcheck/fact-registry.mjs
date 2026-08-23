/**
 * J-01/J-02. Реестр повторяемых фактов и сверка корпуса между статьями.
 *
 * Зачем. Каждая статья проверяется в одиночку, и до сих пор этого
 * казалось достаточно. Второй проход аудита показал, что нет:
 *
 * — порог крупного размера по главе 22 УК РФ жил в корпусе в двух
 *   значениях сразу. Опубликованная статья говорила «от 2 250 000 ₽»,
 *   соседняя — «свыше 3 500 000 ₽» и прямо предупреждала «если
 *   встретите старые цифры в других материалах, сверяйтесь». И
 *   ссылалась как на опорную ровно на ту статью, где стояла старая
 *   цифра. Обе прошли факчек: каждая по отдельности была внутренне
 *   непротиворечива;
 *
 * — на вопрос «ГИС МТ не отвечает, что делать» три статьи давали три
 *   разных ответа. У каждого был свой источник, и ни одна проверка не
 *   сравнивала статьи между собой.
 *
 * Отсюда реестр. Повторяемая норма перестаёт быть строкой текста в
 * каждой статье и становится записью с одним значением, областью
 * действия, датами и доказательством. Статьи на неё ссылаются, а не
 * пересказывают её заново.
 *
 * Два рода записей, потому что и ошибки бывают двух родов.
 *
 * `value` — у факта есть значение, и оно менялось. Проверяется, что в
 * корпусе не осталось прежнего значения, поданного как действующее.
 * Историческое упоминание разрешено явно: «подняли с 2 250 000 ₽»
 * — это правильный способ говорить о старой редакции, и запрещать его
 * значило бы запрещать объяснять изменение.
 *
 * `rule` — у факта нет числа, есть утверждение. Проверяется, что статья,
 * которая заводит речь об этой ситуации (`detect`), не утверждает
 * обратного (`contradicts`).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';

const ROOT = process.env.FACTCHECK_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const REGISTRY = 'src/data/factcheck/facts.json';

export const FACT_KINDS = ['value', 'rule'];

const norm = (s) => String(s ?? '')
  .replace(/[  ]/g, ' ')
  .replace(/\s+/g, ' ')
  .toLowerCase();

/** Число без разделителей: «3 500 000» и «3500000» — одно и то же. */
const digits = (s) => String(s ?? '').replace(/[^\d]/g, '');

/** Тело статьи без frontmatter — сверяем текст, а не служебные поля. */
const body = (src) => {
  const m = String(src).match(/^---[ \t]*\n[\s\S]*?\n---[ \t]*\n?/);
  return m ? src.slice(m[0].length) : src;
};

export function loadRegistry(root = ROOT) {
  const p = join(root, REGISTRY);
  if (!existsSync(p)) return { facts: [], path: p, exists: false };
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return { facts: data.facts || [], meta: data, path: p, exists: true };
  } catch (e) {
    return { facts: [], path: p, exists: true, broken: e.message };
  }
}

/**
 * Форма записи реестра. Незаполненное поле здесь опаснее, чем в отчёте:
 * запись реестра управляет проверкой всего корпуса, и «почти
 * заполненная» запись молча ослабляет её везде сразу.
 */
export function validateRegistry(facts) {
  const problems = [];
  const add = (id, problem) => problems.push({ id, problem });
  const seen = new Set();

  for (const [i, f] of (facts || []).entries()) {
    const id = f?.id || `#${i + 1}`;
    if (!f?.id) add(id, 'нет id');
    else if (seen.has(f.id)) add(id, 'id повторяется');
    else seen.add(f.id);

    if (!FACT_KINDS.includes(f?.kind)) add(id, `kind «${f?.kind ?? 'нет'}» не из списка: ${FACT_KINDS.join(', ')}`);
    if (!String(f?.statement || '').trim()) add(id, 'нет statement — что именно утверждает эта запись');
    if (!String(f?.scope || '').trim()) add(id, 'нет scope — к какому случаю запись применяется');
    if (!f?.effectiveFrom) add(id, 'нет effectiveFrom — с какой даты значение действует');
    if (f?.effectiveTo === undefined) add(id, 'нет effectiveTo (null — действует бессрочно)');
    if (!f?.evidence?.url || !f?.evidence?.quote) {
      add(id, 'нет доказательства с url и дословной цитатой — запись реестра управляет проверкой всего корпуса');
    } else if (!/^[0-9a-f]{64}$/.test(String(f.evidence.snapshotHash ?? ''))) {
      /* Отпечаток обязателен именно здесь и обязателен сильнее, чем в
       * отчёте. Запись реестра проверяет весь корпус разом: цитата,
       * которую никто не сверял со страницей, тиражирует ошибку на все
       * статьи сразу. Проверено на себе — пять записей из пяти были
       * заведены с цитатами-пересказами, и ни одна не нашлась в
       * первоисточнике. Снять отпечаток: node scripts/factcheck/snapshot.mjs <url> --quote "…" */
      add(id, 'нет snapshotHash — цитату никто не сверял со страницей первоисточника');
    }

    if (f?.kind === 'value') {
      if (!String(f?.value || '').trim()) add(id, 'kind value без value');
      for (const [j, s] of (f?.supersedes || []).entries()) {
        if (!s?.value) add(`${id}/supersedes[${j}]`, 'нет прежнего значения');
        if (!s?.by) add(`${id}/supersedes[${j}]`, 'нет by — чем именно значение изменено');
      }
    }
    if (f?.kind === 'rule') {
      if (!f?.detect) add(id, 'kind rule без detect — по чему узнавать, что статья говорит об этой ситуации');
      if (!(f?.contradicts || []).length) add(id, 'kind rule без contradicts — что считается противоречием');
      for (const re of [f?.detect, ...(f?.contradicts || [])]) {
        if (!re) continue;
        try { new RegExp(re, 'iu'); } catch (e) { add(id, `выражение «${re}» не разбирается: ${e.message}`); }
      }
    }
  }
  return problems;
}

/* Обороты, которыми говорят о прежней редакции. Историческое упоминание
 * старого значения — не ошибка, а правильный способ объяснить
 * изменение; ошибка — подать его как действующее. */
const HISTORICAL = /(поднял\p{L}*|повысил\p{L}*|увеличил\p{L}*|снизил\p{L}*|изменил\p{L}*|был\p{L}*|ранее|раньше|до\s+\d{2}\.\d{2}\.\d{4}|устаревш\p{L}*|прежн\p{L}*|старо\p{L}*|старых|старые|с)\s*$/iu;

/** Похоже ли, что старое значение подано как историческое, а не как текущее. */
export function looksHistorical(text, index, window = 90) {
  const before = norm(String(text).slice(Math.max(0, index - window), index));
  return HISTORICAL.test(before);
}

/**
 * Сверка корпуса с реестром.
 *
 * @param {object} opts
 * @param {string} [opts.root]
 * @returns {{conflicts: Array, usage: Map, facts: number}}
 */
export function checkCorpus({ root = ROOT } = {}) {
  const { facts } = loadRegistry(root);
  const blog = join(root, 'src/content/blog');
  const slugs = existsSync(blog)
    ? readdirSync(blog).filter((f) => /\.mdx?$/.test(f)).map((f) => f.replace(/\.mdx?$/, ''))
    : [];

  const conflicts = [];
  const usage = new Map(facts.map((f) => [f.id, []]));

  for (const slug of slugs) {
    const p = ['.md', '.mdx'].map((e) => join(blog, slug + e)).find(existsSync);
    const file = readFileSync(p, 'utf8');
    const raw = body(file);
    const lower = norm(raw);
    /* Номер строки — в файле, а не в теле: редактор откроет файл, где
     * frontmatter на месте, и «строка 104» без этой поправки укажет на
     * чужой абзац. */
    const fmLines = file.slice(0, file.length - raw.length).split('\n').length - 1;
    const lineOf = (idx) => raw.slice(0, idx).split('\n').length + fmLines;

    for (const f of facts) {
      if (f.kind === 'value') {
        const current = digits(f.value);
        if (current && lower.includes(norm(f.value).replace(/\s+/g, ' '))) usage.get(f.id).push(slug);

        for (const s of f.supersedes || []) {
          const old = norm(s.value);
          if (!old) continue;
          let from = 0;
          for (;;) {
            const i = lower.indexOf(old, from);
            if (i === -1) break;
            from = i + old.length;
            if (looksHistorical(lower, i)) continue;
            conflicts.push({
              slug, factId: f.id, line: lineOf(i),
              problem: `прежнее значение «${s.value}» подано как действующее. `
                + `Актуальное — «${f.value}» (${s.by}). ${f.scope}`,
            });
          }
        }
        continue;
      }

      /* kind: rule */
      const detect = new RegExp(f.detect, 'giu');
      const hits = [...raw.matchAll(detect)];
      if (!hits.length) continue;
      usage.get(f.id).push(slug);
      for (const bad of f.contradicts || []) {
        const re = new RegExp(bad, 'giu');
        for (const m of raw.matchAll(re)) {
          conflicts.push({
            slug, factId: f.id, line: lineOf(m.index),
            problem: `статья утверждает «${String(m[0]).slice(0, 60)}», что противоречит реестру: ${f.statement}`,
          });
        }
      }
    }
  }

  /* Запись, на которую никто не ссылается, — не ошибка корпуса, но и не
   * повод молчать: либо статью удалили, либо реестр описывает то, о чём
   * мы не пишем. */
  for (const [id, list] of usage) usage.set(id, [...new Set(list)]);

  return { conflicts, usage, facts: facts.length };
}

/* ── CLI ────────────────────────────────────────────────────────────── */

if (isMain(import.meta.url)) {
  const { facts, exists, broken } = loadRegistry();
  if (!exists) {
    console.log('Реестра фактов нет — сверять корпус не с чем.');
    console.log(`Создайте ${REGISTRY}: одна запись на норму, которая встречается больше чем в одной статье.`);
    process.exit(0);
  }
  if (broken) { console.error(`✖ Реестр не разбирается: ${broken}`); process.exit(2); }

  const form = validateRegistry(facts);
  if (form.length) {
    console.error(`✖ Реестр не проходит форму — ${form.length} замечаний:`);
    for (const p of form) console.error(`    [${p.id}] ${p.problem}`);
    process.exit(1);
  }

  /* --verify. Отдельный проход с сетью: цитата сверяется с живой
   * страницей, а отпечаток — с записанным. Не в обычном прогоне, потому
   * что CI без сети должен работать; но и не «когда-нибудь», потому что
   * норма меняется без предупреждения. */
  if (process.argv.includes('--verify')) {
    const { fetchSnapshot, quoteInSnapshot } = await import('./snapshot.mjs');
    let bad = 0;
    for (const f of facts) {
      const e = f.evidence;
      const snap = await fetchSnapshot(e.url);
      if (!snap.ok) { bad++; console.log(`  ✖ ${f.id} — источник недоступен: ${snap.error ?? snap.status}`); continue; }
      const q = quoteInSnapshot(snap.text, e.quote);
      if (!q.found) { bad++; console.log(`  ✖ ${f.id} — цитаты на странице нет: ${q.reason}`); continue; }
      if (snap.hash !== e.snapshotHash) {
        bad++;
        console.log(`  ! ${f.id} — страница изменилась с ${e.retrievedAt}: цитата на месте, но отпечаток другой`);
        console.log(`      было ${e.snapshotHash}\n      стало ${snap.hash}`);
        continue;
      }
      console.log(`  ✓ ${f.id}`);
    }
    console.log(bad ? `\n✖ Требуют внимания: ${bad}` : '\n✓ Все записи сверены с первоисточниками.');
    process.exit(bad ? 1 : 0);
  }

  const { conflicts, usage } = checkCorpus();
  console.log(`Записей в реестре: ${facts.length}\n`);
  for (const f of facts) {
    const used = usage.get(f.id) ?? [];
    console.log(`  ${used.length ? '✓' : '·'} ${f.id} — статей: ${used.length || 'ни одной'}`);
  }

  /* Запись, на которую никто не ссылается, — не поломка корпуса, но
   * сигнал: либо статью удалили, либо реестр описывает то, о чём мы не
   * пишем, и тогда он не защищает ничего. */
  const unused = facts.filter((f) => !(usage.get(f.id) ?? []).length);
  if (unused.length) {
    console.log(`\n  Ни одной статьи не нашлось для записей: ${unused.map((f) => f.id).join(', ')}`);
    console.log('  Проверьте detect либо удалите запись — реестр, который ничего не покрывает, ничего и не защищает.');
  }

  if (!conflicts.length) {
    console.log('\n✓ Противоречий между статьями нет.');
    process.exit(0);
  }
  console.log(`\n✖ Противоречий с реестром — ${conflicts.length}:`);
  for (const c of conflicts) {
    console.log(`  ${c.slug} (строка ${c.line}) [${c.factId}]`);
    console.log(`      ${c.problem}`);
  }
  console.log('\n  Одна норма — одно значение в корпусе. Поправьте статью либо запись реестра,');
  console.log('  если изменился первоисточник.');
  process.exit(1);
}
