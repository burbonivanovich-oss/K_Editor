// Тесты сверки таблицы с состоянием цикла.
//
// Каждый случай здесь — не выдуманный, а реально случившийся 11.08.2026 и
// найденный глазами. Смысл проверки в том, чтобы следующий такой случай
// нашёлся автоматически, поэтому тесты воспроизводят именно их.
//
// Запуск: node --test scripts/verify-sheet.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare } from './verify-sheet.mjs';
import { WORK_COLS } from './lib/sheet-columns.mjs';

const HEADERS = WORK_COLS.map((c) => c.title);

const state = {
  plan: [
    { slug: 'tema-a', title: 'Тема A', status: 'review', priority: 'P0',
      docId: 'doc1', docUrl: 'https://docs.google.com/document/d/doc1/edit' },
    { slug: 'tema-b', title: 'Тема B', status: 'planned', priority: 'P1' },
    { slug: 'tema-c', title: 'Тема C', status: 'dropped', priority: 'P1' },
  ],
};

const row = (over = {}) => ({
  slug: '', topic: '', status: '', doc: '', priority: 'P1', ...over,
});

const okPull = {
  tab: 'Темы и статьи 2026-08',
  columns: HEADERS,
  items: [
    row({ slug: 'tema-a', topic: 'Тема A', status: 'на вычитке · 3 дн.', doc: 'https://docs.google.com/document/d/doc1/edit', priority: 'P0' }),
    row({ slug: 'tema-b', topic: 'Тема B', status: 'в плане' }),
  ],
};

test('сходится: расхождений нет', () => {
  assert.deepEqual(compare(state, okPull), []);
});

test('снятая тема в таблице не обязана быть', () => {
  // status dropped — строку редактор мог удалить, это не поломка.
  assert.deepEqual(compare(state, okPull).filter((p) => p.detail.includes('Тема C')), []);
});

// Обратный случай, поймано 12.08.2026 при снятии дубля: строка снятой темы
// из таблицы никуда не девается — она и должна там остаться, чтобы редактор
// видел решение. Сверка считала её лишней и ругалась каждый час.
test('снятая тема, оставшаяся в таблице, — не лишняя строка', () => {
  const pull = {
    ...okPull,
    items: [...okPull.items, row({ slug: 'tema-c', topic: 'Тема C', status: 'снято' })],
  };
  assert.deepEqual(compare(state, pull), []);
});

// Регрессия: 11.08.2026 в набор колонок добавили «Сегмент» и «Связки», и
// вкладки, написанные раньше, читались со сдвигом — решение редактора
// уезжало в соседнее поле.
test('ловит сдвиг раскладки колонок', () => {
  const shifted = { ...okPull, columns: ['#', 'Тема', 'Целевой запрос', ...HEADERS.slice(2)] };
  const problems = compare(state, shifted);
  assert.ok(problems.some((p) => p.kind === 'колонка не на месте'), 'сдвиг колонок должен быть найден');
});

// Регрессия: cycle-state адресовал ячейки зашитыми буквами I/J/K. После
// перестановки колонок статусы уехали в «Приоритет», а колонка «Статус»
// осталась пустой.
test('ловит статус, записанный не в ту колонку', () => {
  const broken = { ...okPull, items: [row({ slug: 'tema-a', topic: 'Тема A', status: '', doc: 'https://docs.google.com/document/d/doc1/edit' }), okPull.items[1]] };
  const problems = compare(state, broken);
  assert.ok(problems.some((p) => p.kind === 'статус разошёлся'));
});

// Регрессия: drive-sync писал в колонку «ID» то, что пришло в plan.json, и
// при отсутствии поля колонка оставалась пустой — apply-decisions не
// находил по slug ни одной темы цикла.
test('ловит пустую колонку ID', () => {
  const noSlugs = { ...okPull, items: okPull.items.map((i) => ({ ...i, slug: '' })) };
  const problems = compare(state, noSlugs);
  assert.equal(problems.filter((p) => p.kind === 'темы нет в таблице').length, 2);
});

// Регрессия: init переносил тему в новый месяц с docUrl: null, связь с
// готовым текстом терялась, а док оставался в Drive.
test('ловит потерянную ссылку на док', () => {
  const noDoc = { ...okPull, items: [{ ...okPull.items[0], doc: '' }, okPull.items[1]] };
  assert.ok(compare(state, noDoc).some((p) => p.kind === 'нет ссылки на док'));
});

// Регрессия: в «Приоритет» уехал текст статуса, apply-decisions принял его
// как приоритет темы и вернул в таблицу уже как «правильное» значение.
test('ловит приоритет не из набора', () => {
  const badPriority = { ...okPull, items: [{ ...okPull.items[0], priority: 'на вычитке · 0 дн.' }, okPull.items[1]] };
  assert.ok(compare(state, badPriority).some((p) => p.kind === 'приоритет не из набора'));
});

test('ловит строку, которой нет в состоянии цикла', () => {
  const extra = { ...okPull, items: [...okPull.items, row({ slug: 'tema-x', topic: 'Тема X', status: 'в плане' })] };
  assert.ok(compare(state, extra).some((p) => p.kind === 'лишняя строка'));
});

test('строка без ID — не ошибка: так редактор добавляет свою тему', () => {
  const added = { ...okPull, items: [...okPull.items, row({ slug: '', topic: 'Своя тема редактора' })] };
  assert.deepEqual(compare(state, added), []);
});
