/**
 * Панель состояния обязана печатать вердикт, а не число файлов.
 *
 * Регрессия 24.08.2026: `npm run status` брал длину каталога
 * `.claude/factchecked` и печатал зелёное «факт-чек: 15/15» в тот
 * момент, когда `audit-bundles.mjs` отвечал «4 связки не проходят
 * контракт». Маркер на диске подтверждает, что процедура доходила до
 * конца, а не что проверка сошлась, — и панель, которая их путает,
 * учит верить зелёному без доказательства.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE = join(REPO, 'scripts', 'console.mjs');

/** Корень с одной статьёй и маркером — но без отчёта, то есть связка не сходится. */
function rootWithMarkerButNoReport() {
  const root = mkdtempSync(join(tmpdir(), 'console-status-'));
  mkdirSync(join(root, 'src/content/blog'), { recursive: true });
  mkdirSync(join(root, '.claude/factchecked'), { recursive: true });
  writeFileSync(
    join(root, 'src/content/blog/2026-01-01-tema.md'),
    '---\ntitle: "Тема"\ndraft: false\n---\n\nТекст статьи.\n',
  );
  writeFileSync(
    join(root, '.claude/factchecked/2026-01-01-tema'),
    JSON.stringify({ date: '2026-01-01', hash: 'нетакой', result: 'passed' }),
  );
  return root;
}

const status = (root) =>
  execFileSync('node', [CONSOLE, 'status'], {
    encoding: 'utf8',
    env: { ...process.env, CONSOLE_ROOT: root },
  });

test('маркер без отчёта не даёт зелёного: печатается вердикт, а не число файлов', () => {
  const root = rootWithMarkerButNoReport();
  try {
    const out = status(root);
    assert.match(out, /факчек по контракту: 0\/1/);
    assert.doesNotMatch(out, /факт-чек: 1\/1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('расхождение «маркеров больше, чем сошедшихся связок» видно на панели', () => {
  const root = rootWithMarkerButNoReport();
  try {
    assert.match(status(root), /маркеров 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('упавший валидатор — отдельное состояние, а не тишина', () => {
  const root = rootWithMarkerButNoReport();
  try {
    /* Каталог с именем статьи роняет чтение корпуса (EISDIR) — на этом
     * валидатор связок падает целиком. Панель обязана сказать «проверка
     * не состоялась»: молчание здесь читается как «замечаний нет», и
     * чем сильнее сломан валидатор, тем зеленее выглядела бы панель. */
    mkdirSync(join(root, 'src/content/blog/2026-01-02-katalog.md'), { recursive: true });
    const out = status(root);
    assert.match(out, /проверка не состоялась/);
    /* И сама панель при этом обязана нарисоваться: нечитаемый файл —
     * строка в сводке, а не стектрейс вместо неё. */
    assert.match(out, /не прочитано: 1/);
    assert.match(out, /СОСТОЯНИЕ МОДУЛЯ/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
