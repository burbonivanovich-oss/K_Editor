// Договор между гейтом и оценщиком.
//
// Гейт считает проверки, оценщик их принимает и требует, чтобы все были
// на месте. Списки живут в двух файлах, и расходятся они ровно тогда,
// когда в один из них добавляют проверку: гейт её считает, оценщик про
// неё не знает — или наоборот, оценщик требует то, чего гейт не отдаёт,
// и каждая запись становится «нечестно оформленной».
//
// Ни одна из этих поломок не видна в отчётах: обе стороны продолжают
// печатать правдоподобный вывод. Поэтому договор проверяется тестом, а
// не договорённостью.
//
// Запуск: node --test scripts/gates-contract.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATE_CHECKS, toAnalyzeChecks, verdict, OK, FAIL, DECIDE, NA } from './gates.mjs';
import { checkAnalysis, REQUIRED_CHECKS, SOFT_CATEGORIES, PASS, ANALYSIS_SCHEMA_VERSION, INTENT_MATRICES } from './check-analysis.mjs';

const intentOk = (intent = 'instruction') =>
  Object.fromEntries(Object.keys(INTENT_MATRICES[intent].checks).map((k) => [k, { ok: true }]));

test('гейт отдаёт ровно те проверки, которых требует оценщик', () => {
  assert.deepEqual([...Object.keys(GATE_CHECKS)].sort(), [...REQUIRED_CHECKS].sort());
});

test('у каждой проверки есть человеческое название для отчёта', () => {
  for (const [key, title] of Object.entries(GATE_CHECKS)) {
    assert.ok(title && title !== key, `проверка ${key} без названия`);
  }
});

/* Категории баллов и проверки не должны пересекаться: пересечение
 * означает, что за одно и то же и снимают балл, и ставят блокер. */
test('ни одна проверка не совпадает с категорией баллов', () => {
  for (const key of Object.keys(SOFT_CATEGORIES)) {
    assert.ok(!(key in GATE_CHECKS), `«${key}» одновременно проверка и категория баллов`);
  }
});

/* ------------------------------------------- перевод статусов в checks */

const result = (statuses) => ({
  checks: Object.fromEntries(Object.entries(statuses).map(([k, s]) => [
    k, typeof s === 'string' ? { status: s, note: 'причина' } : s,
  ])),
});

test('красное — ok: false, зелёное — ok: true, решение — отдельное состояние', () => {
  const c = toAnalyzeChecks(result({ seo: FAIL, npa: OK, market: DECIDE }));
  assert.equal(c.seo.ok, false);
  assert.equal(c.npa.ok, true);
  /* Раньше здесь стояло ok: true — и «сузить угол и добавить источник»
   * попадало в оценку как пройденная проверка. Решение не бывает
   * «пройдено само»: пока его не записали, проверка не зелёная. */
  assert.equal(c.market.ok, undefined, 'у решения не должно быть ok');
  assert.equal(c.market.decide, true);
  assert.equal(c.market.resolution, null, 'место под решение обязано быть пустым, а не отсутствовать');
});

// Неприменимое не должно превращаться ни в провал, ни в достижение:
// раньше именно этот случай нормировался в плюс.
test('неприменимое переносится как applicable: false с причиной', () => {
  const c = toAnalyzeChecks(result({ pillar: { status: NA, note: 'у кластера нет опорного' } }));
  assert.equal(c.pillar.applicable, false);
  assert.equal(c.pillar.ok, undefined, 'у неприменимой проверки не должно быть ok');
  assert.match(c.pillar.note, /нет опорного/);
});

test('числовое значение проверки доезжает до записи', () => {
  const c = toAnalyzeChecks(result({ ai: { status: OK, note: '3/10', value: 3 } }));
  assert.equal(c.ai.value, 3);
});

/* ------------------------------------------------------------- вердикт */

test('одно красное перевешивает любое количество зелёного', () => {
  assert.equal(verdict(result({ a: OK, b: OK, c: OK, d: FAIL })), 1);
});

test('красное сильнее «требует решения»', () => {
  assert.equal(verdict(result({ a: FAIL, b: DECIDE })), 1);
});

test('«требует решения» без красного — код 2, а не провал', () => {
  assert.equal(verdict(result({ a: OK, b: DECIDE })), 2);
});

test('неприменимое само по себе не портит вердикт', () => {
  assert.equal(verdict(result({ a: OK, b: NA })), 0);
});

/* --------------------------------- сквозная сборка: гейт → оценка → гейт */

/* Главная проверка всей перестройки: вывод гейта, дополненный баллами,
 * обязан проходить check-analysis без единого замечания. Если хоть одно
 * звено разъедется — оценка перестанет записываться, и узнают об этом
 * посреди батча. */
test('вывод гейта плюс баллы складываются в честную оценку', () => {
  const statuses = Object.fromEntries(Object.keys(GATE_CHECKS).map((k) => [k, OK]));
  statuses.pillar = { status: NA, note: 'у кластера ts-piot нет опорного материала' };
  statuses.market = DECIDE;

  const record = {
    slug: 'x',
    checkedAt: '2026-08-13',
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    articleHash: 'a'.repeat(64),
    articleNormHash: 'b'.repeat(64),
    rubricVersion: '2026-08-13',
    intent: 'instruction',
    intentChecks: intentOk(),
    checks: toAnalyzeChecks(result(statuses)),
    categories: {
      lead: { score: 23, issues: [{ text: 'лид без факта', severity: 'minor' }, { text: 'нет даты', severity: 'minor' }] },
      structure: { score: 25, issues: [] },
      language: { score: 24, issues: [{ text: 'повтор формы абзацев', severity: 'minor' }] },
      usefulness: { score: 25, issues: [] },
    },
    score: 97,
    maxScore: 100,
    blocker: false,
  };
  /* market пришёл как DECIDE — значит в записи обязано быть решение. */
  record.checks.market.resolution = {
    text: 'угол сужен до розницы, ссылка на материал Маркета добавлена в лид',
    owner: 'редактор Ирина',
    evidence: 'https://kontur.ru/market/spravka/1-x',
    resolvedAt: '2026-08-13',
  };
  assert.deepEqual(checkAnalysis(record), []);
});

test('упавшая проверка гейта заставляет оценку поднять блокер', () => {
  const statuses = Object.fromEntries(Object.keys(GATE_CHECKS).map((k) => [k, OK]));
  statuses.npa = FAIL;

  const record = {
    slug: 'x', checkedAt: '2026-08-13',
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    articleHash: 'a'.repeat(64), articleNormHash: 'b'.repeat(64), rubricVersion: '2026-08-13',
    intent: 'instruction', intentChecks: intentOk(),
    checks: toAnalyzeChecks(result(statuses)),
    categories: {
      lead: { score: 25, issues: [] }, structure: { score: 25, issues: [] },
      language: { score: 25, issues: [] }, usefulness: { score: 25, issues: [] },
    },
    score: 100, maxScore: 100, blocker: false,
  };
  const problems = checkAnalysis(record).map((p) => p.problem).join(' ');
  assert.match(problems, /blocker должен быть true/, 'сотня баллов не отменяет упавшую норму');
});

test('порог и максимум согласованы между собой', () => {
  const max = Object.values(SOFT_CATEGORIES).reduce((s, d) => s + d.max, 0);
  assert.equal(max, 100, 'категории должны давать ровно 100');
  assert.ok(PASS > 0 && PASS < max, `порог ${PASS} должен быть внутри шкалы`);
});
