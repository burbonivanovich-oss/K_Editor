// Тесты проверки документа актуализации.
//
// Каждый тест — про способ незаметно сдать не ту работу: правка без
// цитаты, правка без источника, молчание о том, что оставили как есть,
// промо голой ссылкой без подводки.
//
// Запуск: node --test scripts/check-update-doc.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUpdateDoc } from './check-update-doc.mjs';

const FM = [
  '---',
  'kind: update',
  'sourceUrl: "https://kontur.ru/market/spravka/38077-egais"',
  'sourceTitle: "Как работать в ЕГАИС без ошибок"',
  'checkedAt: "2026-08-13"',
  'verdict: needs-update',
  '---',
].join('\n');

const EDIT = [
  '## Правки',
  '',
  '### Правка 1 — лимит постановки на баланс',
  '',
  '**Было:**',
  '> Поставить на баланс можно не более 100 бутылок в месяц.',
  '',
  '**Стало:**',
  'Лимит отменён с 01.01.2026.',
  '',
  '**Почему:** норма изменена — https://publication.pravo.gov.ru/Document/View/123 (01.01.2026)',
].join('\n');

const KEEP = ['## Что оставить как есть', '', '- Раздел «Что такое УТМ» — актуален, проверено по ФСРАР.'].join('\n');

const doc = (...parts) => [FM, '', ...parts].join('\n\n');
const problems = (text) => checkUpdateDoc(text).map((p) => p.problem).join(' | ');

test('полный документ проходит проверку', () => {
  assert.deepEqual(checkUpdateDoc(doc(EDIT, KEEP)), []);
});

test('без frontmatter документ не привязан к статье', () => {
  assert.match(problems('## Правки\n\n### Правка 1'), /нет frontmatter/);
});

test('без ссылки на исходную статью документ бесполезен', () => {
  assert.match(problems(doc(EDIT, KEEP).replace(/sourceUrl:.*\n/, '')), /нет поля sourceUrl/);
});

// Именно этот сценарий случился 13.08.2026: задача на актуализацию,
// а на выходе — текст без единой привязки к исходной статье.
test('вердикт «нужна актуализация» без единой правки — незаконченная работа', () => {
  assert.match(problems(doc(KEEP)), /нет ни одной/);
});

test('правка без цитаты «Было» не показывает, что меняем', () => {
  const noQuote = EDIT.replace('**Было:**\n> Поставить на баланс можно не более 100 бутылок в месяц.\n\n', '');
  assert.match(problems(doc(noQuote, KEEP)), /нет блока «Было»/);
});

test('«Было» без оформления цитатой не даёт отличить исходный текст от нашего', () => {
  const flat = EDIT.replace('> Поставить', 'Поставить');
  assert.match(problems(doc(flat, KEEP)), /не оформлено цитатой/);
});

test('правка без источника — вкусовщина, а не актуализация', () => {
  const noSrc = EDIT.replace(/\*\*Почему:\*\* .*/, '**Почему:** так будет понятнее');
  assert.match(problems(doc(noSrc, KEEP)), /нет ссылки на источник/);
});

// Прямая просьба редакции: «не менять то, что ещё актуально».
test('молчание о том, что оставили как есть, — нарушение просьбы редакции', () => {
  assert.match(problems(doc(EDIT)), /«Что оставить как есть» пуст/);
});

test('вердикт «актуальна» вместе с правками — забыли переставить одно из двух', () => {
  const upToDate = doc(EDIT, KEEP).replace('verdict: needs-update', 'verdict: up-to-date');
  assert.match(problems(upToDate), /вердикт up-to-date, но правок/);
});

test('статья не устарела — пустой документ с вердиктом up-to-date проходит', () => {
  const clean = [FM.replace('verdict: needs-update', 'verdict: up-to-date'), '',
    '## Что изменилось с момента публикации', '', 'Ничего: нормы в силе, даты не сдвигались.'].join('\n');
  assert.deepEqual(checkUpdateDoc(clean), []);
});

test('промо без подводки — голая ссылка, редакция просила не так', () => {
  const promo = ['## Промо Маркета', '', '### Место 1 — после раздела «Ошибки УТМ»', '',
    '**Ссылка:** https://kontur.ru/market'].join('\n');
  assert.match(problems(doc(EDIT, KEEP, promo)), /нет подводки/);
});

test('промо с подводкой и ссылкой проходит', () => {
  const promo = ['## Промо Маркета', '', '### Место 1 — после раздела «Ошибки УТМ»', '',
    '**Подводка:** Проверять остатки вручную дорого — в Маркете сверка идёт автоматически.', '',
    '**Ссылка:** https://kontur.ru/market'].join('\n');
  assert.deepEqual(checkUpdateDoc(doc(EDIT, KEEP, promo)), []);
});

test('неизвестный вердикт называется прямо', () => {
  assert.match(problems(doc(EDIT, KEEP).replace('verdict: needs-update', 'verdict: ok')), /verdict «ok»/);
});
