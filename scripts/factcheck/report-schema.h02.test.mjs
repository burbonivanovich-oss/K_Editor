/**
 * H-02. Вердикт и правка обязаны сходиться.
 *
 * Проверка ровно того класса ошибок, который прошёл через корпус: отчёт
 * ставит `match` и тут же требует переписать абзац. Обе половины такого
 * утверждения по отдельности выглядят осмысленно, вместе — противоречат,
 * и до этой проверки побеждала та, что улучшала итог.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS, ACTIONS_BY_STATUS, CLAIM_STATUSES,
  actionMatchesStatus, computeOutcome, validateReportSchema, SCHEMA_VERSION, MODALITIES,
} from './report-schema.mjs';

const claim = (over = {}) => ({
  id: 'c1', type: 'MONEY', raw: '10 000 ₽',
  statement: 'штраф для ИП по ч. 2 ст. 14.5 КоАП РФ не менее 10 000 ₽',
  status: 'match', severity: 'critical', confidence: 0.9,
  sources: ['https://example.gov/x'], action: 'keep', ...over,
});

const report = (claims) => ({
  schemaVersion: SCHEMA_VERSION,
  articleHash: 'a'.repeat(64), articleNormHash: 'b'.repeat(64),
  policyVersion: '2026-08-21', checkedAt: '2026-08-21',
  claims, summary: computeOutcome(claims),
});

const complaints = (c) => validateReportSchema(report([c]), 'тест')
  .filter((p) => /action|правк|keep|skip без/.test(p.problem));

test('match допускает только keep', () => {
  assert.deepEqual(ACTIONS_BY_STATUS.match, ['keep']);
  assert.equal(complaints(claim()).length, 0);
  for (const a of ACTIONS.filter((x) => x !== 'keep')) {
    const p = complaints(claim({ action: a }));
    assert.ok(p.length, `match + ${a} обязан ловиться`);
    assert.match(p[0].problem, /значение не подтверждено/);
  }
});

test('незакрытый статус не допускает keep', () => {
  for (const st of CLAIM_STATUSES.filter((s) => s !== 'match' && s !== 'skip')) {
    const p = complaints(claim({ status: st, action: 'keep' }));
    assert.ok(p.length, `${st} + keep обязан ловиться`);
    assert.match(p[0].problem, /правка не названа/);
  }
});

test('action обязателен: пропуск поля не отменяет требования', () => {
  const c = claim(); delete c.action;
  const p = complaints(c);
  assert.ok(p.length);
  assert.match(p[0].problem, /нет action/);
});

test('skip требует объяснения — «не проверяли» без «почему» это пропущенный шаг', () => {
  const p = complaints(claim({ status: 'skip', action: 'keep', sources: undefined }));
  assert.ok(p.some((x) => /skip без объяснения/.test(x.problem)));
  const ok = complaints(claim({ status: 'skip', action: 'keep', explanation: 'класс C редполитики: рекламная формулировка' }));
  assert.equal(ok.filter((x) => /skip без объяснения/.test(x.problem)).length, 0);
});

test('противоречивый claim не улучшает итог даже мимо проверки формы', () => {
  /* Защита на второй линии: computeOutcome зовут и там, где схему не
   * гоняли. `match` + правка обязан считаться незакрытым. */
  const good = computeOutcome([claim()]);
  assert.equal(good.overallStatus, 'ok');

  const bad = computeOutcome([claim({ action: 'rewrite-bullet' })]);
  assert.equal(bad.overallStatus, 'needs-rewrite', 'match + правка обязан ломать итог');
  assert.equal(bad.criticalIssues, 1);
  assert.equal(bad.openIssues, 1);
});

test('actionMatchesStatus не судит незнакомый статус — это работа enum', () => {
  assert.equal(actionMatchesStatus({ status: 'выдумка', action: 'keep' }), true);
  assert.equal(actionMatchesStatus({ status: 'match', action: undefined }), false);
});

test('у каждого статуса есть список допустимых правок', () => {
  /* Новый статус нельзя завести, забыв про его совместимость с action:
   * забытый статус означал бы «любая правка сойдёт». */
  for (const st of CLAIM_STATUSES) {
    assert.ok(Array.isArray(ACTIONS_BY_STATUS[st]) && ACTIONS_BY_STATUS[st].length,
      `для статуса ${st} не задан список допустимых action`);
  }
});

/* ── K-03: разбор утверждения на части ──────────────────────────────── */

test('modality из закрытого списка', () => {
  const bad = validateReportSchema(report([claim({ modality: 'наверное' })]), 'тест');
  assert.ok(bad.some((p) => /modality/.test(p.problem)));
  for (const m of MODALITIES) {
    assert.equal(validateReportSchema(report([claim({ modality: m })]), 'тест').length, 0, m);
  }
});

test('negated — булево, «не указано» третьим значением не бывает', () => {
  const ps = validateReportSchema(report([claim({ negated: 'не знаю' })]), 'тест');
  assert.ok(ps.some((p) => /negated/.test(p.problem)));
  assert.equal(validateReportSchema(report([claim({ negated: false })]), 'тест').length, 0);
});

test('conditions — список непустых строк', () => {
  assert.ok(validateReportSchema(report([claim({ conditions: 'режим Z' })]), 'тест')
    .some((p) => /conditions обязан быть списком/.test(p.problem)));
  assert.ok(validateReportSchema(report([claim({ conditions: ['режим Z', '  '] })]), 'тест')
    .some((p) => /пустое условие/.test(p.problem)));
  assert.equal(validateReportSchema(report([claim({ conditions: ['режим Z'] })]), 'тест').length, 0);
});

test('даты действия утверждения — в ISO', () => {
  assert.ok(validateReportSchema(report([claim({ effectiveFrom: '01.10.2026' })]), 'тест')
    .some((p) => /effectiveFrom/.test(p.problem)));
  assert.equal(validateReportSchema(report([claim({ effectiveFrom: '2026-10-01', effectiveTo: null })]), 'тест').length, 0);
});

test('пустой subject хуже отсутствующего: он выглядит заполненным', () => {
  assert.ok(validateReportSchema(report([claim({ subject: '   ' })]), 'тест')
    .some((p) => /subject пустой/.test(p.problem)));
});
