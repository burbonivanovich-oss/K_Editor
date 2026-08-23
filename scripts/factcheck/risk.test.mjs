// Тесты риск-классов.
//
// Прежний список опасного — деньги, УК/КоАП, длительность — оставлял без
// строгих доказательств то, что ошибается с тем же эффектом: дату
// вступления требования, ставку, номер ПП, версию ФФД. Читатель по такой
// ошибке делает не то и не тогда, а гейт молчит.
//
// Запуск: node --test scripts/factcheck/risk.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskOf, STRICT_TYPES, SOFT_TYPES } from './risk.mjs';
import { CLAIM_TYPES } from './report-schema.mjs';

const claim = (over) => ({ type: 'CLAIM', raw: '', severity: 'minor', ...over });

test('каждый известный тип отнесён к строгому или мягкому — забытых нет', () => {
  const unclassified = CLAIM_TYPES.filter((t) => !STRICT_TYPES.includes(t) && !SOFT_TYPES.includes(t));
  assert.deepEqual(unclassified, [], `тип без класса риска: ${unclassified.join(', ')}`);
});

/* То, что раньше проходило без цитаты и источника. */
for (const type of ['DATE_DMY', 'DATE_TEXT', 'DATE_YEAR', 'DATE_CONTEXT', 'PERCENT',
  'NPA_FZ', 'NPA_PP_NUMBERED', 'NPA_PRIKAZ', 'NPA_PUNKT', 'TECH', 'TAG', 'QUANTITY']) {
  test(`${type} требует строгих доказательств`, () => {
    assert.equal(riskOf(claim({ type })).strict, true);
  });
}

test('severity поднимает класс, но не понижает', () => {
  // Тип из строгого списка остаётся строгим при minor.
  assert.equal(riskOf(claim({ type: 'MONEY', severity: 'minor' })).strict, true);
  // Мягкий тип с critical становится строгим.
  assert.equal(riskOf(claim({ type: 'LINK', severity: 'critical' })).strict, true);
});

test('контекст поднимает класс независимо от типа', () => {
  const cases = [
    ['ответственность или санкция', { statement: 'за это положен штраф 5 000 ₽' }],
    ['срок вступления требования', { statement: 'требование вступает в силу с 1 марта 2026 года' }],
    ['технический идентификатор', { statement: 'в чеке нужен тег 1162' }],
    ['указание к действию', { statement: 'продавец обязан подключиться к системе' }],
  ];
  for (const [reason, over] of cases) {
    const r = riskOf(claim({ type: 'CLAIM', ...over }));
    assert.equal(r.strict, true, `не строгий: ${JSON.stringify(over)}`);
    assert.equal(r.reason, reason);
  }
});

test('утверждение без значения строгим не становится', () => {
  assert.equal(riskOf(claim({ type: 'CLAIM', statement: 'модуль работает на Windows' })).strict, false);
  assert.equal(riskOf(claim({ type: 'LINK', raw: 'https://example.com' })).strict, false);
});

test('причина строгости называется словами — она попадает в текст замечания', () => {
  assert.equal(riskOf(claim({ type: 'PERCENT' })).reason, 'тип PERCENT');
  assert.match(riskOf(claim({ severity: 'critical' })).reason, /critical/);
});
