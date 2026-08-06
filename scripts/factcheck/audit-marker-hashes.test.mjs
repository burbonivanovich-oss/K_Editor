// Скрипт читает src/content/blog/ и .claude/factchecked/ относительно
// cwd (как и его сосед audit-npa-references.mjs) — тесты запускают его
// сабпроцессом с cwd на временной фикстуре, без оверрайдов путей.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'audit-marker-hashes.mjs');

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-marker-hashes-test-'));
  mkdirSync(join(dir, 'src/content/blog'), { recursive: true });
  mkdirSync(join(dir, '.claude/factchecked'), { recursive: true });
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeArticle(dir, slug, { draft = 'false' } = {}) {
  const text = `---\ntitle: "T"\ndraft: ${draft}\n---\nТело статьи ${slug}.\n`;
  writeFileSync(join(dir, 'src/content/blog', `${slug}.md`), text);
  return text;
}

function writeMarker(dir, slug, content) {
  const hash = createHash('sha256').update(content).digest('hex');
  writeFileSync(join(dir, '.claude/factchecked', slug), JSON.stringify({ date: '2026-08-05', hash }));
}

function run(dir, args = []) {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd: dir });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test('пустой блог — не находка, exit 0 даже со --strict', () => {
  withFixture((dir) => {
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 0);
    assert.match(r.out, /проверять нечего/);
  });
});

test('draft: true пропускается', () => {
  withFixture((dir) => {
    writeArticle(dir, 'a', { draft: 'true' });
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 0);
    assert.match(r.out, /проверять нечего/);
  });
});

test('нет маркера — находка, --strict падает', () => {
  withFixture((dir) => {
    writeArticle(dir, 'a');
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 1);
    assert.match(r.out, /Нет маркера или он повреждён/);
    assert.match(r.out, /\ba\b/);
  });
});

test('хеш маркера совпадает — чисто', () => {
  withFixture((dir) => {
    const content = writeArticle(dir, 'a');
    writeMarker(dir, 'a', content);
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 0);
    assert.match(r.out, /Все маркеры на месте/);
  });
});

test('хеш маркера не совпадает (статью правили после факчека) — находка', () => {
  withFixture((dir) => {
    writeArticle(dir, 'a');
    writeMarker(dir, 'a', 'другое содержимое, не совпадает с файлом');
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 1);
    assert.match(r.out, /не совпадает с закоммиченным содержимым/);
  });
});

test('без --strict находки не роняют exit code', () => {
  withFixture((dir) => {
    writeArticle(dir, 'a');
    const r = run(dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /Нет маркера/);
  });
});
