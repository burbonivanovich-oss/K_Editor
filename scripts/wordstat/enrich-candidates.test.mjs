/**
 * Формат кеша динамики: по фразе на строку.
 *
 * Файл коммитится еженедельно и к 24.08.2026 занял 16 МБ git-истории при
 * 6,3 МБ на диске — больше, чем весь остальной репозиторий. Удалить его
 * из git нельзя: это кеш платной квоты Wordstat (REMEASURE_DAYS,
 * cacheVersion). Значит, единственное, что можно менять, — форма записи.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeDynamics } from './enrich-candidates.mjs';

const sample = {
  generatedAt: '2026-08-24T00:00:00.000Z',
  period: { from: '2026-05-04T00:00:00Z', to: '2026-08-16T00:00:00Z' },
  coverage: { measured: 2, pool: 10 },
  items: [
    { phrase: 'маркировка шин', count: 1200, history: [{ w: '2026-08-10', count: 600 }] },
    { phrase: 'остатки егаис', count: 900, history: [] },
  ],
};

test('результат разбирается обратно без потерь', () => {
  assert.deepEqual(JSON.parse(serializeDynamics(sample)), sample);
});

test('одна фраза — одна строка: дифф показывает изменённую запись, а не весь файл', () => {
  const lines = serializeDynamics(sample).split('\n');
  const itemLines = lines.filter((l) => l.trim().startsWith('{"phrase"'));
  assert.equal(itemLines.length, sample.items.length);
});

test('шапка остаётся читаемой', () => {
  const out = serializeDynamics(sample);
  assert.match(out, /^\{\n  "generatedAt": "2026-08-24T00:00:00\.000Z",\n/);
  assert.match(out, /\n  "coverage": \{\n    "measured": 2,/);
});

test('пустой список фраз даёт валидный JSON', () => {
  const out = serializeDynamics({ generatedAt: 'x', period: {}, coverage: {}, items: [] });
  assert.deepEqual(JSON.parse(out).items, []);
});

test('форма компактнее прежней записи с отступом в два пробела', () => {
  const before = JSON.stringify(sample, null, 2) + '\n';
  assert.ok(serializeDynamics(sample).length < before.length);
});

test('файл заканчивается переводом строки', () => {
  assert.ok(serializeDynamics(sample).endsWith('\n'));
});
