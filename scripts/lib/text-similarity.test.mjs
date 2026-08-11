import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, jaccard, topMatches } from './text-similarity.mjs';

test('tokenize: убирает стоп-слова и короткие токены', () => {
  const t = tokenize('Что такое ТС ПИоТ и кому нужно подключить');
  assert.ok(!t.has('что'));
  assert.ok(!t.has('и'));
  assert.ok(t.has('пиот'));
  assert.ok(t.has('подключить'));
});

test('jaccard: идентичные множества дают 1', () => {
  const a = new Set(['пиот', 'касса']);
  assert.equal(jaccard(a, new Set(a)), 1);
});

test('jaccard: непересекающиеся множества дают 0', () => {
  assert.equal(jaccard(new Set(['а', 'б']), new Set(['в', 'г'])), 0);
});

test('jaccard: пустые множества не делят на ноль', () => {
  assert.equal(jaccard(new Set(), new Set()), 0);
});

test('topMatches: находит совпадение выше порога, сортирует по убыванию score', () => {
  const catalog = [
    { title: 'Что такое ТС ПИоТ', url: 'a' },
    { title: 'Всё о ТС ПИоТ: кому нужно подключить и в какие сроки', url: 'b' },
    { title: 'Как открыть кофейню', url: 'c' },
  ];
  const res = topMatches('Что такое ТС ПИоТ и кому нужно подключить', catalog);
  assert.ok(res.length >= 1);
  assert.equal(res[0].url, 'a');
  assert.ok(res.every((r) => r.score >= 0.3));
  assert.ok(!res.some((r) => r.url === 'c'));
});

test('topMatches: уважает limit', () => {
  const catalog = Array.from({ length: 10 }, (_, i) => ({
    title: `Маркировка честный знак тема номер ${i}`,
  }));
  const res = topMatches('маркировка честный знак', catalog, { limit: 3 });
  assert.equal(res.length, 3);
});

// Разрешение внутренних ссылок статьи в кликабельные адреса.
// Регрессия: «/blog/<слаг>» уходил в Google Doc как есть, Google достраивал
// схему и получалось «http:///blog/…» — битая ссылка в каждом документе.
test('resolve-links: внешняя ссылка отдаётся как есть', async () => {
  const { resolveInternalLink } = await import('./resolve-links.mjs');
  assert.deepEqual(resolveInternalLink('https://kontur.ru/x'), { url: 'https://kontur.ru/x', via: 'external' });
});

test('resolve-links: BLOG_BASE_URL главнее каталога', async () => {
  const { resolveInternalLink } = await import('./resolve-links.mjs');
  const r = resolveInternalLink('/blog/чего-нет', { blogBase: 'https://example.ru/' });
  assert.deepEqual(r, { url: 'https://example.ru/blog/чего-нет', via: 'base' });
});

test('resolve-links: без домена и без совпадения ссылки нет', async () => {
  const { resolveInternalLink } = await import('./resolve-links.mjs');
  assert.equal(resolveInternalLink('/blog/2099-01-01-nesushchestvuyushchaya-statya', { blogBase: '' }), null);
});
