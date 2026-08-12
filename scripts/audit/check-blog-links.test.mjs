// Тесты проверки внутренних ссылок блога.
//
// Гейт стоит в CI и в выпуске: битая ссылка внутри статьи не должна
// уезжать редактору. Скрипт работает от текущего каталога, поэтому
// тесты гоняют его на временном репозитории-фикстуре — без единого
// обращения к настоящему src/content/blog.
//
// Запуск: node --test scripts/audit/check-blog-links.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-blog-links.mjs');

function withRepo(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'blog-links-test-'));
  mkdirSync(join(dir, 'src/content/blog'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, 'src/content/blog', name), body);
  }
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(dir) {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const article = (body) => `---\ntitle: "Т"\ndraft: false\n---\n${body}\n`;

test('ссылка на существующую статью проходит', () => {
  withRepo({
    '2026-08-01-pervaya.md': article('Смотри [вторую](/blog/2026-08-02-vtoraya/).'),
    '2026-08-02-vtoraya.md': article('Текст.'),
  }, (dir) => {
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
  });
});

test('ссылка на несуществующую статью — ненулевой код и имя файла в отчёте', () => {
  withRepo({
    '2026-08-01-pervaya.md': article('Смотри [третью](/blog/2026-08-03-tretya/).'),
  }, (dir) => {
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /2026-08-03-tretya/);
  });
});

// Ссылки в корпусе пишут и со слешем, и без: обе формы должны считаться
// одной и той же статьёй. На этом же различии 12.08.2026 сломалась
// перелинковка в доках (см. lib/resolve-links).
test('хвостовой слеш не делает ссылку битой', () => {
  withRepo({
    '2026-08-01-pervaya.md': article('[со слешем](/blog/2026-08-02-vtoraya/) и [без](/blog/2026-08-02-vtoraya)'),
    '2026-08-02-vtoraya.md': article('Текст.'),
  }, (dir) => {
    assert.equal(run(dir).code, 0);
  });
});

test('внешние ссылки не проверяются', () => {
  withRepo({
    '2026-08-01-pervaya.md': article('[закон](https://www.consultant.ru/document/cons_doc_LAW_1/)'),
  }, (dir) => {
    assert.equal(run(dir).code, 0);
  });
});

test('пустой блог — не ошибка, а «нечего проверять»', () => {
  withRepo({}, (dir) => {
    assert.equal(run(dir).code, 0);
  });
});
