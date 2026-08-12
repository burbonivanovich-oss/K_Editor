// Тесты проверки «у выпущенной статьи факчек доведён до отчёта».
//
// Случай не выдуманный: 12.08.2026 пять статей из шести имели маркер с
// result: null — процедура доходила до write-marker, шаг с отчётом
// пропускала, и все гейты читали маркер как «проверено».
//
// Запуск: node --test scripts/factcheck/audit-marker-results.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'audit-marker-results.mjs');

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'marker-results-test-'));
  mkdirSync(join(dir, 'src/content/blog'), { recursive: true });
  mkdirSync(join(dir, 'src/data/factcheck/results'), { recursive: true });
  mkdirSync(join(dir, '.claude/factchecked'), { recursive: true });
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir, args = []) {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8', env: { ...process.env, FACTCHECK_ROOT: dir },
    }) };
  } catch (e) {
    return { code: e.status, out: e.stdout };
  }
}

function article(dir, slug, draft = false) {
  writeFileSync(
    join(dir, 'src/content/blog', `${slug}.md`),
    `---\ntitle: "T"\ndraft: ${draft}\n---\nТекст.\n`,
  );
}

function marker(dir, slug, extra = {}) {
  const report = `src/data/factcheck/results/${slug}.json`;
  writeFileSync(join(dir, '.claude/factchecked', slug),
    JSON.stringify({ date: '2026-08-12', hash: 'x', result: 'passed', criticalMismatches: 0, report, ...extra }));
}

function report(dir, slug) {
  writeFileSync(join(dir, 'src/data/factcheck/results', `${slug}.json`),
    JSON.stringify({ claims: [], summary: { overallStatus: 'match', criticalIssues: 0 } }));
}

test('маркер passed + отчёт на месте — чисто', () => {
  withFixture((dir) => {
    article(dir, 'a'); marker(dir, 'a'); report(dir, 'a');
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 0);
    assert.match(r.out, /факчек доведён до отчёта/);
  });
});

test('маркер с result: null — находка и ненулевой код в --strict', () => {
  withFixture((dir) => {
    article(dir, 'a'); marker(dir, 'a', { result: null }); report(dir, 'a');
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 1);
    assert.match(r.out, /нет результата/);
  });
});

test('маркер passed, но отчёт потерян — находка', () => {
  withFixture((dir) => {
    article(dir, 'a'); marker(dir, 'a'); // отчёт не создаём
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 1);
    assert.match(r.out, /потерян/);
  });
});

test('маркер failed — находка', () => {
  withFixture((dir) => {
    article(dir, 'a'); marker(dir, 'a', { result: 'failed' }); report(dir, 'a');
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 1);
    assert.match(r.out, /не пройден/);
  });
});

test('черновик без факчека — не находка: факты в нём ещё едут', () => {
  withFixture((dir) => {
    article(dir, 'draft-one', true);
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 0);
    assert.match(r.out, /Проверено выпущенных статей: 0/);
  });
});

test('без --strict код нулевой даже при находках — чтобы звать из отчётов', () => {
  withFixture((dir) => {
    article(dir, 'a'); marker(dir, 'a', { result: null }); report(dir, 'a');
    assert.equal(run(dir).code, 0);
  });
});
