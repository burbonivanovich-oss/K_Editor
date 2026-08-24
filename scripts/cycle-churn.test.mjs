/**
 * Коммит рутины обязан означать событие, а не прогон.
 *
 * Замер 24.08.2026: 81 коммит «watch-sheet: решения редактора применены»
 * при 56 прогонах подряд с нулём решений. Тесты держат ровно одну
 * границу: что считать шумом, а что — состоянием.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSignificant, CHURN_FIELDS } from './cycle-churn.mjs';

const base = () => ({
  cycleId: '2026-08',
  state: 'running',
  updatedAt: '2026-08-22T18:49:00.072Z',
  lastNudgeAt: '2026-08-22',
  maxInReview: 10,
  plan: [{ slug: 'tema', status: 'review', reviewSince: '2026-08-17' }],
  log: [{ at: '2026-08-22T18:48:56.955Z', event: 'apply-decisions: 0 снято, 0 «пишем сами», 0 правок' }],
});

test('сдвиг updatedAt и новая запись в журнале — не событие', () => {
  const before = base();
  const after = base();
  after.updatedAt = '2026-08-23T05:07:00.000Z';
  after.log = [...after.log, { at: '2026-08-23T05:06:59.000Z', event: 'apply-decisions: 0 снято, 0 «пишем сами», 0 правок' }];
  assert.equal(isSignificant(before, after), false);
});

test('решение редактора — событие', () => {
  const before = base();
  const after = base();
  after.updatedAt = '2026-08-23T05:07:00.000Z';
  after.plan[0].status = 'dropped';
  assert.equal(isSignificant(before, after), true);
});

test('lastNudgeAt считается состоянием: от него зависит, слать ли напоминание', () => {
  /* Если бы поле попало в список шума, дедупликация напоминаний
   * перестала бы переживать прогон — редакция получала бы письмо
   * каждый час вместо одного раза в день. */
  const before = base();
  const after = base();
  after.lastNudgeAt = '2026-08-23';
  assert.equal(isSignificant(before, after), true);
  assert.ok(!CHURN_FIELDS.includes('lastNudgeAt'));
});

test('переставленные ключи — переформатирование, а не изменение', () => {
  const before = { a: 1, b: { x: 1, y: 2 }, updatedAt: '1' };
  const after = { b: { y: 2, x: 1 }, a: 1, updatedAt: '2' };
  assert.equal(isSignificant(before, after), false);
});

test('новая тема в плане — событие даже при том же числе тем', () => {
  const before = base();
  const after = base();
  after.plan = [{ slug: 'drugaya', status: 'review', reviewSince: '2026-08-17' }];
  assert.equal(isSignificant(before, after), true);
});

test('пустые и отсутствующие состояния не роняют проверку', () => {
  assert.equal(isSignificant(undefined, undefined), false);
  assert.equal(isSignificant({}, { updatedAt: 'x', log: [] }), false);
  assert.equal(isSignificant({}, { state: 'paused' }), true);
});
