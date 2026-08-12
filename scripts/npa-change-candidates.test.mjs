// Тесты сбора фактуры для отчёта «где поменялась нормативка».
//
// Регрессия 12.08.2026: постановления Правительства не находились вообще —
// «постановлени\w*» не совпадает с кириллическим окончанием, потому что
// \w в JS это [A-Za-z0-9_]. В отчёте для юриста систематически не было
// целого класса норм, а именно постановления правят чаще всего.
//
// Запуск: node --test scripts/npa-change-candidates.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'npa-change-candidates.mjs');

function withRepo(articles, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'npa-candidates-test-'));
  mkdirSync(join(dir, 'src/content/blog'), { recursive: true });
  mkdirSync(join(dir, 'src/data/factcheck'), { recursive: true });
  writeFileSync(join(dir, 'src/data/factcheck/sources.json'), JSON.stringify({ npaWhitelist: { fz: {}, pp: {}, prikaz: {} } }));
  for (const [name, body] of Object.entries(articles)) {
    writeFileSync(join(dir, 'src/content/blog', name), body);
  }
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(dir, args = ['--json']) {
  const out = execFileSync('node', [SCRIPT, ...args], {
    encoding: 'utf8', env: { ...process.env, NPA_ROOT: dir },
  });
  return args.includes('--json') ? JSON.parse(out).rows : out;
}

const article = (body, { draft = false } = {}) =>
  `---\ntitle: "Т"\npubDate: "2026-08-01"\nreviewDate: "2027-02-01"\ncategories:\n  - kkt\ndraft: ${draft}\n---\n${body}\n`;

test('федеральный закон попадает в список норм', () => {
  withRepo({ 'a.md': article('Согласно 54-ФЗ касса передаёт чек.') }, (dir) => {
    const r = run(dir);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].norms, ['ФЗ-54']);
  });
});

// Собственно регрессия: три падежные формы, все должны находиться.
test('постановление находится в любой падежной форме', () => {
  withRepo({
    'a.md': article('установлено постановлением Правительства РФ от 21.11.2023 № 1944.'),
    'b.md': article('по пункту 19 постановления Правительства РФ № 303.'),
    'c.md': article('см. постановление Правительства РФ № 1674.'),
  }, (dir) => {
    const norms = run(dir).flatMap((a) => a.norms).sort();
    assert.deepEqual(norms, ['ПП-1674', 'ПП-1944', 'ПП-303']);
  });
});

test('короткая запись «ПП № 303» тоже считается', () => {
  withRepo({ 'a.md': article('см. ПП № 303 про маркировку.') }, (dir) => {
    assert.deepEqual(run(dir)[0].norms, ['ПП-303']);
  });
});

test('статья без норм в отчёт не попадает', () => {
  withRepo({ 'a.md': article('Просто текст про кассы без ссылок на нормы.') }, (dir) => {
    assert.deepEqual(run(dir), []);
  });
});

test('черновики не попадают: отчёт про то, что уже выпущено', () => {
  withRepo({ 'a.md': article('Согласно 54-ФЗ.', { draft: true }) }, (dir) => {
    assert.deepEqual(run(dir), []);
  });
});

test('одна норма, упомянутая дважды, не задваивается', () => {
  withRepo({ 'a.md': article('54-ФЗ говорит одно, а 54-ФЗ в другой редакции — другое.') }, (dir) => {
    assert.deepEqual(run(dir)[0].norms, ['ФЗ-54']);
  });
});
