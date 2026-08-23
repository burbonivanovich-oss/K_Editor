// Тесты метрик редакционного процесса.
//
// Метрики измеряют внешние сигналы: переделки редакции, отказы,
// выкинутые промоблоки, повторяемость корпуса. Их нельзя подделать
// изнутри контура — в отличие от балла, который ставит тот же контур,
// который писал.
//
// Запуск: node --test scripts/editorial-metrics.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reworkMetrics, dropMetrics, promoMetrics, editorialMetrics } from './editorial-metrics.mjs';

function withRepo(files, fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ed-metrics-')));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('журнала правок нет — так и говорим, а не показываем ноль', () => {
  withRepo({}, (dir) => {
    const r = reworkMetrics(dir);
    assert.match(r.note, /журнала правок ещё нет/);
    assert.equal(r.entries, 0);
  });
});

test('переделки считаются по статьям и по видам', () => {
  const journal = [
    '# Что редакция правит руками', '',
    '## 2026-08-14 · 2026-08-13-korrekciya-cheka', '',
    '**Переписали абзац.**', '', '- Было: старое', '- Стало: новое', '',
    '**Убрали абзац.** лишний', '',
    '## 2026-08-15 · 2026-08-13-oshibki-ts-piot', '',
    '**Переписали абзац.**', '', '- Было: а', '- Стало: б', '',
  ].join('\n');
  withRepo({ 'docs/editorial-feedback.md': journal }, (dir) => {
    const r = reworkMetrics(dir);
    assert.equal(r.entries, 2);
    assert.equal(r.articles, 2);
    assert.equal(r.byKind['переписали абзац'], 2);
    assert.equal(r.byKind['убрали абзац'], 1);
  });
});

test('отказы считаются долей от плана', () => {
  const state = { plan: [
    { slug: 'a', status: 'dropped' },
    { slug: 'b', status: 'dropped', docId: 'doc-1' },
    { slug: 'c', status: 'released' },
    { slug: 'd', status: 'planned' },
  ] };
  withRepo({ 'src/data/editorial-cycle.json': JSON.stringify(state) }, (dir) => {
    const r = dropMetrics(dir);
    assert.equal(r.dropped, 2);
    assert.equal(r.total, 4);
    assert.equal(r.share, 0.5);
    assert.equal(r.droppedAfterWork, 1, 'снятая после начала работы тема стоит дороже');
  });
});

/* Промоблок, выкинутый из готового текста, — прямой сигнал: подводка не
 * была нужна читателю. Считается по разнице «план против текста». */
test('выкинутый промоблок виден', () => {
  const plan = ['# План', '', '## Подводки к промоблокам', '',
    '| После раздела | id |', '|---|---|', '| «Один» | `8526` |', '| «Два» | `8530` |', ''].join('\n');
  const article = ['---', 'title: "Т"', '---', '', 'Текст.', '', '[Промоблок: 8526]', ''].join('\n');
  withRepo({ 'src/data/visuals/a.md': plan, 'src/content/blog/a.md': article }, (dir) => {
    const r = promoMetrics(dir);
    assert.equal(r.planned, 2);
    assert.equal(r.kept, 1);
    assert.equal(r.removed, 1);
    assert.deepEqual(r.byArticle[0].removed, ['8530']);
  });
});

test('числа из других разделов плана за промоблоки не считаются', () => {
  const plan = ['# План', '', '## Иллюстрации', '', 'Нужен скриншот тега `1162`.', '',
    '## Подводки к промоблокам', '', '| «Один» | `8526` |', ''].join('\n');
  const article = ['---', 'title: "Т"', '---', '', '[Промоблок: 8526]', ''].join('\n');
  withRepo({ 'src/data/visuals/a.md': plan, 'src/content/blog/a.md': article }, (dir) => {
    const r = promoMetrics(dir);
    assert.equal(r.planned, 1, 'номер тега попал в счёт промоблоков');
    assert.equal(r.removed, 0);
  });
});

test('срез собирается целиком и не падает на пустом репозитории', () => {
  withRepo({}, (dir) => {
    const m = editorialMetrics(dir);
    assert.equal(m.drops.total, 0);
    assert.equal(m.promo.planned, 0);
    assert.equal(m.repetition.articles, 0);
  });
});
