/**
 * H-01. Замкнутость реестра утверждений.
 *
 * Главный тест здесь — не про формат, а про класс ошибки, из-за которого
 * реестр и понадобился: ссылка, которая резолвится, но ведёт в другое
 * место статьи. В корпусе таких было 159, и ни одна проверка их не
 * видела, потому что «id существует» считалось достаточным.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLedger, ledgerStats, linkByRaw, rawMatches, LEDGER_OUTCOMES,
} from './ledger.mjs';

const extraction = (claims) => ({ slug: 'проба', claims });
const E = [
  { id: 'ca11', type: 'MONEY', raw: '10 000 ₽', line: 5 },
  { id: 'cb22', type: 'MONEY', raw: '30 000 ₽', line: 7 },
  { id: 'cc33', type: 'NPA_KOAP', raw: 'ч. 2 ст. 14.5', line: 5 },
];
const rc = (over) => ({ id: 'r1', raw: '10 000 ₽', claimId: 'ca11', ...over });
const problems = (ex, rep) => checkLedger(ex, rep, 'проба').map((p) => p.problem);
const has = (ps, re) => ps.some((p) => re.test(p));

test('ссылка на чужое место ловится, хотя id существует', () => {
  /* Ровно случай корпуса: id валиден, резолвится — и указывает не туда. */
  const ps = problems(extraction(E), {
    claims: [rc({ claimId: 'cb22' })],
    ledger: { ca11: { outcome: 'skipped', reason: 'x' }, cc33: { outcome: 'skipped', reason: 'x' } },
  });
  assert.ok(has(ps, /указывает на другое место статьи/), ps.join(' | '));
});

test('утверждение без claimId — не привязано, а не «нормально»', () => {
  const c = rc(); delete c.claimId;
  const ps = problems(extraction(E), { claims: [c] });
  assert.ok(has(ps, /нет claimId/));
});

test('claimId в никуда', () => {
  const ps = problems(extraction(E), { claims: [rc({ claimId: 'нету' })] });
  assert.ok(has(ps, /не существует/));
});

test('извлечённое утверждение без исхода — orphan, и он назван', () => {
  const ps = problems(extraction(E), { claims: [rc()] });
  assert.ok(has(ps, /2 извлечённых утверждений без исхода/), ps.join(' | '));
  assert.ok(has(ps, /cb22/));
});

test('замкнутый реестр не даёт замечаний', () => {
  const ps = problems(extraction(E), {
    claims: [rc(), { id: 'r2', raw: 'штраф 30 000 ₽ для юрлица', claimId: 'cb22' }],
    ledger: { cc33: { outcome: 'skipped', reason: 'разбирается в опорной статье' } },
  });
  assert.deepEqual(ps, []);
});

test('skipped без причины — пропущенный шаг, а не решение', () => {
  const ps = problems(extraction(E), {
    claims: [rc(), { id: 'r2', raw: '30 000 ₽', claimId: 'cb22' }],
    ledger: { cc33: { outcome: 'skipped' } },
  });
  assert.ok(has(ps, /skipped без reason/));
});

test('duplicateOf обязан указывать на разобранное утверждение', () => {
  const base = { claims: [rc()], ledger: {} };

  // цель не разбирали
  let ps = problems(extraction(E), {
    ...base,
    ledger: { cb22: { outcome: 'duplicateOf', of: 'cc33' }, cc33: { outcome: 'duplicateOf', of: 'cb22' } },
  });
  assert.ok(has(ps, /дубликат не может закрывать дубликат/), ps.join(' | '));

  // цель не существует
  ps = problems(extraction(E), {
    ...base,
    ledger: { cb22: { outcome: 'duplicateOf', of: 'нету' }, cc33: { outcome: 'skipped', reason: 'x' } },
  });
  assert.ok(has(ps, /такого утверждения в реестре нет/));

  // сам на себя
  ps = problems(extraction(E), {
    ...base,
    ledger: { cb22: { outcome: 'duplicateOf', of: 'cb22' }, cc33: { outcome: 'skipped', reason: 'x' } },
  });
  assert.ok(has(ps, /сам на себя/));
});

test('исход должен быть один: и разбор, и ledger — ошибка', () => {
  const ps = problems(extraction(E), {
    claims: [rc()],
    ledger: { ca11: { outcome: 'skipped', reason: 'x' }, cb22: { outcome: 'skipped', reason: 'x' }, cc33: { outcome: 'skipped', reason: 'x' } },
  });
  assert.ok(has(ps, /одновременно разобран.*и помечен в ledger/));
});

test('два утверждения на один claimId требуют duplicateOf, а не молчания', () => {
  const ps = problems(extraction(E), {
    claims: [rc(), rc({ id: 'r2' })],
    ledger: { cb22: { outcome: 'skipped', reason: 'x' }, cc33: { outcome: 'skipped', reason: 'x' } },
  });
  assert.ok(has(ps, /уже разобран другим утверждением/));
});

test('решение по несуществующему утверждению', () => {
  const ps = problems(extraction(E), {
    claims: [rc(), { id: 'r2', raw: '30 000 ₽', claimId: 'cb22' }],
    ledger: { cc33: { outcome: 'skipped', reason: 'x' }, призрак: { outcome: 'skipped', reason: 'x' } },
  });
  assert.ok(has(ps, /которого нет в реестре извлечения/));
});

test('stale-утверждения исхода не требуют', () => {
  const ex = extraction([...E, { id: 'sdead', raw: 'цитаты больше нет', stale: true }]);
  const ps = problems(ex, {
    claims: [rc(), { id: 'r2', raw: '30 000 ₽', claimId: 'cb22' }],
    ledger: { cc33: { outcome: 'skipped', reason: 'x' } },
  });
  assert.deepEqual(ps, []);
});

test('нет файла извлечения — не с чем сверять полноту', () => {
  assert.ok(has(problems(null, { claims: [rc()] }), /нет файла извлечения/));
});

test('LEDGER_OUTCOMES закрыт: незнакомый исход — ошибка', () => {
  const ps = problems(extraction(E), {
    claims: [rc(), { id: 'r2', raw: '30 000 ₽', claimId: 'cb22' }],
    ledger: { cc33: { outcome: 'потом посмотрим' } },
  });
  assert.ok(has(ps, /не из списка/));
  assert.deepEqual(LEDGER_OUTCOMES, ['skipped', 'duplicateOf']);
});

/* ── Подбор ссылок ──────────────────────────────────────────────────── */

test('rawMatches различает «то же место» и «чужая строка»', () => {
  assert.ok(rawMatches('10 000 ₽', 'штраф не менее 10 000 ₽ для ИП'));
  assert.ok(rawMatches('ч. 2 ст. 14.5', 'ч. 2 ст. 14.5'));  // NBSP
  assert.ok(!rawMatches('10 000 ₽', '30 000 ₽'));
  assert.ok(!rawMatches('', 'что угодно'));
});

test('linkByRaw снимает битую ссылку, а не оставляет её резолвиться', () => {
  const claims = [rc({ claimId: 'cb22' })];        // указывает на «30 000 ₽»
  const r = linkByRaw(E, claims);
  assert.equal(r.repaired, 1, 'битая ссылка обязана сниматься');
  assert.equal(claims[0].claimId, 'ca11', 'после снятия должна подобраться верная');
});

test('одинаковый текст в разных местах разводится по порядку появления', () => {
  const ex = [
    { id: 'cx1', type: 'DATE_TEXT', raw: '1 октября 2026 года' },
    { id: 'cx2', type: 'DATE_TEXT', raw: '1 октября 2026 года' },
  ];
  const claims = [{ id: 'r1', raw: '1 октября 2026 года' }, { id: 'r2', raw: '1 октября 2026 года' }];
  const r = linkByRaw(ex, claims);
  assert.equal(r.linked, 2);
  assert.deepEqual([claims[0].claimId, claims[1].claimId], ['cx1', 'cx2']);
});

test('разный текст с общим ядром — берётся точный, а не первый попавшийся', () => {
  const ex = [
    { id: 'cs1', type: 'NPA_KOAP', raw: 'ст. 14.5' },
    { id: 'cs2', type: 'NPA_KOAP', raw: 'ч. 2 ст. 14.5' },
  ];
  const claims = [{ id: 'r1', raw: 'ч. 2 ст. 14.5 КоАП РФ' }];
  linkByRaw(ex, claims);
  assert.equal(claims[0].claimId, 'cs2');
});

test('stale-утверждение целью ссылки не становится', () => {
  const ex = [{ id: 'sdead', raw: '10 000 ₽', stale: true }, ...E];
  const claims = [{ id: 'r1', raw: '10 000 ₽' }];
  linkByRaw(ex, claims);
  assert.equal(claims[0].claimId, 'ca11');
});

test('ledgerStats считает то же, что видит checkLedger', () => {
  const st = ledgerStats(extraction(E), { claims: [rc()] });
  assert.equal(st.extracted, 3);
  assert.equal(st.linked, 1);
  assert.equal(st.orphans, 2);
  assert.equal(st.wrongTarget, 0);

  const bad = ledgerStats(extraction(E), { claims: [rc({ claimId: 'cb22' })] });
  assert.equal(bad.wrongTarget, 1);
  assert.equal(bad.linked, 0);
});
