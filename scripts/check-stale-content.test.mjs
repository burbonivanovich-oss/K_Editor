// Тесты поиска статей, которые пора пересмотреть.
//
// Проверка отвечает на вопрос «что устарело» — и ошибается в обе стороны
// одинаково дорого: пропустит статью с истёкшей нормой или пригонит в
// очередь свежие тексты, после чего очередь перестанут читать.
//
// Запуск: node --test scripts/check-stale-content.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-stale-content.mjs');

/** Дата на N месяцев назад — чтобы тест не протухал вместе с календарём. */
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

function withRepo(articles, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'stale-test-'));
  mkdirSync(join(dir, 'src/content/blog'), { recursive: true });
  for (const [name, body] of Object.entries(articles)) {
    writeFileSync(join(dir, 'src/content/blog', name), body);
  }
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(dir) {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT], { encoding: 'utf8', env: { ...process.env, STALE_ROOT: dir } }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const article = ({ pubDate, updatedDate = null, draft = false }) =>
  ['---', 'title: "Т"', `pubDate: "${pubDate}"`]
    .concat(updatedDate ? [`updatedDate: "${updatedDate}"`] : [])
    .concat([`draft: ${draft}`, '---', 'Текст статьи.'])
    .join('\n');

test('свежая статья не попадает в список', () => {
  withRepo({ 'a.md': article({ pubDate: monthsAgo(1) }) }, (dir) => {
    const r = run(dir);
    assert.match(r.out, /актуальны/i);
  });
});

test('статья старше полугода попадает', () => {
  withRepo({ 'a.md': article({ pubDate: monthsAgo(8) }) }, (dir) => {
    const r = run(dir);
    assert.ok(!/актуальны/i.test(r.out), `должна была найтись:\n${r.out}`);
    assert.match(r.out, /a/);
  });
});

// Обновление сдвигает точку отсчёта: иначе статья, которую переписали
// вчера, вечно числится устаревшей по дате первой публикации.
test('дата обновления важнее даты публикации', () => {
  withRepo({ 'a.md': article({ pubDate: monthsAgo(12), updatedDate: monthsAgo(1) }) }, (dir) => {
    assert.match(run(dir).out, /актуальны/i);
  });
});

test('черновики не проверяются — они ещё не выпущены', () => {
  withRepo({ 'a.md': article({ pubDate: monthsAgo(12), draft: true }) }, (dir) => {
    const r = run(dir);
    assert.ok(!/^\s+a/m.test(r.out), `черновик не должен попадать:\n${r.out}`);
  });
});

test('пустой блог — понятный ответ, а не молчание', () => {
  withRepo({}, (dir) => {
    const r = run(dir);
    assert.equal(r.code, 0);
    assert.ok(r.out.trim().length > 0, 'скрипт не должен молчать');
  });
});
