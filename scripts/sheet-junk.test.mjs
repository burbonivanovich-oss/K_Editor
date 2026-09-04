// Что считается следом старого кода в ячейках — и что не считается.
//
// Цена ошибки здесь несимметрична: не вычистить мусор значит оставить
// редактору красные отметки, а вычистить лишнее — стереть его работу.
// Поэтому правило узкое, и тесты держат обе границы.
//
// Запуск: node --test scripts/sheet-junk.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLegacyJunk, titleOf } from './lib/sheet-junk.mjs';

const row = (n, fields) => ({ row: n, ...fields });

/* ------------------------------------------------ машинный след */

test('статус в «Формате статьи» — след старого кода', () => {
  const { junk } = findLegacyJunk([
    row(5, { format: 'снято' }),
    row(6, { format: 'на вычитке · 18 дн.' }),
    row(7, { format: 'выпущено' }),
    row(8, { format: 'в плане' }),
  ]);
  assert.equal(junk.length, 4);
  assert.ok(junk.every((j) => j.key === 'format'));
});

test('ссылка на док в «Кто пишет» — след старого кода', () => {
  const { junk } = findLegacyJunk([row(5, { who: 'https://docs.google.com/document/d/abc/edit' })]);
  assert.equal(junk.length, 1);
  assert.equal(junk[0].key, 'who');
});

test('slug в «Ссылке Маркета» — след старого кода', () => {
  const { junk } = findLegacyJunk([row(45, { konturLink: 'otchety-po-prodazham-kak-chitat-i-na-chto-smotret' })]);
  assert.equal(junk.length, 1);
  assert.equal(junk[0].key, 'konturLink');
});

test('каждая находка называет строку, колонку и причину', () => {
  const { junk } = findLegacyJunk([row(12, { format: 'снято' })]);
  const [j] = junk;
  assert.equal(j.row, 12);
  assert.equal(j.value, 'снято');
  assert.ok(j.why.length > 5);
  assert.equal(titleOf(j.key), 'Формат статьи');
});

/* ------------------------------------------ работа редактора цела */

test('свой формат редактора не трогаем: список нестрогий', () => {
  // Ровно та ошибка, которой стоит бояться: «всё, чего нет в словаре» —
  // это и есть работа редактора.
  const { junk } = findLegacyJunk([
    row(5, { format: 'вопрос эксперту' }),
    row(6, { format: 'пошаговая инструкция' }),
    row(7, { format: 'интервью с бухгалтером' }),
  ]);
  assert.deepEqual(junk, []);
});

test('«AI» и «пишем сами» в «Кто пишет» остаются', () => {
  const { junk } = findLegacyJunk([row(5, { who: 'AI' }), row(6, { who: 'пишем сами' })]);
  assert.deepEqual(junk, []);
});

test('настоящая ссылка Маркета остаётся', () => {
  const { junk } = findLegacyJunk([row(5, { konturLink: 'https://kontur.ru/market/spravka/25147' })]);
  assert.deepEqual(junk, []);
});

test('пустые ячейки не считаются находками', () => {
  const { junk, suspicious } = findLegacyJunk([row(5, { format: '', who: '   ', konturLink: '' })]);
  assert.deepEqual(junk, []);
  assert.deepEqual(suspicious, []);
});

test('колонки редактора вне правила не трогаются вовсе', () => {
  const { junk } = findLegacyJunk([row(5, {
    decision: 'не подходит', reason: 'не тот угол',
    note: 'Статью написать в формате «Вопрос эксперту»', adaptation: 'Телеграм, Дзен',
  })]);
  assert.deepEqual(junk, []);
});

/* ------------------------------------------------- решает человек */

test('решение, вписанное в «Тезисы», показывается, но не стирается', () => {
  const { junk, suspicious } = findLegacyJunk([row(45, { theses: 'убрать' })]);
  assert.deepEqual(junk, [], 'это ошибка человека, а не машинная запись — стирать без него нельзя');
  assert.equal(suspicious.length, 1);
  assert.equal(suspicious[0].row, 45);
});

test('нормальные тезисы не попадают ни в один список', () => {
  const { junk, suspicious } = findLegacyJunk([
    row(46, { theses: 'разобрать три сценария; показать пример расчёта' }),
  ]);
  assert.deepEqual(junk, []);
  assert.deepEqual(suspicious, []);
});

/* ------------------------------------------------- живой снимок */

test('снимок таблицы на 04.09.2026 разбирается ожидаемо', () => {
  // Строки взяты с рабочей вкладки: две статьи на вычитке, снятая тема
  // с явным «AI», новая тема кластера «ИИ» и ячейка, где редактор
  // перепутал колонку.
  const { junk, suspicious } = findLegacyJunk([
    row(7, { format: 'на вычитке · 22 дн.', who: 'https://docs.google.com/document/d/x/edit', decision: 'одобрено' }),
    row(10, { format: 'на вычитке · 18 дн.', who: 'https://docs.google.com/document/d/y/edit' }),
    row(12, { format: 'снято', who: 'AI', reason: 'уже покрыто другой статьёй' }),
    row(45, { format: 'в плане', theses: 'убрать', decision: 'не подходит' }),
  ]);
  assert.equal(junk.filter((j) => j.key === 'format').length, 4);
  assert.equal(junk.filter((j) => j.key === 'who').length, 2, '«AI» в строке 12 обязан уцелеть');
  assert.equal(suspicious.length, 1);
});
