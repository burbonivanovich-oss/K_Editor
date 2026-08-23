// Тесты извлечения утверждений: regex-проход и смысловое слияние.
//
// Проверка 12.08.2026: абзац с семью проверяемыми утверждениями дал два —
// номер постановления и дату. Классов «длительность», «кратность», «доля»
// в списке нет и не будет: список классов не замкнут. Поэтому второй
// проход делает сессия, а скрипт вливает результат и следит, чтобы это
// была цитата из статьи, а не пересказ.
//
// Запуск: node --test scripts/factcheck/extract-claims.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'extract-claims.mjs');
const SLUG = '2026-01-01-probe-claims';

/* Корень — временный, а не живой репозиторий.
 *
 * Раньше тест писал пробную статью прямо в src/content/blog и удалял её
 * в finally. Пока прогон шёл, `git status` показывал изменения в
 * корпусе — 21.08.2026 их приняли за чужую незакоммиченную работу и
 * откатили каталог целиком. Тест не должен появляться в диффе вообще. */
let REPO, ARTICLE, CLAIMS;

const BODY = `---
title: "Проба"
draft: true
---

Норматив ответа — 1,5 секунды, он установлен постановлением Правительства РФ от 21.11.2023 № 1944.

Срок хранения фискальных данных — пять лет.
`;

function withArticle(fn) {
  REPO = mkdtempSync(join(tmpdir(), 'claims-'));
  ARTICLE = join(REPO, 'src/content/blog', `${SLUG}.md`);
  CLAIMS = join(REPO, 'src/data/factcheck/claims', `${SLUG}.json`);
  mkdirSync(dirname(ARTICLE), { recursive: true });
  mkdirSync(dirname(CLAIMS), { recursive: true });
  writeFileSync(ARTICLE, BODY);
  try { return fn(); } finally { rmSync(REPO, { recursive: true, force: true }); }
}

function run(args) {
  return execFileSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FACTCHECK_ROOT: REPO },
  });
}

test('regex находит номер постановления, но не длительность и не срок', () => {
  withArticle(() => {
    run([SLUG]);
    const raws = JSON.parse(readFileSync(CLAIMS, 'utf8')).claims.map((c) => c.raw);
    assert.ok(raws.some((r) => r.includes('1944')), 'ПП должно находиться');
    assert.ok(!raws.some((r) => r.includes('1,5 секунды')), 'класса «длительность» нет — и это нормально');
    assert.ok(!raws.some((r) => r.includes('пять лет')), 'срок прописью regex не видит');
  });
});

test('смысловые утверждения вливаются с позицией и контекстом', () => {
  withArticle(() => {
    run([SLUG]);
    const dir = mkdtempSync(join(tmpdir(), 'semantic-'));
    const file = join(dir, 'semantic.json');
    writeFileSync(file, JSON.stringify([
      { raw: 'Норматив ответа — 1,5 секунды', type: 'DURATION', why: 'норматив из ПП' },
      { raw: 'Срок хранения фискальных данных — пять лет', type: 'DURATION', why: 'срок из 54-ФЗ' },
    ]));
    const out = run(['merge', SLUG, '--file', file]);
    rmSync(dir, { recursive: true, force: true });

    assert.match(out, /добавлено смысловых утверждений: 2/);
    const claims = JSON.parse(readFileSync(CLAIMS, 'utf8')).claims;
    const added = claims.find((c) => c.raw.includes('1,5 секунды'));
    assert.equal(added.foundBy, 'semantic');
    assert.ok(added.offset > 0, 'позиция считается по тексту, а не приходит извне');
    assert.match(added.context, /постановлением Правительства/, 'контекст собирается из статьи');
  });
});

test('пересказ вместо цитаты отбрасывается с ненулевым кодом', () => {
  withArticle(() => {
    run([SLUG]);
    const dir = mkdtempSync(join(tmpdir(), 'semantic-'));
    const file = join(dir, 'semantic.json');
    writeFileSync(file, JSON.stringify([{ raw: 'в статье говорится про полторы секунды', why: 'пересказ' }]));
    let failed = false;
    try { run(['merge', SLUG, '--file', file]); } catch (e) {
      failed = true;
      assert.match(e.stderr, /пересказ, а не цитата/);
    }
    rmSync(dir, { recursive: true, force: true });
    assert.ok(failed, 'ожидался ненулевой код');
  });
});

test('повторное слияние не задваивает утверждения', () => {
  withArticle(() => {
    run([SLUG]);
    const dir = mkdtempSync(join(tmpdir(), 'semantic-'));
    const file = join(dir, 'semantic.json');
    writeFileSync(file, JSON.stringify([{ raw: 'Срок хранения фискальных данных — пять лет' }]));
    run(['merge', SLUG, '--file', file]);
    run(['merge', SLUG, '--file', file]);
    rmSync(dir, { recursive: true, force: true });
    const claims = JSON.parse(readFileSync(CLAIMS, 'utf8')).claims;
    assert.equal(claims.filter((c) => c.raw.includes('пять лет')).length, 1);
  });
});
