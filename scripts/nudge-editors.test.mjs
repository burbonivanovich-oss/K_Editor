// Тесты напоминания редакции.
//
// Скрипт ходит в Google, поэтому проверяем то, что можно проверить без
// сети: молчание. Три случая, где он обязан выйти тихо и с нулевым кодом,
// — и в каждом молчание должно быть объяснено в выводе, иначе владелец не
// отличит «нечего напоминать» от «сломалось».
//
// Запуск: node --test scripts/nudge-editors.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'nudge-editors.mjs');

function withState(plan, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-test-'));
  const statePath = join(dir, 'editorial-cycle.json');
  writeFileSync(statePath, JSON.stringify({
    cycleId: '2026-08', state: 'running', batchSize: 5, maxInReview: 10,
    drive: { sheetId: 'sid' }, plan, batches: [], log: [],
  }));
  try { return fn(statePath); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(statePath, env = {}) {
  try {
    return {
      code: 0,
      out: execFileSync('node', [SCRIPT, '--sheet-id', 'sid'], {
        encoding: 'utf8',
        env: { ...process.env, CYCLE_STATE_PATH: statePath, EDITOR_EMAILS: '', ...env },
      }),
    };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test('без --sheet-id падает с понятной ошибкой', () => {
  try {
    execFileSync('node', [SCRIPT], { encoding: 'utf8' });
    assert.fail('ожидался ненулевой код');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(e.stderr, /sheet-id/);
  }
});

// Адреса живут в переменной репозитория, а не в секретах: пусто — значит
// напоминать некому, и это штатная ситуация, не сбой.
test('адресов нет — выходит молча и объясняет почему', () => {
  withState([], (statePath) => {
    const r = run(statePath);
    assert.equal(r.code, 0);
    assert.match(r.out, /EDITOR_EMAILS не задан/);
  });
});

test('очередь свободна — сообщает, что напоминать не о чем', () => {
  withState([
    { slug: 'a', title: 'Тема', status: 'candidate', owner: 'bot', priority: 'P1' },
  ], (statePath) => {
    const r = run(statePath, { EDITOR_EMAILS: 'editor@example.com' });
    assert.equal(r.code, 0);
    assert.match(r.out, /напоминать не о чем/i);
  });
});

test('сегодня уже напоминали — второй раз не идёт', () => {
  const today = new Date().toISOString().slice(0, 10);
  const dir = mkdtempSync(join(tmpdir(), 'nudge-test-'));
  const statePath = join(dir, 'editorial-cycle.json');
  writeFileSync(statePath, JSON.stringify({
    cycleId: '2026-08', state: 'running', batchSize: 5, maxInReview: 1,
    lastNudgeAt: today,
    drive: { sheetId: 'sid' },
    plan: [{ slug: 'a', title: 'Тема', status: 'review', owner: 'bot', priority: 'P1', reviewSince: '2026-01-01' }],
    batches: [], log: [],
  }));
  try {
    const r = run(statePath, { EDITOR_EMAILS: 'editor@example.com' });
    assert.equal(r.code, 0);
    assert.match(r.out, /уже напоминали/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
