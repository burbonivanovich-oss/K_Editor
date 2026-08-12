// Тесты бизнес-инвариантов health-check.mjs (F-05) через реальный CLI
// (subprocess) на временной фикстуре (HEALTH_CHECK_ROOT). Остальные секции
// (workflows, документация) фикстуре не предоставлены полностью и могут
// падать в отчёте — тесты проверяют конкретные записи из checks[], не
// чистоту всего отчёта целиком.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'health-check.mjs');

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'health-check-test-'));
  // Директории, которые скрипт обходит без existsSync-гарда — без них
  // упадёт ENOENT ещё до секции бизнес-инвариантов.
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'src/content/blog'), { recursive: true });
  mkdirSync(join(dir, '.claude/factchecked'), { recursive: true });
  mkdirSync(join(dir, 'src/data/analyze'), { recursive: true });
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir) {
  const out = execFileSync('node', [SCRIPT, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HEALTH_CHECK_ROOT: dir },
  });
  return JSON.parse(out);
}

function writeReleasedArticle(dir, slug, body = 'Текст статьи.\n') {
  const content = `---\ntitle: "T"\ndraft: false\npubDate: "2026-01-01"\n---\n${body}`;
  writeFileSync(join(dir, 'src/content/blog', `${slug}.md`), content);
  return content;
}

function writeMarker(dir, slug, hashOf, result = 'passed') {
  const hash = createHash('sha256').update(hashOf).digest('hex');
  writeFileSync(
    join(dir, '.claude/factchecked', slug),
    JSON.stringify({ date: '2026-01-01', hash, result, criticalMismatches: 0 }),
  );
}

function find(checks, name) {
  return checks.find((c) => c.name.includes(name));
}

test('released без факчек-маркера — не считается "не про тот текст" (это отдельная noFactcheck-проверка)', () => {
  withFixture((dir) => {
    writeReleasedArticle(dir, 'a');
    const out = run(dir);
    const c = find(out.checks, 'маркер факчека не про текущий текст');
    assert.equal(c, undefined, 'отсутствие маркера — не то же самое, что несовпадение хеша');
  });
});

// 12.08.2026: пять из шести статей имели маркер с result: null (процедура
// писала маркер, но не писала отчёт), а health-check рапортовал «все статьи
// фактчекнуты». Зелёный отчёт по непроверенным статьям хуже отсутствия отчёта.
test('маркер без result — не считается фактчеком, отдельный warn', () => {
  withFixture((dir) => {
    const content = writeReleasedArticle(dir, 'a');
    writeMarker(dir, 'a', content, null);
    const out = run(dir);
    assert.equal(find(out.checks, 'маркер факчека без результата')?.status, 'warn');
    assert.equal(find(out.checks, 'все статьи фактчекнуты'), undefined,
      'зелёная строка про «все фактчекнуты» не должна соседствовать с этим warn');
  });
});

test('маркер факчека не совпадает с текущим текстом статьи — fail', () => {
  withFixture((dir) => {
    const content = writeReleasedArticle(dir, 'a');
    writeMarker(dir, 'a', content + 'но текст с тех пор поменяли');
    const out = run(dir);
    const c = find(out.checks, 'маркер факчека не про текущий текст');
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /\ba\b/);
  });
});

test('маркер факчека совпадает с текущим текстом — ok', () => {
  withFixture((dir) => {
    const content = writeReleasedArticle(dir, 'a');
    writeMarker(dir, 'a', content);
    const out = run(dir);
    const c = find(out.checks, 'маркеры факчека согласованы');
    assert.equal(c.status, 'ok');
  });
});

test('released без cycle-статуса released и без cycleReleaseOverride — warn', () => {
  withFixture((dir) => {
    const content = writeReleasedArticle(dir, 'a');
    writeMarker(dir, 'a', content);
    const out = run(dir);
    const c = find(out.checks, 'выпуск без записанного пути');
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /\ba\b/);
  });
});

test('released с cycleReleaseOverride в analyze/<slug>.json — ok, не warn', () => {
  withFixture((dir) => {
    const content = writeReleasedArticle(dir, 'a');
    writeMarker(dir, 'a', content);
    writeFileSync(
      join(dir, 'src/data/analyze/a.json'),
      JSON.stringify({ cycleReleaseOverride: { reason: 'обкатка вне цикла', at: '2026-01-01' } }),
    );
    const out = run(dir);
    const warnCheck = find(out.checks, 'выпуск без записанного пути');
    assert.equal(warnCheck, undefined);
    const okCheck = find(out.checks, 'записан путь');
    assert.equal(okCheck.status, 'ok');
  });
});

test('released со статусом released в editorial-cycle.json — ok, не warn', () => {
  withFixture((dir) => {
    const content = writeReleasedArticle(dir, 'a');
    writeMarker(dir, 'a', content);
    writeFileSync(
      join(dir, 'src/data/editorial-cycle.json'),
      JSON.stringify({ plan: [{ slug: 'a', status: 'released' }] }),
    );
    const out = run(dir);
    const warnCheck = find(out.checks, 'выпуск без записанного пути');
    assert.equal(warnCheck, undefined);
  });
});

test('нет released-статей — секция сообщает "нечего проверять", не молчит и не падает', () => {
  withFixture((dir) => {
    const out = run(dir);
    const c = find(out.checks, 'Бизнес-инварианты: нечего проверять');
    assert.equal(c.status, 'ok');
  });
});
