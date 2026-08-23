/**
 * K-02. Классификация единиц текста.
 *
 * Покрытие отвечает «все ли значения разобраны» — вопрос узкий: значение
 * это число, дата или номер нормы. Утверждение без числа ему невидимо, а
 * «услуги блокируют накопитель досрочно» и «единого справочника кодов
 * нет» держатся не на числах. Здесь проверяется обратный ход: разобрать
 * весь текст и объяснить про каждую единицу, почему её не проверяют.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  textUnits, splitSentences, checkClassification, classificationStats, UNIT_CLASSES,
} from './classify.mjs';

const art = (body) => `---\ntitle: "x"\ndraft: true\n---\n\n${body}\n`;
const problems = (raw, report) => checkClassification(raw, report).map((p) => p.problem);
const has = (ps, re) => ps.some((p) => re.test(p));

test('сокращения не рвут предложение', () => {
  /* Без исключений «ч. 2 ст. 14.5 КоАП РФ — 10 000 ₽» распадается на
   * четыре обрывка, и классифицировать становится нечего. */
  /* Тире приводится к дефису той же нормализацией, что у смыслового
   * отпечатка: экспорт из Google Docs меняет тире, и без общей
   * нормализации косметическая правка меняла бы id всех единиц. */
  assert.deepEqual(
    splitSentences('Штраф по ч. 2 ст. 14.5 КоАП РФ — 10 000 ₽. Продавец обязан пробить чек.'),
    ['Штраф по ч. 2 ст. 14.5 КоАП РФ - 10 000 ₽.', 'Продавец обязан пробить чек.'],
  );
});

test('заголовки, строки таблиц и пункты списка — отдельные единицы', () => {
  const units = textUnits(art('## Заголовок\n\n- Пункт списка.\n\n| ИП | 10 000 ₽ |\n\nОбычное предложение.'));
  assert.deepEqual(units.map((u) => u.kind).sort(), ['heading', 'list-item', 'sentence', 'table-row']);
});

test('служебная разметка единицей не считается', () => {
  const units = textUnits(art('[Промоблок: 8526]\n\n| --- | --- |\n\nТекст.'));
  assert.deepEqual(units.map((u) => u.text), ['Текст.']);
});

test('id не зависит от позиции: дописанный абзац решения не обнуляет', () => {
  const before = textUnits(art('Первое. Второе.'));
  const after = textUnits(art('Вводный абзац.\n\nПервое. Второе.'));
  const idOf = (list, t) => list.find((u) => u.text === t).id;
  assert.equal(idOf(before, 'Первое.'), idOf(after, 'Первое.'));
});

test('одинаковые предложения различаются по номеру повторения', () => {
  const units = textUnits(art('Проверьте код. Иное. Проверьте код.'));
  const same = units.filter((u) => u.text === 'Проверьте код.');
  assert.equal(same.length, 2);
  assert.notEqual(same[0].id, same[1].id);
});

test('неклассифицированная единица названа, а не посчитана', () => {
  const raw = art('Первое предложение. Второе предложение.');
  const ps = problems(raw, { units: {}, claims: [] });
  assert.ok(has(ps, /не классифицировано единиц текста: 2/), ps.join(' | '));
  assert.ok(has(ps, /Первое предложение/));
});

test('non_factual требует причины', () => {
  const raw = art('Переходное предложение.');
  const [u] = textUnits(raw);
  assert.ok(has(problems(raw, { units: { [u.id]: { class: 'non_factual' } }, claims: [] }), /без причины/));
  assert.deepEqual(problems(raw, {
    units: { [u.id]: { class: 'non_factual', reason: 'связка между разделами' } }, claims: [],
  }), []);
});

test('factual без утверждения в отчёте — дыра, а не «ок»', () => {
  const raw = art('Штраф — 10 000 ₽.');
  const [u] = textUnits(raw);
  assert.ok(has(problems(raw, { units: { [u.id]: { class: 'factual' } }, claims: [] }),
    /factual без утверждения/));
  assert.deepEqual(problems(raw, {
    units: { [u.id]: { class: 'factual' } },
    claims: [{ id: 'r1', span: u.id }],
  }), []);
});

test('решение по единице, которой в статье нет, — текст правили после классификации', () => {
  const raw = art('Единственное предложение.');
  const [u] = textUnits(raw);
  const ps = problems(raw, {
    units: { [u.id]: { class: 'non_factual', reason: 'x' }, uпризрак: { class: 'non_factual', reason: 'x' } },
    claims: [],
  });
  assert.ok(has(ps, /которой в статье нет/));
});

test('класс из закрытого списка', () => {
  const raw = art('Предложение.');
  const [u] = textUnits(raw);
  assert.ok(has(problems(raw, { units: { [u.id]: { class: 'важное' } }, claims: [] }), /не из списка/));
  assert.deepEqual(UNIT_CLASSES, ['factual', 'actionable', 'non_factual']);
});

test('actionable требует утверждения так же, как factual', () => {
  const raw = art('Пробейте чек коррекции.');
  const [u] = textUnits(raw);
  assert.ok(has(problems(raw, { units: { [u.id]: { class: 'actionable' } }, claims: [] }),
    /actionable без утверждения/));
});

test('статистика различает «разобрано» и «нечего разбирать»', () => {
  const raw = art('Первое. Второе.');
  const [a] = textUnits(raw);
  const st = classificationStats(raw, { units: { [a.id]: { class: 'factual' } } });
  assert.equal(st.units, 2);
  assert.equal(st.classified, 1);
  assert.equal(st.unclassified, 1);
  assert.equal(st.factual, 1);
});
