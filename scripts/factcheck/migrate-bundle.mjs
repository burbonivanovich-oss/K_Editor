#!/usr/bin/env node
/**
 * Миграция факчек-связок на текущий контракт — механическая часть.
 *
 * Что скрипт делает и, главное, чего он НЕ делает.
 *
 * Делает то, что выводится из уже существующих данных: проставляет
 * `schemaVersion`, привязывает отчёт к версии текста (`articleHash`,
 * `articleNormHash`), переносит версию редполитики из старого поля
 * `rulesVersion` в `policyVersion`, раздаёт утверждениям недостающие
 * `id` по позиции, пересчитывает `summary` из самих утверждений и
 * перевыписывает маркер с `reportHash`/`claimsHash` и вердиктом,
 * который из этих утверждений следует.
 *
 * НЕ делает — и не должен — главного: не придумывает доказательства.
 * Пропущенные `statement`, дословная цитата первоисточника и ссылка на
 * него — это результат проверки факта, а не форматирования. Их
 * подставить неоткуда: 444 замечания корпуса — нарушения доказательного
 * формата, и закрыть их может только настоящий прогон `/factcheck` по
 * первоисточникам. Скрипт после миграции печатает, чего именно не
 * хватает по каждой статье, чтобы эти прогоны можно было спланировать,
 * а не гадать.
 *
 * Привязка к тексту делается только тогда, когда старый маркер сходится
 * с текущим файлом: тогда «отчёт про этот текст» — не предположение, а
 * то, что маркер и утверждал. Не сходится — статья правилась после
 * факчека, и мигрировать нечего: нужен полный факчек.
 *
 * Запуск:
 *   node scripts/factcheck/migrate-bundle.mjs            # что будет сделано
 *   node scripts/factcheck/migrate-bundle.mjs --apply    # сделать
 *   node scripts/factcheck/migrate-bundle.mjs --todo     # чего не хватает для зелёного
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { SCHEMA_VERSION, computeOutcome, outcomeToResult } from './report-schema.mjs';
import { articleHash, articleNormHash, reportHash, claimsHash } from './hashes.mjs';
import { checkReportFull, PRIMARY_DOMAINS } from './check-report.mjs';
import { linkByRaw } from './ledger.mjs';
import { riskOf } from './risk.mjs';
import { checkCoverage } from './check-coverage.mjs';

const ROOT = process.env.FACTCHECK_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLOG = join(ROOT, 'src/content/blog');
const RESULTS = join(ROOT, 'src/data/factcheck/results');
const MARKERS = join(ROOT, '.claude/factchecked');

const readArticle = (slug) => {
  for (const ext of ['.md', '.mdx']) {
    const p = join(BLOG, `${slug}${ext}`);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
};

/** Что мигрируем: у статьи есть и маркер, и отчёт. */
export function migratable(root = ROOT) {
  const dir = join(root, 'src/content/blog');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.mdx?$/.test(f))
    .map((f) => f.replace(/\.mdx?$/, ''));
}

/**
 * Механическая миграция одной связки.
 * @returns {{slug, done: string[], blocked: string|null, report, marker}}
 */
export function migrateOne(slug, { root = ROOT } = {}) {
  const done = [];
  const stop = (reason) => ({ slug, done, blocked: reason, report: null, marker: null });

  const raw = (() => {
    for (const ext of ['.md', '.mdx']) {
      const p = join(root, 'src/content/blog', `${slug}${ext}`);
      if (existsSync(p)) return readFileSync(p, 'utf8');
    }
    return null;
  })();
  if (raw === null) return stop('статьи нет на диске');

  const markerPath = join(root, '.claude/factchecked', slug);
  if (!existsSync(markerPath)) return stop('маркера нет — мигрировать нечего, нужен полный факчек');
  let marker;
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { return stop('маркер повреждён'); }

  const reportRel = marker.report || `src/data/factcheck/results/${slug}.json`;
  const reportPath = join(root, reportRel);
  if (!existsSync(reportPath)) return stop(`отчёта ${reportRel} нет — нужен полный факчек`);
  let report;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { return stop('отчёт не разбирается'); }

  /* Привязать отчёт к тексту можно только если старый маркер сходится с
   * текущим файлом: именно это он и утверждал. Иначе статью правили
   * после факчека, и утверждать «отчёт про этот текст» нельзя. */
  const current = articleHash(raw);
  if (marker.hash && marker.hash !== current) {
    return stop('статья правилась после факчека (хеш маркера не сходится) — мигрировать нечего, нужен полный факчек');
  }

  if (report.schemaVersion !== SCHEMA_VERSION) { report.schemaVersion = SCHEMA_VERSION; done.push('schemaVersion'); }
  if (!report.articleHash) { report.articleHash = current; done.push('articleHash'); }
  if (!report.articleNormHash) { report.articleNormHash = articleNormHash(raw); done.push('articleNormHash'); }
  const policyVersion = report.policyVersion || marker.policyVersion || marker.rulesVersion || null;
  if (policyVersion && report.policyVersion !== policyVersion) { report.policyVersion = policyVersion; done.push('policyVersion'); }
  if (!report.checkedAt && marker.date) { report.checkedAt = marker.date; done.push('checkedAt'); }

  /* id внутри отчёта — адрес, а не ссылка.
   *
   * Раньше здесь стояла раздача по позиции: `c${i+1}` для каждого
   * утверждения без id. Выглядело безобидно («порядок уже зафиксирован
   * файлом»), а на деле создало 159 ложных ссылок: пространство `c1…cN`
   * уже занято нумерацией извлечения, и раздача по позиции сделала так,
   * что чужой id резолвится. До неё связи не было и это было видно;
   * после — связь есть и она неверна.
   *
   * Поэтому теперь: id раздаётся в собственном пространстве (`r*`), а
   * ссылка в реестр — отдельным полем `claimId` и только по совпадению
   * текста. Не совпало — поле остаётся пустым, и реестр честно
   * показывает утверждение как непривязанное. */
  let idsAdded = 0;
  (report.claims || []).forEach((c, i) => {
    if (c && !c.id) { c.id = `r${i + 1}`; idsAdded++; }
  });
  if (idsAdded) done.push(`id для ${idsAdded} утверждений (пространство отчёта, не реестра)`);

  /* Связка с реестром извлечения (H-01). Подбирается по тексту: связь
   * между двумя списками существует по смыслу, её просто никогда не
   * записывали. Неоднозначное не привязываем — это решение человека. */
  const extractionPath = join(root, 'src/data/factcheck/claims', `${slug}.json`);
  if (existsSync(extractionPath)) {
    try {
      const extraction = JSON.parse(readFileSync(extractionPath, 'utf8'));
      const link = linkByRaw(extraction.claims || [], report.claims || []);
      if (link.linked) done.push(`claimId подобран для ${link.linked} утверждений`);
      if (link.ambiguous.length) done.push(`claimId неоднозначен у ${link.ambiguous.length} — решает человек`);
      if (link.unlinked.length) done.push(`claimId не найден у ${link.unlinked.length} — утверждения нет в реестре извлечения`);
    } catch { /* реестр нечитаем — связку не выдумываем */ }
  }

  const outcome = computeOutcome(report.claims);
  const declared = report.summary?.overallStatus;
  report.summary = outcome;
  if (declared !== outcome.overallStatus) done.push(`summary пересчитан: «${declared ?? 'нет'}» → «${outcome.overallStatus}»`);

  const text = JSON.stringify(report, null, 2) + '\n';
  const newMarker = {
    schemaVersion: SCHEMA_VERSION,
    date: marker.date,
    hash: current,
    result: outcomeToResult(outcome),
    criticalMismatches: outcome.criticalIssues,
    policyVersion,
    reportHash: reportHash(text),
    claimsHash: claimsHash(report.claims),
    report: reportRel,
  };
  if (marker.result !== newMarker.result) done.push(`вердикт маркера: «${marker.result}» → «${newMarker.result}»`);

  return { slug, done, blocked: null, report, marker: newMarker, text, reportPath, markerPath };
}

/** Чего не хватает связке до зелёного — по классам работы, а не списком строк. */
export function todo(slug, { root = ROOT } = {}) {
  const raw = (() => {
    for (const ext of ['.md', '.mdx']) {
      const p = join(root, 'src/content/blog', `${slug}${ext}`);
      if (existsSync(p)) return readFileSync(p, 'utf8');
    }
    return null;
  })();
  const reportPath = join(root, 'src/data/factcheck/results', `${slug}.json`);
  if (raw === null || !existsSync(reportPath)) return null;
  let report;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { return null; }

  const claims = report.claims || [];
  const risky = claims.filter((c) => riskOf(c).strict && c.status === 'match');
  const primary = (u) => PRIMARY_DOMAINS.some((d) => String(u).includes(d));

  return {
    slug,
    claims: claims.length,
    risky: risky.length,
    noStatement: risky.filter((c) => !String(c.statement || '').trim()).length,
    noQuote: risky.filter((c) => !String(c.quote || '').trim()
      && !(c.evidence || []).some((e) => String(e?.quote || '').trim())).length,
    noPrimarySource: risky.filter((c) => !(c.sources || []).some(primary)
      && !(c.evidence || []).some((e) => e?.kind === 'primary' && primary(e.url))).length,
    /* D-02: доказательство происхождения — отдельный класс работы.
     * Цитата в поле `quote` без локатора, даты обращения и отпечатка не
     * говорит, что её действительно взяли с этой страницы. */
    noEvidence: risky.filter((c) => !(c.evidence || []).length).length,
    coverageGaps: checkCoverage(raw, report).missing.length,
    problems: checkReportFull(report, slug).length,
  };
}

if (isMain(import.meta.url)) {
  const apply = process.argv.includes('--apply');
  const asTodo = process.argv.includes('--todo');
  const asLink = process.argv.includes('--link');
  const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const slugs = (only ? [only] : migratable()).filter(Boolean);

  /* --link. Отдельный проход, потому что связка отчёта с реестром
   * извлечения (H-01) не зависит ни от маркера, ни от его хеша: это
   * связь двух файлов между собой. Обычная миграция отказывается
   * работать без валидного маркера — и правильно делает, — но связку
   * это блокировать не должно. */
  if (asLink) {
    let linked = 0; let ambiguous = 0; let unlinked = 0; let touched = 0; let repaired = 0;
    for (const slug of slugs) {
      const reportPath = join(ROOT, 'src/data/factcheck/results', `${slug}.json`);
      const extractionPath = join(ROOT, 'src/data/factcheck/claims', `${slug}.json`);
      if (!existsSync(reportPath) || !existsSync(extractionPath)) continue;
      let report; let extraction;
      try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'));
        extraction = JSON.parse(readFileSync(extractionPath, 'utf8'));
      } catch { console.log(`  ✖ ${slug} — файл не разбирается`); continue; }

      const before = JSON.stringify(report);
      const r = linkByRaw(extraction.claims || [], report.claims || []);
      linked += r.linked; ambiguous += r.ambiguous.length; unlinked += r.unlinked.length; repaired += r.repaired;
      console.log(`  ${slug}\n      привязано ${r.linked} · снято битых ${r.repaired} · неоднозначно ${r.ambiguous.length} · нет в реестре ${r.unlinked.length}`);
      for (const a of r.ambiguous) console.log(`      ? ${a.id} «${String(a.raw).slice(0, 40)}» → ${a.candidates.join(', ')}`);
      for (const u of r.unlinked) console.log(`      – ${u.id} «${String(u.raw).slice(0, 40)}» — в реестре извлечения такого места нет`);
      if (apply && JSON.stringify(report) !== before) {
        writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
        touched++;
      }
    }
    console.log(`\n  Привязано ${linked}, снято битых ссылок ${repaired}, неоднозначно ${ambiguous}, нет в реестре ${unlinked}.`);
    console.log(apply ? `  Записано отчётов: ${touched}.` : '  Применить: --link --apply');
    console.log('  Оставшееся закрывается решением человека: либо merge утверждения в реестр,');
    console.log('  либо запись в ledger (skipped с причиной или duplicateOf).');
    process.exit(0);
  }

  if (asTodo) {
    console.log('Что осталось сделать руками — это работа /factcheck по первоисточникам,\n'
      + 'механически не выводится:\n');
    let totalRisky = 0;
    for (const slug of slugs) {
      const t = todo(slug);
      if (!t) { console.log(`  ? ${slug} — отчёта нет`); continue; }
      totalRisky += t.noStatement + t.noQuote + t.noPrimarySource + t.noEvidence + t.coverageGaps;
      console.log(`  ${slug}`);
      console.log(`      утверждений ${t.claims}, из них значимых ${t.risky}`);
      console.log(`      без формулировки ${t.noStatement} · без цитаты ${t.noQuote} · без первоисточника ${t.noPrimarySource}`);
      console.log(`      без доказательства происхождения ${t.noEvidence}`);
      console.log(`      значений статьи вне отчёта ${t.coverageGaps} · всего замечаний ${t.problems}`);
    }
    console.log(`\n  Итого работы по существу: ${totalRisky} пунктов.`);
    console.log('  Каждый закрывается прогоном /factcheck <slug> — сверкой с первоисточником,');
    console.log('  а не правкой файла: цитату и ссылку неоткуда взять, кроме как из НПА.');
    process.exit(0);
  }

  let changed = 0;
  let blocked = 0;
  for (const slug of slugs) {
    const r = migrateOne(slug);
    if (r.blocked) { console.log(`  ✖ ${slug} — ${r.blocked}`); blocked++; continue; }
    if (!r.done.length) { console.log(`  · ${slug} — уже по контракту`); continue; }
    changed++;
    console.log(`  ${apply ? '✓' : '→'} ${slug}: ${r.done.join(', ')}`);
    if (apply) {
      writeFileSync(r.reportPath, r.text);
      writeFileSync(r.markerPath, JSON.stringify(r.marker, null, 2) + '\n');
    }
  }
  console.log(`\n${apply ? 'Мигрировано' : 'Будет мигрировано'}: ${changed}${blocked ? `, не поддаётся: ${blocked}` : ''}.`);
  console.log('Механическая часть не делает связку зелёной — доказательства остаются работой /factcheck.');
  console.log('Что именно осталось: node scripts/factcheck/migrate-bundle.mjs --todo');
  if (!apply && changed) console.log('Применить: node scripts/factcheck/migrate-bundle.mjs --apply');
  process.exit(0);
}
