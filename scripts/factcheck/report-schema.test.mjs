// Тесты схемы отчёта: закрытые enum, обязательные поля, итог из claims.
//
// Схема существует потому, что её отсутствие делало отчёт тем «чище»,
// чем хуже он заполнен: незнакомый статус читался как неопасный,
// отсутствующий confidence отменял правило про согласованность
// уверенности со статусом, а опечатка в имени поля тихо снимала
// требование к этому полю. Здесь каждый такой случай — отдельный тест.
//
// Запуск: node --test scripts/factcheck/report-schema.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateReportSchema, computeOutcome, outcomeToResult,
  SCHEMA_VERSION, CLAIM_STATUSES, SEVERITIES, OVERALL_STATUSES,
} from './report-schema.mjs';

const claim = (over = {}) => ({
  id: 'c1', type: 'MONEY', raw: '10 000 ₽',
  statement: 'штраф по ч. 2 ст. 14.5 КоАП РФ для должностных лиц — не менее 10 000 ₽',
  status: 'match', severity: 'critical', confidence: 0.95,
  quote: 'наложение административного штрафа на должностных лиц в размере не менее 10 000 рублей',
  sources: ['http://publication.pravo.gov.ru/document/0001202301010001'],
  action: 'keep',
  ...over,
});

const report = (claims = [claim()], over = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  articleHash: 'a'.repeat(64),
  articleNormHash: 'b'.repeat(64),
  policyVersion: '2026-08-04',
  claims,
  summary: computeOutcome(claims),
  ...over,
});

const problems = (r, opts) => validateReportSchema(r, 'отчёт', opts).map((p) => p.problem).join(' | ');

test('корректный отчёт проходит без замечаний', () => {
  assert.deepEqual(validateReportSchema(report()), []);
});

/* ── обязательные поля ─────────────────────────────────────────────── */

test('отсутствующий confidence — ошибка, а не освобождение от правила', () => {
  const c = claim(); delete c.confidence;
  assert.match(problems(report([c])), /нет confidence/);
});

test('confidence вне диапазона 0…1 — ошибка', () => {
  assert.match(problems(report([claim({ confidence: 1.5 })])), /вне диапазона/);
});

for (const field of ['id', 'raw']) {
  test(`утверждение без ${field} не проходит`, () => {
    const c = claim(); delete c[field];
    assert.match(problems(report([c])), new RegExp(`нет ${field}`));
  });
}

test('повторяющийся id ловится: иначе утверждения неразличимы', () => {
  assert.match(problems(report([claim(), claim()])), /id повторяется/);
});

test('поля контракта версии обязательны', () => {
  for (const f of ['articleHash', 'articleNormHash', 'policyVersion']) {
    const r = report(); delete r[f];
    assert.match(problems(r), new RegExp(`нет поля ${f}`));
  }
});

test('отчёт по старому контракту не выдаёт себя за новый', () => {
  const r = report(); delete r.schemaVersion;
  assert.match(problems(r), /schemaVersion нет — контракт/);
});

test('проверку версии можно отключить — но только явно', () => {
  const r = report(); delete r.schemaVersion; delete r.articleHash;
  delete r.articleNormHash; delete r.policyVersion;
  assert.deepEqual(validateReportSchema(r, 'отчёт', { requireVersioned: false }), []);
});

/* ── закрытые словари ──────────────────────────────────────────────── */

test('незнакомый статус — ошибка, а не «неопасно»', () => {
  assert.match(problems(report([claim({ status: 'probably-fine' })])), /статус «probably-fine» не из списка/);
});

test('незнакомый severity — ошибка', () => {
  assert.match(problems(report([claim({ severity: 'blocker' })])), /severity «blocker» не из списка/);
});

test('незнакомый тип утверждения — ошибка', () => {
  assert.match(problems(report([claim({ type: 'МОНЕТКА' })])), /тип «МОНЕТКА» не из списка/);
});

test('незнакомый action — ошибка', () => {
  assert.match(problems(report([claim({ action: 'подумать' })])), /action «подумать» не из списка/);
});

test('все словари закрыты и непусты', () => {
  for (const dict of [CLAIM_STATUSES, SEVERITIES, OVERALL_STATUSES]) {
    assert.ok(Array.isArray(dict) && dict.length, 'словарь пуст — это открытый список под другим именем');
  }
});

/* ── опечатка не должна отменять требование ────────────────────────── */

test('опечатка в имени поля ловится, а не снимает требование', () => {
  const c = claim(); c.stateent = c.statement; delete c.statement;
  const p = problems(report([c]));
  assert.match(p, /неизвестное поле «stateent»/);
});

test('неизвестное поле отчёта верхнего уровня ловится', () => {
  assert.match(problems(report(undefined, { verdict: 'ok' })), /неизвестное поле отчёта «verdict»/);
});

/* ── источники ─────────────────────────────────────────────────────── */

test('sources обязателен для всего, кроме skip', () => {
  const c = claim(); delete c.sources;
  assert.match(problems(report([c])), /sources обязателен/);
  const skipped = claim({
    id: 'c2', status: 'skip', severity: 'minor',
    explanation: 'класс C редполитики: маркетинговая формулировка, проверять нечего',
  });
  delete skipped.sources;
  assert.deepEqual(validateReportSchema(report([skipped])), []);
});

test('строка, не похожая на ссылку, в sources — ошибка', () => {
  assert.match(problems(report([claim({ sources: ['подтверждено поиском'] })])), /не похоже на ссылку/);
});

/* ── итог считается, а не объявляется ──────────────────────────────── */

test('итог выводится из утверждений', () => {
  assert.deepEqual(computeOutcome([claim()]), { overallStatus: 'ok', criticalIssues: 0, moderateIssues: 0, openIssues: 0 });
  assert.deepEqual(
    computeOutcome([claim(), claim({ id: 'c2', status: 'uncertain', action: 'add-references' })]),
    { overallStatus: 'needs-rewrite', criticalIssues: 1, moderateIssues: 0, openIssues: 1 },
  );
  assert.deepEqual(
    computeOutcome([claim({ status: 'mismatch', severity: 'moderate' })]),
    { overallStatus: 'needs-fixes', criticalIssues: 0, moderateIssues: 1, openIssues: 1 },
  );
});

test('skip закрывает утверждение: класс C редполитики не проверяется намеренно', () => {
  assert.equal(computeOutcome([claim({ status: 'skip', severity: 'minor' })]).openIssues, 0);
});

test('объявленный итог сверяется с посчитанным', () => {
  const claims = [claim(), claim({ id: 'c2', status: 'uncertain', action: 'add-references' })];
  const r = report(claims, { summary: { overallStatus: 'ok', criticalIssues: 0 } });
  const p = problems(r);
  assert.match(p, /overallStatus «ok», а по утверждениям выходит «needs-rewrite»/);
  assert.match(p, /criticalIssues заявлено 0, по утверждениям выходит 1/);
});

test('маркер выписывается только по посчитанному итогу', () => {
  assert.equal(outcomeToResult(computeOutcome([claim()])), 'passed');
  assert.equal(outcomeToResult(computeOutcome([claim({ status: 'uncertain', action: 'add-references' })])), 'failed');
  // Раньше «failed» означал ровно и только overallStatus === 'needs-rewrite',
  // и любой другой текст в этом поле давал passed.
  assert.equal(outcomeToResult(computeOutcome([claim({ status: 'mismatch', severity: 'moderate' })])), 'failed');
});

/* ── вырожденные случаи ────────────────────────────────────────────── */

test('пустой список утверждений — вопрос, а не «нечего проверять»', () => {
  assert.match(problems(report([])), /список утверждений пуст/);
});

test('не объект — отдельный ответ, без падения', () => {
  assert.match(problems(null), /не разбирается/);
  assert.match(problems(report(undefined, { claims: 'нет' })), /нет списка claims/);
});
