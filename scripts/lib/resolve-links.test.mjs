// Тесты разворачивания внутренних ссылок статьи.
//
// Живой случай: в документах редактора перелинковка приезжала как
// `http:///blog/…` — адреса принимающего проекта у модуля нет, а ссылку
// всё равно печатали. Теперь варианта три: домен задан переменной, статья
// сама называет свою пару в справке Контура, или пара находится по
// каталогу. Не нашлось — ссылки нет вовсе, и это правильный ответ, а не
// ошибка.
//
// Запуск: node --test scripts/lib/resolve-links.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInternalLink, MATCH_THRESHOLD } from './resolve-links.mjs';

test('внешняя ссылка возвращается как есть', () => {
  const r = resolveInternalLink('https://www.consultant.ru/document/cons_doc_LAW_1/');
  assert.equal(r.via, 'external');
  assert.equal(r.url, 'https://www.consultant.ru/document/cons_doc_LAW_1/');
});

test('домен принимающего проекта задан — внутренняя ссылка становится абсолютной', () => {
  const r = resolveInternalLink('/blog/chto-takoe-ts-piot/', { blogBase: 'https://example.ru' });
  assert.equal(r.via, 'base');
  assert.equal(r.url, 'https://example.ru/blog/chto-takoe-ts-piot/');
});

test('хвостовой слеш в домене не даёт двойного слеша', () => {
  const r = resolveInternalLink('/blog/x/', { blogBase: 'https://example.ru/' });
  assert.equal(r.url, 'https://example.ru/blog/x/');
});

// Регрессия: домена нет, а ссылку всё равно печатали — получался
// `http:///blog/…`, по которому нельзя кликнуть.
test('домена нет и статья неизвестна — ссылки не будет, а не пустой адрес', () => {
  const r = resolveInternalLink('/blog/statya-kotoroy-net/', { blogBase: '' });
  assert.equal(r, null);
});

test('статья называет свою пару в справке Контура — берём её', () => {
  const r = resolveInternalLink('/blog/2026-08-06-chto-takoe-ts-piot/', { blogBase: '' });
  assert.equal(r.via, 'frontmatter');
  assert.match(r.url, /^https:\/\/support\.kontur\.ru\//);
});

// Регрессия, найденная этими же тестами 12.08.2026: слеш на конце не
// срезался, и ссылка «/blog/chto-takoe-ts-piot/» не находила статью
// вообще — ни адреса Контура, ни совпадения по каталогу. В корпусе таких
// ссылок было семь из десяти.
test('хвостовой слеш не мешает найти статью', () => {
  const withSlash = resolveInternalLink('/blog/2026-08-06-chto-takoe-ts-piot/', { blogBase: '' });
  const withoutSlash = resolveInternalLink('/blog/2026-08-06-chto-takoe-ts-piot', { blogBase: '' });
  assert.deepEqual(withSlash, withoutSlash);
  assert.equal(withSlash.via, 'frontmatter');
});

test('slug без даты находит ту же статью', () => {
  const withDate = resolveInternalLink('/blog/2026-08-06-chto-takoe-ts-piot/', { blogBase: '' });
  const withoutDate = resolveInternalLink('/blog/chto-takoe-ts-piot/', { blogBase: '' });
  assert.deepEqual(withoutDate, withDate);
});

test('порог совпадения с каталогом остаётся осознанным числом', () => {
  assert.ok(MATCH_THRESHOLD > 0.3 && MATCH_THRESHOLD <= 0.7, `порог ${MATCH_THRESHOLD} выглядит случайным`);
});

test('якорь и относительный путь не считаются внешней ссылкой', () => {
  assert.equal(resolveInternalLink('/category/kkt', { blogBase: 'https://example.ru' }).url,
    'https://example.ru/category/kkt');
});
