// Тесты недельной сводки для редактора.
//
// Единственный отчёт, который редакция читает целиком и по которому судит
// о состоянии дел. Соврать здесь дороже, чем промолчать: «ничего не ждёт»
// при полной очереди означает, что неделя пройдёт мимо.
//
// Запуск: node --test scripts/weekly-digest.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'weekly-digest.mjs');

function withState(state, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'weekly-digest-test-'));
  mkdirSync(join(dir, 'src/data'), { recursive: true });
  writeFileSync(join(dir, 'src/data/editorial-cycle.json'), JSON.stringify({
    cycleId: '2026-08', state: 'running', batchSize: 5, maxInReview: 10,
    drive: { sheetUrl: 'https://docs.google.com/spreadsheets/d/x/edit' },
    plan: [], batches: [], log: [], ...state,
  }));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(dir) {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT], { encoding: 'utf8', env: { ...process.env, DIGEST_ROOT: dir } }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const topic = (over) => ({
  slug: 's', title: 'Тема', status: 'planned', owner: 'bot', priority: 'P1', ...over,
});

// Тихая неделя — отдельный случай: сводка не притворяется, что есть
// работа, но и не молчит совсем. Молчание редактор не отличит от поломки.
test('за неделю ничего не произошло — так и сказано, с подсказкой куда писать', () => {
  withState({ plan: [], log: [] }, (dir) => {
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ничего не изменилось/i);
    assert.match(r.out, /напишите тому, кто ведёт проект/i);
  });
});

test('статьи на вычитке перечислены поимённо', () => {
  withState({
    plan: [
      topic({ slug: 'a', title: 'Первая статья', status: 'review', reviewSince: '2026-08-01' }),
      topic({ slug: 'b', title: 'Вторая статья', status: 'review', reviewSince: '2026-08-10' }),
    ],
  }, (dir) => {
    const out = run(dir).out;
    assert.match(out, /Первая статья/);
    assert.match(out, /Вторая статья/);
  });
});

// Возраст — единственное, что превращает список в приоритет: редактор
// должен видеть, что лежит дольше всех, а не разбирать шесть равнозначных.
test('дольше всех лежащая статья идёт первой', () => {
  withState({
    plan: [
      topic({ slug: 'fresh', title: 'Свежая', status: 'review', reviewSince: '2026-08-11' }),
      topic({ slug: 'old', title: 'Залежавшаяся', status: 'review', reviewSince: '2026-07-20' }),
    ],
  }, (dir) => {
    const out = run(dir).out;
    assert.ok(out.indexOf('Залежавшаяся') < out.indexOf('Свежая'), `порядок неверный:\n${out}`);
  });
});

test('занятость очереди показана числом из состояния, а не выдумана', () => {
  withState({
    maxInReview: 10,
    plan: [
      topic({ slug: 'a', status: 'review' }),
      topic({ slug: 'b', status: 'writing' }),
      topic({ slug: 'c', status: 'candidate' }),
    ],
  }, (dir) => {
    assert.match(run(dir).out, /2 из 10/);
  });
});

test('снятые и выпущенные не считаются очередью', () => {
  withState({
    // Событие в логе нужно, чтобы сводка развернулась в полную форму:
    // при полностью тихой неделе она печатает короткую версию (см. выше).
    log: [{ at: new Date().toISOString(), event: 'apply-decisions: 1 снято' }],
    plan: [
      topic({ slug: 'a', status: 'dropped' }),
      topic({ slug: 'b', status: 'released' }),
      topic({ slug: 'c', status: 'planned' }),
    ],
  }, (dir) => {
    assert.match(run(dir).out, /0 из 10/);
  });
});

test('нет состояния цикла — понятная ошибка, а не пустая сводка', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weekly-digest-empty-'));
  try {
    const r = run(dir);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /editorial-cycle\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
