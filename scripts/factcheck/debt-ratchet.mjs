#!/usr/bin/env node
/**
 * Храповик долга: показатели замкнутости могут только уменьшаться.
 *
 * Зачем. Метрики I-02 печатались в `health` как предупреждения, и
 * предупреждение — это то, мимо чего проходят. 1016 неклассифицированных
 * единиц текста и 127 утверждений без исхода могли расти месяцами, и
 * каждый отдельный прогон выглядел бы одинаково: «11 warn, 0 fail».
 * Долг, у которого нет направления, — не долг, а фон.
 *
 * Храповик задаёт направление: записанное значение — потолок. Стало
 * меньше — потолок опускается (`--seal`). Стало больше — красное.
 *
 * Про «а файл можно просто поправить». Можно, и в этом суть: запрет
 * должен быть заметным, а не непреодолимым. Поэтому расширение потолка
 * — не правка числа, а отдельная команда `--accept "<причина>"`, которая
 * дописывает уступку в журнал: дата, показатель, было-стало, причина.
 * Журнал только растёт — это проверяется тестом против закоммиченной
 * версии. Отредактировать число в обход можно, но тогда в диффе видно
 * изменение потолка без записи в журнале, и это ровно тот сигнал,
 * который нужен ревью.
 *
 * Использование:
 *   node scripts/factcheck/debt-ratchet.mjs            # где мы сейчас
 *   node scripts/factcheck/debt-ratchet.mjs --check    # exit 1 при росте
 *   node scripts/factcheck/debt-ratchet.mjs --seal     # опустить потолок
 *   node scripts/factcheck/debt-ratchet.mjs --accept "почему долг вырос"
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { closureMetrics } from './metrics.mjs';

const ROOT = process.env.FACTCHECK_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const RATCHET = 'src/data/factcheck/debt-ratchet.json';

/** Показатели, у которых есть направление. Все — «чем меньше, тем лучше». */
export const TRACKED = [
  ['unchecked', 'статей без разбора вовсе'],
  ['unclassifiedUnits', 'неклассифицированных единиц текста'],
  ['orphans', 'утверждений без исхода'],
  ['unlinked', 'утверждений без привязки к реестру'],
  ['wrongTarget', 'ссылок в чужое утверждение'],
  ['danglingId', 'ссылок в никуда'],
  ['coverageMissing', 'значений статьи вне отчёта'],
  ['coveragePartial', 'разобранных не целиком'],
  ['coverageConflicting', 'утверждений против статьи'],
  ['weakEvidence', 'замечаний к доказательствам'],
  ['allowlistDebt', 'статей в списке исключений'],
];

export const ratchetPath = (root = ROOT) => join(root, RATCHET);

export function loadRatchet(root = ROOT) {
  const p = ratchetPath(root);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { broken: true }; }
}

/**
 * Сравнить текущие показатели с потолком.
 *
 * @returns {{grown: Array, shrunk: Array, same: number, current: object}}
 */
export function compare(root = ROOT) {
  const m = closureMetrics(root);
  const prev = loadRatchet(root);
  const ceiling = prev?.metrics ?? {};
  const grown = [];
  const shrunk = [];
  let same = 0;

  for (const [key, label] of TRACKED) {
    const now = Number(m[key] ?? 0);
    const was = ceiling[key];
    if (was === undefined) { grown.push({ key, label, was: null, now }); continue; }
    if (now > was) grown.push({ key, label, was, now });
    else if (now < was) shrunk.push({ key, label, was, now });
    else same += 1;
  }
  return { grown, shrunk, same, current: Object.fromEntries(TRACKED.map(([k]) => [k, Number(m[k] ?? 0)])) };
}

const today = () => new Date().toISOString().slice(0, 10);

function write(root, data) {
  writeFileSync(ratchetPath(root), `${JSON.stringify(data, null, 2)}\n`);
}

/* ── CLI ────────────────────────────────────────────────────────────── */

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const prev = loadRatchet(ROOT);
  if (prev?.broken) { console.error('✖ Файл храповика не разбирается'); process.exit(2); }

  const r = compare(ROOT);

  /* Пустой корпус даёт нули по всем показателям и выглядит как
   * идеально закрытый долг. Это тот же обход, что и в audit-bundles:
   * «нечего проверять» не равно «всё проверено». */
  if (closureMetrics(ROOT).articles === 0) {
    console.error('✖ В корпусе нет статей — показатели замкнутости считать не по чему.');
    console.error('  Нули на пустом корпусе означают битый checkout, а не закрытый долг.');
    process.exit(1);
  }
  const show = (list) => list.map((x) => `${x.label}: ${x.was ?? '—'} → ${x.now}`).join('\n      ');

  /* Первая запись: потолок ставится по текущему состоянию. Это не
   * «принять долг», а зафиксировать точку отсчёта — раньше её не было
   * вовсе, и любое число выглядело нормальным. */
  if (!prev) {
    if (!args.includes('--seal')) {
      console.log('Храповика ещё нет — зафиксировать текущее состояние: --seal');
      for (const [k, label] of TRACKED) console.log(`  ${String(r.current[k]).padStart(5)}  ${label}`);
      process.exit(args.includes('--check') ? 1 : 0);
    }
    write(ROOT, { schemaVersion: 1, sealedAt: today(), metrics: r.current, concessions: [] });
    console.log(`✓ Потолок зафиксирован ${today()}`);
    process.exit(0);
  }

  if (args.includes('--check')) {
    if (!r.grown.length) {
      console.log(`✓ Долг не вырос (снизилось показателей: ${r.shrunk.length}, без изменений: ${r.same}).`);
      if (r.shrunk.length) console.log(`      ${show(r.shrunk)}\n  Опустить потолок: --seal`);
      process.exit(0);
    }
    console.error(`✖ Долг вырос по ${r.grown.length} показателям:\n      ${show(r.grown)}`);
    console.error('\n  Долг может только сокращаться. Либо починить, либо принять осознанно:');
    console.error('    node scripts/factcheck/debt-ratchet.mjs --accept "почему это допустимо"');
    process.exit(1);
  }

  const ai = args.indexOf('--accept');
  if (ai !== -1) {
    const reason = args[ai + 1];
    if (!reason || reason.startsWith('--')) {
      console.error('✖ --accept требует причину: --accept "почему долг вырос"');
      process.exit(2);
    }
    if (!r.grown.length) { console.log('Долг не вырос — принимать нечего.'); process.exit(0); }
    prev.concessions = [...(prev.concessions ?? []), {
      at: today(), reason, grown: r.grown.map(({ key, was, now }) => ({ key, was, now })),
    }];
    prev.metrics = r.current;
    prev.sealedAt = today();
    write(ROOT, prev);
    console.log(`✓ Уступка записана: ${reason}`);
    console.log(`      ${show(r.grown)}`);
    console.log('  Запись в журнале остаётся навсегда — журнал только растёт.');
    process.exit(0);
  }

  if (args.includes('--seal')) {
    if (r.grown.length) {
      console.error(`✖ Опустить потолок нельзя: долг вырос по ${r.grown.length} показателям:\n      ${show(r.grown)}`);
      console.error('  Сначала починить либо принять: --accept "<причина>"');
      process.exit(1);
    }
    prev.metrics = r.current;
    prev.sealedAt = today();
    write(ROOT, prev);
    console.log(`✓ Потолок опущен (${r.shrunk.length} показателей ниже прежнего).`);
    if (r.shrunk.length) console.log(`      ${show(r.shrunk)}`);
    process.exit(0);
  }

  console.log(`Потолок зафиксирован ${prev.sealedAt}, уступок в журнале: ${(prev.concessions ?? []).length}\n`);
  for (const [k, label] of TRACKED) {
    const was = prev.metrics?.[k];
    const now = r.current[k];
    const mark = now > was ? '✖' : now < was ? '↓' : ' ';
    console.log(`  ${mark} ${String(now).padStart(5)}  ${label}${now === was ? '' : ` (потолок ${was ?? '—'})`}`);
  }
  process.exit(0);
}
