// Тесты сравнения тем по словам.
//
// На этом модуле держатся три разных решения: схлопывать ли кандидатов в
// бэклоге, писали ли мы уже про это, пересекается ли тема с каталогом
// Маркета. Пороги там разные (0.3, 0.4, 0.5, 0.6), и смысл у них есть
// только пока сравнение ведёт себя предсказуемо. Тесты фиксируют
// поведение, а не конкретные числа: числа настраиваются, поведение — нет.
//
// Запуск: node --test scripts/lib/text-similarity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, jaccard, topMatches } from './text-similarity.mjs';

test('регистр и пунктуация не влияют на разбор', () => {
  assert.deepEqual(
    [...tokenize('Маркировка, ОБУВИ: в рознице!')].sort(),
    [...tokenize('маркировка обуви в рознице')].sort(),
  );
});

test('служебные слова выброшены — иначе совпадают несвязанные темы', () => {
  const t = tokenize('касса для аптеки и в магазине');
  assert.ok(!t.has('для') && !t.has('и') && !t.has('в'));
  assert.ok(t.has('касса') && t.has('аптеки'));
});

test('год выброшен: «в 2026 году» есть в половине заголовков', () => {
  const t = tokenize('Маркировка в 2026 году');
  assert.ok(!t.has('году') && !t.has('год'));
});

test('одинаковые темы дают единицу, несвязанные — ноль', () => {
  const a = tokenize('маркировка обуви в рознице');
  assert.equal(jaccard(a, tokenize('Маркировка обуви в рознице')), 1);
  assert.equal(jaccard(a, tokenize('кадровый учёт удалённых сотрудников')), 0);
});

test('перестановка слов не меняет похожесть — сравнение по множеству', () => {
  const a = tokenize('честный знак маркировка товара');
  const b = tokenize('маркировка товара честный знак');
  assert.equal(jaccard(a, b), 1);
});

// Соседние темы одного кластера должны отличаться от переформулировок:
// на этом стоит порог схлопывания дублей 0.4.
test('переформулировка ближе к оригиналу, чем соседняя тема кластера', () => {
  const base = tokenize('маркировка обуви в рознице');
  const rephrased = jaccard(base, tokenize('обувь маркировка розница'));
  const neighbour = jaccard(base, tokenize('маркировка молочной продукции на складе'));
  assert.ok(rephrased > neighbour, `переформулировка ${rephrased} должна быть выше соседней ${neighbour}`);
  assert.ok(neighbour < 0.4, `соседняя тема не должна схлопываться: ${neighbour}`);
});

test('пустой вход не делит на ноль', () => {
  assert.equal(jaccard(tokenize(''), tokenize('')), 0);
  assert.equal(jaccard(tokenize('касса'), tokenize('')), 0);
});

test('topMatches сортирует по убыванию и режет по порогу', () => {
  const catalog = [
    { title: 'Маркировка обуви: что обязана делать розница', url: 'a' },
    { title: 'Маркировка молочной продукции', url: 'b' },
    { title: 'Кадровый учёт удалённых сотрудников', url: 'c' },
  ];
  const hits = topMatches('маркировка обуви в рознице', catalog, { threshold: 0.2 });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].url, 'a');
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score, 'порядок по убыванию нарушен');
  }
  assert.ok(!hits.some((h) => h.url === 'c'), 'несвязанная статья не должна проходить порог');
});

test('topMatches уважает limit', () => {
  const catalog = Array.from({ length: 10 }, (_, i) => ({ title: `маркировка обуви ${i}`, url: `u${i}` }));
  assert.equal(topMatches('маркировка обуви', catalog, { threshold: 0.1, limit: 3 }).length, 3);
});
