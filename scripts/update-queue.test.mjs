// Тесты очереди актуализации.
//
// Очередь решает, какие чужие статьи пойдут в работу и в каком порядке.
// Ошибка здесь не видна глазом: список выглядит правдоподобно в любом
// случае — просто редакция получит не то, что просила, или получит
// дважды одно и то же.
//
// Запуск: node --test scripts/update-queue.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueue, toCandidate, extractUrls } from './update-queue.mjs';

const CATALOG = [
  { url: 'https://kontur.ru/market/spravka/82510-nds', title: 'НДС в общепите', rubric2: 'Общепит', viewsTotal: 68750 },
  { url: 'https://kontur.ru/market/spravka/38077-egais', title: 'ЕГАИС без ошибок', rubric2: 'Алкоголь', viewsTotal: 2486 },
];

test('ссылки вытаскиваются из свободного текста письма', () => {
  const urls = extractUrls('Освежить вот это: https://kontur.ru/a/1 и ещё https://kontur.ru/b/2.');
  assert.deepEqual(urls, ['https://kontur.ru/a/1', 'https://kontur.ru/b/2']);
});

test('очередь идёт по просмотрам: дорогая страница выше дешёвой', () => {
  const { rows } = buildQueue({
    urls: ['https://kontur.ru/market/spravka/38077-egais', 'https://kontur.ru/market/spravka/82510-nds'],
    catalog: CATALOG,
  });
  assert.deepEqual(rows.map((r) => r.sourceTitle), ['НДС в общепите', 'ЕГАИС без ошибок']);
});

// Одна и та же статья приходит в пачке дважды в разной форме — со
// слэшем, с utm-хвостом. По строке это разные ссылки, по делу одна.
test('повтор в пачке снимается по id, а не по строке ссылки', () => {
  const { rows, skipped } = buildQueue({
    urls: [
      'https://kontur.ru/market/spravka/82510-nds',
      'https://kontur.ru/market/spravka/82510-nds/',
      'https://kontur.ru/market/spravka/82510-nds?utm_source=mail',
    ],
    catalog: CATALOG,
  });
  assert.equal(rows.length, 1);
  assert.equal(skipped.duplicate.length, 2);
});

test('тема, уже заведённая в цикл, второй раз не заводится', () => {
  const { rows, skipped } = buildQueue({
    urls: ['https://kontur.ru/market/spravka/82510-nds'],
    catalog: CATALOG,
    plan: [{ slug: 'nds', status: 'writing', sourceUrl: 'https://kontur.ru/market/spravka/82510-nds' }],
  });
  assert.equal(rows.length, 0);
  assert.equal(skipped.inCycle[0].slug, 'nds');
});

// Темы, заведённые до разбора ячейки, поля sourceUrl не имеют: ссылка
// осталась внутри текста темы. Их тоже надо узнавать, иначе первая же
// пачка от редакции заведёт их по второму разу.
test('старая тема без sourceUrl узнаётся по ссылке внутри текста', () => {
  const { rows, skipped } = buildQueue({
    urls: ['https://kontur.ru/market/spravka/82510-nds'],
    catalog: CATALOG,
    plan: [{
      slug: 'staraya',
      status: 'review',
      title: 'Актуализировать статью https://kontur.ru/market/spravka/82510-nds Не менять актуальное',
    }],
  });
  assert.equal(rows.length, 0);
  assert.equal(skipped.inCycle[0].slug, 'staraya');
});

test('снятая тема не блокирует — её вернули в работу осознанно', () => {
  const { rows } = buildQueue({
    urls: ['https://kontur.ru/market/spravka/82510-nds'],
    catalog: CATALOG,
    plan: [{ slug: 'nds', status: 'dropped', sourceUrl: 'https://kontur.ru/market/spravka/82510-nds' }],
  });
  assert.equal(rows.length, 1);
});

// Совпадение с нашей статьёй — не блокер, а подсказка: её надо
// использовать как источник и перелинковать, а не переписывать заново.
test('наша статья по той же теме попадает в строку как связка', () => {
  const { rows } = buildQueue({
    urls: ['https://kontur.ru/market/spravka/38077-egais'],
    catalog: CATALOG,
    ours: [{ file: 'a.md', title: 'ЕГАИС без ошибок на кассе', draft: true, konturUrl: null }],
  });
  assert.equal(rows.length, 1, 'строка должна остаться в очереди');
  assert.equal(rows[0].related.length, 1);
});

test('связка находится и по konturUrl, когда заголовки разные', () => {
  const { rows } = buildQueue({
    urls: ['https://kontur.ru/market/spravka/38077-egais'],
    catalog: CATALOG,
    ours: [{
      file: 'a.md', title: '7 ошибок на кассе: касса не пропускает продажу', draft: true,
      konturUrl: 'https://kontur.ru/market/spravka/38077-egais',
    }],
  });
  assert.equal(rows[0].related.length, 1);
});

test('ссылки нет в каталоге — строка остаётся, но помечена', () => {
  const { rows, skipped } = buildQueue({
    urls: ['https://kontur.ru/market/spravka/999999-net'],
    catalog: CATALOG,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inCatalog, false);
  assert.equal(skipped.unknown.length, 1);
});

test('приоритет ставится по трафику страницы', () => {
  const p = (views) => toCandidate({ sourceUrl: 'u', sourceTitle: 'T', views, rubric: null }).priority;
  assert.equal(p(68750), 'P0');
  assert.equal(p(9000), 'P1');
  assert.equal(p(120), 'P2');
});

test('кандидат несёт ссылку явно — разбирать текст заново не нужно', () => {
  const c = toCandidate({ sourceUrl: 'https://kontur.ru/market/spravka/82510-nds', sourceTitle: 'НДС в общепите', views: 68750, rubric: 'Общепит' });
  assert.equal(c.sourceUrl, 'https://kontur.ru/market/spravka/82510-nds');
  assert.equal(c.title, 'Актуализация: НДС в общепите');
  assert.match(c.why, /68\s?750/);
});
