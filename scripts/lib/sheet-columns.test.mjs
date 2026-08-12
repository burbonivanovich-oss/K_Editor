// Тесты раскладки колонок таблицы редакции.
//
// Модуль появился после того, как одна и та же ошибка случилась трижды:
// буквы колонок были зашиты в трёх местах, в набор добавили «Сегмент» и
// «Связки», и статусы поехали в «Приоритет», ссылки на доки — в «Зачем
// сейчас», а ID — в «Норма/дата». Тесты закрепляют инварианты, на
// которые опираются cycle-state, drive-sync и verify-sheet.
//
// Запуск: node --test scripts/lib/sheet-columns.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORK_COLS, WORK_HEADER_ROW, WORK_FIRST_DATA_ROW, APPROVAL_CELL,
  colLetter, workIdx, COL, RU_STATUS, PRIORITIES, isPriority,
} from './sheet-columns.mjs';

test('ключи колонок уникальны', () => {
  const keys = WORK_COLS.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, `дубли: ${keys.filter((k, i) => keys.indexOf(k) !== i)}`);
});

test('заголовки колонок уникальны — по ним идёт чтение таблицы', () => {
  const titles = WORK_COLS.map((c) => c.title.toLowerCase());
  assert.equal(new Set(titles).size, titles.length, `дубли: ${titles.filter((t, i) => titles.indexOf(t) !== i)}`);
});

test('colLetter считает буквы за пределами первой двадцатки', () => {
  assert.equal(colLetter(0), 'A');
  assert.equal(colLetter(25), 'Z');
  assert.equal(colLetter(26), 'AA');
  assert.equal(colLetter(27), 'AB');
});

test('COL и workIdx описывают одну и ту же колонку', () => {
  for (const c of WORK_COLS) {
    assert.equal(COL[c.key], colLetter(workIdx(c.key)), `${c.key} разъехался`);
  }
});

test('workIdx на неизвестном ключе возвращает -1, а не молча ноль', () => {
  assert.equal(workIdx('нет-такого'), -1);
});

// Регрессия 11.08.2026: статус писали в «Приоритет», ссылку на док — в
// «Зачем сейчас», ID — в «Норма/дата». Проверяем не буквы (они поедут при
// следующей правке набора), а то, что ключ ведёт к колонке с тем же
// смыслом.
test('ключевые колонки на своих местах по смыслу', () => {
  assert.equal(WORK_COLS[workIdx('status')].title, 'Статус');
  assert.equal(WORK_COLS[workIdx('doc')].title, 'Документ');
  assert.equal(WORK_COLS[workIdx('slug')].title, 'ID (не менять)');
  assert.equal(WORK_COLS[workIdx('decision')].title, 'Решение');
});

test('колонки редактора помечены владельцем — их нельзя перезаписывать', () => {
  const editorKeys = WORK_COLS.filter((c) => c.owner === 'editor').map((c) => c.key);
  for (const key of ['decision', 'who', 'note', 'reason']) {
    assert.ok(editorKeys.includes(key), `${key} должна принадлежать редактору`);
  }
});

test('ботовские колонки, которые нельзя отдавать редактору', () => {
  for (const key of ['status', 'doc', 'slug']) {
    assert.equal(WORK_COLS[workIdx(key)].owner, 'bot', `${key} должна быть ботовской`);
  }
});

test('данные начинаются строкой ниже заголовка', () => {
  assert.equal(WORK_FIRST_DATA_ROW, WORK_HEADER_ROW + 1);
  assert.match(APPROVAL_CELL, /^[A-Z]+\d+$/);
});

test('русские статусы покрывают все состояния темы', () => {
  for (const st of ['candidate', 'planned', 'writing', 'review', 'accepted', 'released', 'dropped']) {
    assert.ok(RU_STATUS[st], `нет перевода для ${st}`);
  }
  const values = Object.values(RU_STATUS);
  assert.equal(new Set(values).size, values.length, 'два статуса с одинаковой подписью не различить в таблице');
});

// Регрессия: приоритет из таблицы попадал в состояние как есть, и любая
// строка из чужой ячейки становилась «приоритетом» темы.
test('приоритет принимается только из набора', () => {
  assert.ok(isPriority('P0') && isPriority(' p2 '));
  assert.ok(!isPriority('высокий'));
  assert.ok(!isPriority(''));
  assert.ok(!isPriority(undefined));
  assert.deepEqual(PRIORITIES, ['P0', 'P1', 'P2']);
});
