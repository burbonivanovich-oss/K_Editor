#!/usr/bin/env node
/**
 * Сборка отчёта факчека из файла фактов.
 *
 * Зачем инструмент, а не скрипт под каждую статью. Миграция девяти
 * связок на новый контракт началась с одноразового скрипта: список
 * фактов, цикл, запись JSON. На второй статье выяснилось, что скрипт
 * копируется целиком ради двадцати строк данных, и каждая копия
 * расходится с остальными — в одной снимок сверяется, в другой нет, в
 * третьей реестр замыкается наполовину. Разовый скрипт не оставляет
 * следа: через месяц непонятно, чем собран отчёт и почему в нём такие
 * решения.
 *
 * Разделение простое. Редакционное суждение — что утверждается, чем
 * доказывается, какие места статьи это закрывает — лежит данными в
 * `src/data/factcheck/facts/<slug>.facts.json`. Механика — привязка к
 * реестру, сверка цитаты со снимком, замыкание леджера, классификация
 * единиц — здесь и одна на все статьи.
 *
 * Главное правило: статус утверждения назначает не автор файла фактов,
 * а результат сверки. Цитата нашлась в снимке — `match`; не нашлась —
 * `uncertain` с причиной. Иначе «проверено» снова становится словом,
 * которое пишут, а не считают.
 *
 * Использование:
 *   node scripts/factcheck/build-report.mjs <slug>
 *   node scripts/factcheck/build-report.mjs <slug> --dry   # не записывать
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { textUnits } from './classify.mjs';
import { computeOutcome, SCHEMA_VERSION } from './report-schema.mjs';
import { articleHash, articleNormHash } from './hashes.mjs';
import { loadSnapshot, quoteInSnapshot, fetchSnapshot, saveSnapshot } from './snapshot.mjs';

const ROOT = process.env.FACTCHECK_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const factsPath = (root, slug) => join(root, 'src/data/factcheck/facts', `${slug}.facts.json`);

const norm = (s) => String(s ?? '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/* Уверенность — не украшение рядом со статусом, а то, что проверяется:
 * `check-report.mjs` требует для critical не меньше 0.9. Значение
 * назначается по роли источника, а не по настроению автора файла. */
const CONFIDENCE = { norm: 0.95, officialGuidance: 0.9, vendorDoc: 0.8, vendorTerms: 0.8, secondary: 0.6 };

/**
 * Собрать отчёт.
 *
 * @param {object} o
 * @param {string} o.raw — текст статьи.
 * @param {object} o.extraction — реестр извлечения.
 * @param {object} o.facts — файл фактов.
 * @param {(url: string) => {ok: boolean, text?: string, hash?: string, error?: any}} o.snapshotFor
 * @returns {{report: object, log: Array<{key: string, found: boolean, places: number, reason?: string}>}}
 */
export function buildReport({ raw, extraction, facts, snapshotFor }) {
  const units = textUnits(raw);
  /* Устаревшие записи реестра — те, чьей цитаты в тексте больше нет.
   * Ссылаться на них нельзя: `checkLedger` считает живыми только
   * не-stale, и ссылка в такую запись резолвится у сборщика, но не у
   * проверки. Разойтись здесь значит собрать отчёт, который сам себя
   * не проходит. */
  const live = (extraction.claims || []).filter((c) => !c.stale);
  const claims = [];
  const ledger = {};
  const used = new Set();
  const log = [];
  let n = 0;

  for (const f of facts.facts) {
    /* Все места статьи, которые закрывает этот факт. Первое становится
     * адресом утверждения, остальные — его дубликатами: две записи об
     * одном факте это не две проверки. */
    const mine = live.filter((c) => !used.has(c.id)
      && (f.covers || []).some((cv) => norm(c.raw) === norm(cv)));

    const snap = snapshotFor(f.url);
    /* Одно утверждение — иногда две цитаты. Норматив ожидания стоит в
     * пункте 16, а правило, что делать при его истечении, — в пункте
     * 17: доказать нужно оба, и подтверждением считается только их
     * совпадение целиком. Частично найденная связка — не проверка. */
    const parts = f.quotes ?? [{ quote: f.quote, locator: f.locator }];
    const checked = parts.map((part) => ({
      part,
      hit: snap?.ok
        ? quoteInSnapshot(snap.text, part.quote)
        : { found: false, reason: snap?.error ?? 'источник недоступен' },
    }));
    const missed = checked.find((c) => !c.hit.found);
    const found = missed ? { found: false, reason: missed.hit.reason } : { found: true };

    const owner = mine[0];
    const spanUnit = units.find((u) => owner && u.text.includes(String(owner.raw)));
    const id = `r${++n}`;

    const claim = {
      id,
      claimId: owner ? owner.id : undefined,
      /* Тип описывает raw, а raw приходит из реестра. Назначать тип
       * отдельно значит завести второй источник правды и разойтись с
       * ним на первом же утверждении. */
      type: owner ? owner.type : f.type,
      /* Запасной `raw` берётся из первой цитаты — но у факта с
       * несколькими цитатами поля `quote` нет вовсе, и обращение к
       * нему роняло сборку целиком. Падать на форме записи, когда
       * данных достаточно, — худший из возможных отказов: он выглядит
       * поломкой инструмента, а не отсутствием owner'а. */
      raw: owner ? owner.raw : (f.raw ?? String(f.quote ?? f.quotes?.[0]?.quote ?? f.key).slice(0, 40)),
      statement: f.statement,
      subject: f.subject,
      modality: f.modality,
      negated: f.negated ?? false,
      conditions: f.conditions,
      effectiveFrom: f.effectiveFrom,
      span: spanUnit ? spanUnit.id : undefined,
      status: found.found ? 'match' : 'uncertain',
      severity: f.severity ?? 'moderate',
      confidence: found.found ? (CONFIDENCE[f.role] ?? 0.6) : 0.5,
      explanation: found.found ? f.explanation : undefined,
      /* Доказательство появляется только тогда, когда цитата нашлась в
       * снимке. Приложить его «как есть» к неподтверждённому
       * утверждению — та же битая ссылка: она резолвится, выглядит
       * проверкой и молча закрывает вопрос. Место, где искали, остаётся
       * в `sources`: это адрес поиска, а не доказательство. */
      evidence: found.found ? checked.map(({ part }) => ({
        /* `snippet` — выдержка не из самого документа: обзор, аннотация,
         * разъяснение. Отдельного kind под роль источника нет, и заводить
         * его незачем: роль уже названа в sourceRole. */
        kind: f.role === 'secondary' ? 'snippet' : 'primary',
        sourceRole: f.role,
        url: f.url,
        locator: part.locator ?? f.locator,
        retrievedAt: facts.retrievedAt,
        effectiveAsOf: facts.retrievedAt,
        effectiveTo: null,
        snapshotHash: snap?.hash ?? undefined,
        quote: part.quote,
        scope: f.scope,
      })) : [],
      sources: [f.url],
      /* Незакрытое утверждение просит источник, а не переписывание:
       * «проверить» — это работа с источником, и правка текста здесь
       * была бы решением до выяснения. */
      action: found.found ? 'keep' : 'add-references',
      /* Незакрытое утверждение обязано называть, чего не хватает.
       * «Требует проверки» без продолжения — это то же молчание,
       * только с галочкой. */
      actionDetail: found.found ? undefined
        : (f.gap ?? `цитата не подтверждена снимком: ${found.reason}`),
    };
    for (const k of Object.keys(claim)) if (claim[k] === undefined) delete claim[k];
    claims.push(claim);

    for (const c of mine) used.add(c.id);
    for (const c of mine.slice(1)) ledger[c.id] = { outcome: 'duplicateOf', of: owner.id };
    log.push({ key: f.key, found: !!found.found, places: mine.length, reason: found.reason });
  }

  /* Остальные извлечённые утверждения — решения, а не молчание. */
  const skipRules = (facts.skip || []).map(([re, why]) => [new RegExp(re), why]);
  for (const c of live) {
    if (used.has(c.id) || ledger[c.id]) continue;
    const rule = skipRules.find(([re]) => re.test(String(c.raw)));
    ledger[c.id] = {
      outcome: 'skipped',
      reason: rule ? rule[1] : `значение «${String(c.raw).slice(0, 30)}» разбирается утверждением о том же факте выше`,
    };
  }

  /* Классификация: единица с цитатой утверждения — факт, остальное —
   * связующий текст с причиной, по виду единицы. */
  const unitsTable = {};
  const spans = new Set(claims.map((c) => c.span).filter(Boolean));
  const REASON = {
    heading: 'заголовок раздела',
    'table-row': 'строка таблицы: значения из неё разобраны утверждениями отчёта',
    'list-item': 'пункт списка: шаг процедуры без проверяемого значения',
    sentence: 'связующий текст без проверяемого значения',
  };
  for (const u of units) {
    unitsTable[u.id] = spans.has(u.id)
      ? { class: 'factual' }
      : { class: 'non_factual', reason: REASON[u.kind] ?? REASON.sentence };
  }

  const report = {
    schemaVersion: SCHEMA_VERSION,
    policyVersion: facts.policyVersion,
    articleHash: articleHash(raw),
    articleNormHash: articleNormHash(raw),
    checkedAt: facts.retrievedAt,
    checkedBy: facts.checkedBy,
    reviewedBy: facts.reviewedBy,
    claims,
    ledger,
    units: unitsTable,
    summary: computeOutcome(claims),
  };
  return { report, log };
}

/* ── CLI ────────────────────────────────────────────────────────────── */

if (isMain(import.meta.url)) {
  const [slug, ...rest] = process.argv.slice(2);
  if (!slug) { console.error('Использование: build-report.mjs <slug> [--dry]'); process.exit(2); }

  const fp = factsPath(ROOT, slug);
  if (!existsSync(fp)) {
    console.error(`✖ Нет файла фактов ${fp}`);
    console.error('  Отчёт собирается из фактов, а не из воздуха: сначала редакционная работа.');
    process.exit(1);
  }
  const facts = JSON.parse(readFileSync(fp, 'utf8'));
  const articlePath = ['.md', '.mdx'].map((e) => join(ROOT, 'src/content/blog', slug + e)).find(existsSync);
  if (!articlePath) { console.error(`✖ Нет статьи ${slug}`); process.exit(1); }
  const raw = readFileSync(articlePath, 'utf8');
  const extraction = JSON.parse(readFileSync(join(ROOT, 'src/data/factcheck/claims', `${slug}.json`), 'utf8'));

  /* Снимок сначала ищем в хранилище: сверка обязана работать без сети,
   * иначе проверка зависит от того, доступен ли сайт сегодня. */
  const cache = new Map();
  for (const f of facts.facts) {
    if (cache.has(f.url)) continue;
    if (f.snapshotHash) {
      /* `loadSnapshot` возвращает текст без хеша — искать его незачем,
       * это имя файла. Дописываем явно: дальше хеш уходит в отчёт, и
       * без него доказательство считается неподтверждённым. */
      const s = loadSnapshot(ROOT, f.snapshotHash);
      if (s.ok) { cache.set(f.url, { ...s, hash: f.snapshotHash }); continue; }
      console.error(`  ! ${f.key}: снимка ${String(f.snapshotHash).slice(0, 12)} нет в хранилище — тяну заново`);
    }
    const s = await fetchSnapshot(f.url);
    if (s.ok) saveSnapshot(ROOT, s.text);
    cache.set(f.url, s);
  }

  const { report, log } = buildReport({ raw, extraction, facts, snapshotFor: (u) => cache.get(u) });
  for (const l of log) {
    console.log(`${l.found ? '✓' : '✖'} ${l.key.padEnd(26)} мест ${String(l.places).padStart(2)}${l.found ? '' : `  ${l.reason}`}`);
  }
  console.log(`\nутверждений ${report.claims.length}, решений реестра ${Object.keys(report.ledger).length}, единиц текста ${Object.keys(report.units).length}`);
  console.log('итог:', JSON.stringify(report.summary));

  if (rest.includes('--dry')) { console.log('\n(--dry: файл не записан)'); process.exit(0); }
  writeFileSync(join(ROOT, 'src/data/factcheck/results', `${slug}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n✓ src/data/factcheck/results/${slug}.json`);
}
