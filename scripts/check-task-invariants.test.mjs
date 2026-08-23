// Тесты инвариантов задачи: чем тему завели, тем она и остаётся.
//
// Оба случая из внешнего аудита воспроизведены буквально: тема, у
// которой в ячейке «Актуализировать статью https://…», а в состоянии
// `kind: "new"`, и тема на актуализацию, материализованная новой
// статьёй в блоге при пустом src/content/updates/.
//
// Запуск: node --test scripts/check-task-invariants.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTaskInvariants } from './check-task-invariants.mjs';

const UPDATE_CELL = 'Актуализировать статью https://kontur.ru/market/spravka/38077-egais '
  + 'Не менять актуальное, только предложить правки.';

function withRepo(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'task-inv-')));
  for (const d of ['src/content/blog', 'src/content/updates']) mkdirSync(join(dir, d), { recursive: true });
  const addArticle = (slug) => writeFileSync(join(dir, 'src/content/blog', `2026-08-13-${slug}.md`), '---\ntitle: "Т"\n---\n\nТекст.\n');
  const addDoc = (slug) => writeFileSync(join(dir, 'src/content/updates', `2026-08-13-${slug}.md`), '# Правки\n');
  try { return fn(dir, addArticle, addDoc); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const codes = (state, dir) =>
  checkTaskInvariants(state, { root: dir, runDocCheck: false }).map((p) => p.code);

const plan = (over) => ({ plan: [{ slug: 'a', status: 'review', ...over }] });

test('обычная тема со статьёй проходит', () => {
  withRepo((dir, addArticle) => {
    addArticle('a');
    assert.deepEqual(codes(plan({ kind: 'new', title: 'Как настроить кассу' }), dir), []);
  });
});

test('задача на актуализацию с документом проходит', () => {
  withRepo((dir, addArticle, addDoc) => {
    addDoc('a');
    assert.deepEqual(codes(plan({
      kind: 'update', sourceUrl: 'https://kontur.ru/market/spravka/38077-egais', title: 'Актуализация: ЕГАИС',
      rawTopic: UPDATE_CELL,
    }), dir), []);
  });
});

/* Ровно случай из аудита: задача на актуализацию, а материализована
 * новой статьёй в блоге. src/content/updates/ при этом пуст. */
test('актуализация, превратившаяся в новую статью, — находка', () => {
  withRepo((dir, addArticle) => {
    addArticle('a');
    const found = codes(plan({
      kind: 'update', sourceUrl: 'https://kontur.ru/market/spravka/38077-egais', rawTopic: UPDATE_CELL,
    }), dir);
    assert.ok(found.includes('materialized-as-article'), found.join(', '));
    assert.ok(found.includes('no-update-doc'), found.join(', '));
  });
});

/* Второй случай: директива осталась только в originalTitle, потому что
 * заголовок темы потом переписали. Смотреть надо все виды ячейки. */
test('подмена типа видна, даже если заголовок уже переписали', () => {
  withRepo((dir, addArticle) => {
    addArticle('a');
    const found = codes(plan({
      kind: 'new',
      originalTitle: UPDATE_CELL,
      rawTopic: '7 ошибок ЕГАИС: что делать, если касса не пропускает продажу',
      title: '7 ошибок ЕГАИС: что делать, если касса не пропускает продажу',
    }), dir);
    assert.ok(found.includes('kind-drift'), found.join(', '));
  });
});

test('исходная ссылка у задачи на актуализацию обязательна', () => {
  withRepo((dir, addArticle, addDoc) => {
    addDoc('a');
    assert.ok(codes(plan({ kind: 'update', title: 'Актуализация: без ссылки' }), dir).includes('no-source'));
  });
});

test('исходная ссылка у обычной темы — признак подмены типа', () => {
  withRepo((dir, addArticle) => {
    addArticle('a');
    assert.ok(codes(plan({ kind: 'new', sourceUrl: 'https://kontur.ru/market/spravka/1-x', title: 'Т' }), dir)
      .includes('source-on-new'));
  });
});

test('расхождение, записанное cycle-state, попадает в отчёт', () => {
  withRepo((dir, addArticle) => {
    addArticle('a');
    const found = codes(plan({
      kind: 'update', sourceUrl: 'https://kontur.ru/market/spravka/38077-egais',
      rawTopic: UPDATE_CELL, kindConflict: { declared: 'new', at: '2026-08-21' },
    }), dir);
    assert.ok(found.includes('kind-conflict'), found.join(', '));
  });
});

test('снятая тема не проверяется — работы по ней не будет', () => {
  withRepo((dir) => {
    assert.deepEqual(codes({ plan: [{ slug: 'a', status: 'dropped', kind: 'update' }] }, dir), []);
  });
});

test('тема в статусе review без материала — находка', () => {
  withRepo((dir) => {
    assert.ok(codes(plan({ kind: 'new', title: 'Т' }), dir).includes('no-article'));
  });
});
