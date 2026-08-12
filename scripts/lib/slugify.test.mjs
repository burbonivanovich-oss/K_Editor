// Тесты транслитерации заголовка в slug.
//
// Slug — первичный ключ темы: по нему сопоставляются строка таблицы,
// запись в состоянии цикла и файл статьи. Когда транслитерация жила в
// двух местах и разошлась, колонка «ID» оказалась пустой, и все темы
// разом стали «пропавшими из таблицы». Отсюда общий модуль и эти тесты.
//
// Запуск: node --test scripts/lib/slugify.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './slugify.mjs';

test('кириллица переходит в латиницу без пробелов', () => {
  assert.equal(slugify('Маркировка шин'), 'markirovka-shin');
});

test('одинаковый заголовок даёт одинаковый slug', () => {
  const title = 'Личный кабинет онлайн-кассы: как войти';
  assert.equal(slugify(title), slugify(title));
});

test('регистр и лишние пробелы не меняют результат', () => {
  assert.equal(slugify('  ТС ПИоТ:   что это  '), slugify('тс пиот: что это'));
});

test('пунктуация не попадает в slug', () => {
  const s = slugify('Что такое ТС ПИоТ? Кому нужен, и «как» подключить!');
  assert.match(s, /^[a-z0-9-]+$/, `в slug просочилось лишнее: ${s}`);
  assert.ok(!s.includes('--'), 'двойных дефисов быть не должно');
  assert.ok(!s.startsWith('-') && !s.endsWith('-'), 'дефис по краям');
});

test('ё и й не теряются', () => {
  assert.match(slugify('Ёмкость и йогурт'), /^[a-z0-9-]+$/);
  assert.notEqual(slugify('Ёмкость'), '');
});

test('разные заголовки дают разные slug', () => {
  assert.notEqual(
    slugify('Маркировка обуви в рознице'),
    slugify('Маркировка одежды в рознице'),
  );
});

test('цифры и латиница сохраняются', () => {
  const s = slugify('НДС 22% с 2026 года и ТС ПИоТ');
  assert.match(s, /22/);
  assert.match(s, /2026/);
});

test('пустой и мусорный вход не роняют', () => {
  assert.equal(typeof slugify(''), 'string');
  assert.equal(typeof slugify('—————'), 'string');
  assert.equal(typeof slugify(undefined), 'string');
});

// Slug уезжает в имя файла и в ячейку таблицы: неограниченная длина
// ломает и то и другое.
test('slug не бесконечный', () => {
  const long = slugify('Очень длинный заголовок '.repeat(20));
  assert.ok(long.length <= 120, `slug длиной ${long.length} символов`);
});
