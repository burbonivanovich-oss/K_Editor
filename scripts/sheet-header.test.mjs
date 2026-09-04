// Разбор шапки вкладки редакции и поведение рутины при её расхождении.
//
// Проверяется ровно то, что сломалось 23.08–01.09.2026: старый набор
// колонок читал новую шапку, часть заголовков совпадала, часть нет, и
// рутина четырнадцать дней подряд писала в журнал «0 снято, 0 правок» —
// тем же событием, каким отчитывается о живой таблице без решений.
//
// Запуск: node --test scripts/sheet-header.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORK_COLS, REQUIRED_KEYS, resolveHeader, COLUMN_GROUPS, columnGroup,
} from './lib/sheet-columns.mjs';

const CYCLE = join(dirname(fileURLToPath(import.meta.url)), 'cycle-state.mjs');

/** Шапка вкладки, приведённой к текущей раскладке. */
const currentHeader = () => WORK_COLS.map((c) => c.title);

/** Шапка до пересборки 23.08.2026: часть названий совпадает, часть нет. */
const legacyHeader = () => [
  '#', 'Тема', 'Статус', 'Решение', 'Кто пишет', 'Правка', 'Документ',
  'Причина отказа', 'Целевой запрос', 'Кластер', 'ID (не менять)',
];

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sheet-header-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function runCycle(statePath, args) {
  return execFileSync('node', [CYCLE, ...args], {
    env: { ...process.env, CYCLE_STATE_PATH: statePath },
    encoding: 'utf8',
  });
}

function runCycleFail(statePath, args) {
  try {
    runCycle(statePath, args);
    assert.fail(`ожидался ненулевой код возврата: ${args.join(' ')}`);
  } catch (e) {
    assert.ok(e.status, 'ожидался ненулевой код возврата');
    return e;
  }
}

function initCycle(statePath, dir) {
  const plan = join(dir, 'plan.json');
  writeFileSync(plan, JSON.stringify([{ title: 'Тема раз' }]));
  runCycle(statePath, [
    'init', '--cycle', 'test', '--plan', plan,
    '--sheet-id', 'sid', '--sheet-url', 'surl', '--folder-id', 'fid',
  ]);
  runCycle(statePath, ['set-state', 'running']);
}

const state = (p) => JSON.parse(readFileSync(p, 'utf8'));

/* ------------------------------------------------------- resolveHeader */

test('текущая раскладка разбирается целиком', () => {
  const r = resolveHeader(currentHeader());
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unknown, []);
  for (const key of REQUIRED_KEYS) assert.ok(r.byKey.has(key), `нет ключа ${key}`);
});

test('шапка до 23.08.2026 читается через COLUMN_RENAMES, а не отвергается', () => {
  // Переименование трогает заголовок, данные под ним остаются: вкладка,
  // которую не прогнали через sync-columns, обязана читаться.
  const r = resolveHeader(legacyHeader());
  assert.equal(r.ok, true, `не разобралось: ${r.missing.join(', ')}`);
  assert.deepEqual(r.missing, []);
});

test('шапка без обязательной колонки — отказ с её именем', () => {
  const r = resolveHeader(currentHeader().filter((t) => t !== 'ID (не менять)'));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['slug']);
});

test('чужая шапка не читается по номерам колонок', () => {
  // Ровно этот случай раньше проходил как «заголовков не знаю, читаю по
  // порядку WORK_COLS» — и разбирал причину отказа как решение.
  const r = resolveHeader(['Колонка A', 'Колонка B', 'Колонка C']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, REQUIRED_KEYS);
  assert.equal(r.unknown.length, 3);
});

test('пустая шапка — отказ, а не пустая выборка', () => {
  assert.equal(resolveHeader([]).ok, false);
  assert.equal(resolveHeader(['', '  ']).ok, false);
});

test('незнакомые заголовки перечисляются, но сами по себе не блокируют', () => {
  const r = resolveHeader([...currentHeader(), 'Заметки редактора']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.unknown, ['Заметки редактора']);
});

/* ------------------------------------------- apply-decisions: отказ */

test('apply-decisions отказывается разбирать нечитаемую шапку', () => {
  withTmp((dir) => {
    const statePath = join(dir, 'editorial-cycle.json');
    initCycle(statePath, dir);
    const pull = join(dir, 'pull.json');
    writeFileSync(pull, JSON.stringify({
      tab: 'Темы и статьи 2026-08',
      topics: [],
      unparsable: { missing: ['doc', 'slug'], unknown: ['Ссылка на докс'], header: [] },
    }));

    const err = runCycleFail(statePath, ['apply-decisions', '--file', pull]);
    assert.match(err.stderr, /не разобрана/);
    assert.match(err.stderr, /doc, slug/);
    assert.match(err.stderr, /sync-columns/);
  });
});

test('нечитаемая шапка пишется в журнал отдельным событием, а не «0 снято»', () => {
  withTmp((dir) => {
    const statePath = join(dir, 'editorial-cycle.json');
    initCycle(statePath, dir);
    const pull = join(dir, 'pull.json');
    writeFileSync(pull, JSON.stringify({
      tab: 'Темы и статьи 2026-08', topics: [],
      unparsable: { missing: ['doc'], unknown: [], header: [] },
    }));

    runCycleFail(statePath, ['apply-decisions', '--file', pull]);
    const s = state(statePath);
    const last = s.log[s.log.length - 1].event;
    assert.match(last, /^sheet-unparsable/);
    assert.doesNotMatch(last, /снято/, 'событие не должно выглядеть как обычный пустой прогон');
    assert.equal(s.lastSheetError.tab, 'Темы и статьи 2026-08');
    assert.deepEqual(s.lastSheetError.missing, ['doc']);
  });
});

test('повторный прогон с той же ошибкой не двигает since — иначе вернутся коммиты каждый час', () => {
  withTmp((dir) => {
    const statePath = join(dir, 'editorial-cycle.json');
    initCycle(statePath, dir);
    const pull = join(dir, 'pull.json');
    writeFileSync(pull, JSON.stringify({
      tab: 'Темы', topics: [], unparsable: { missing: ['doc'], unknown: [], header: [] },
    }));

    runCycleFail(statePath, ['apply-decisions', '--file', pull]);
    const first = state(statePath).lastSheetError.since;
    runCycleFail(statePath, ['apply-decisions', '--file', pull]);
    assert.equal(state(statePath).lastSheetError.since, first);
  });
});

test('другая поломка обновляет since', () => {
  withTmp((dir) => {
    const statePath = join(dir, 'editorial-cycle.json');
    initCycle(statePath, dir);
    const pull = join(dir, 'pull.json');

    writeFileSync(pull, JSON.stringify({
      tab: 'Темы', topics: [], unparsable: { missing: ['doc'], unknown: [], header: [] },
    }));
    runCycleFail(statePath, ['apply-decisions', '--file', pull]);
    const first = state(statePath).lastSheetError.since;

    writeFileSync(pull, JSON.stringify({
      tab: 'Темы', topics: [], unparsable: { missing: ['doc', 'slug'], unknown: [], header: [] },
    }));
    runCycleFail(statePath, ['apply-decisions', '--file', pull]);
    const s = state(statePath);
    assert.deepEqual(s.lastSheetError.missing, ['doc', 'slug']);
    assert.notEqual(s.lastSheetError.since, first);
  });
});

test('разобравшаяся шапка снимает флаг поломки', () => {
  withTmp((dir) => {
    const statePath = join(dir, 'editorial-cycle.json');
    initCycle(statePath, dir);
    const pull = join(dir, 'pull.json');

    writeFileSync(pull, JSON.stringify({
      tab: 'Темы', topics: [], unparsable: { missing: ['doc'], unknown: [], header: [] },
    }));
    runCycleFail(statePath, ['apply-decisions', '--file', pull]);
    assert.ok(state(statePath).lastSheetError);

    writeFileSync(pull, JSON.stringify({ tab: 'Темы', topics: [] }));
    const out = JSON.parse(runCycle(statePath, ['apply-decisions', '--file', pull]));
    assert.equal(out.sheetRecovered, true);
    assert.equal(state(statePath).lastSheetError, undefined);
  });
});

/* ------------------------------------------------- цвета по владельцу */

test('каждая колонка попадает ровно в одну группу с известным цветом', () => {
  for (const c of WORK_COLS) {
    const g = columnGroup(c);
    assert.ok(COLUMN_GROUPS[g], `у колонки «${c.title}» неизвестная группа ${g}`);
    const { red, green, blue } = COLUMN_GROUPS[g].color;
    for (const v of [red, green, blue]) {
      assert.ok(typeof v === 'number' && v >= 0 && v <= 1, `цвет группы ${g} вне диапазона Sheets 0–1`);
    }
  }
});

test('цвет группы = кто заполняет: защищённые колонки серые, колонки редактора зелёные', () => {
  // Защита ставится по owner === 'bot'. Цвет обязан совпадать с ней:
  // разъехавшись, они дадут ровно то, от чего заводились — колонку,
  // которая выглядит своей, а на правку отвечает предупреждением.
  for (const c of WORK_COLS) {
    if (c.owner === 'bot') assert.equal(columnGroup(c), 'bot', `«${c.title}» защищена, но не помечена как ботовая`);
    if (c.owner === 'editor') assert.equal(columnGroup(c), 'editor', `«${c.title}» редакторская, но помечена иначе`);
  }
});

test('«Тема» — колонка редактора: защиты у неё нет, значит цвет приглашает', () => {
  const topic = WORK_COLS.find((c) => c.key === 'topic');
  assert.equal(topic.owner, undefined, 'у «Темы» появился owner — проверь, не нужна ли ей защита');
  assert.equal(columnGroup(topic), 'editor');
});

test('три группы различимы на глаз', () => {
  const seen = new Map();
  for (const [name, g] of Object.entries(COLUMN_GROUPS)) {
    const key = `${g.color.red}/${g.color.green}/${g.color.blue}`;
    assert.ok(!seen.has(key), `у групп ${seen.get(key)} и ${name} один цвет`);
    seen.set(key, name);
    assert.ok(g.label && g.label.length > 3, `у группы ${name} нет внятной подписи для легенды`);
  }
});

/* ------------------------------------------------------------- churn */

test('поломка шапки — содержательная дельта, её обязаны закоммитить', async () => {
  const { isSignificant } = await import('./cycle-churn.mjs');
  const before = { plan: [], log: [{ at: 'a', event: 'x' }], updatedAt: 'a' };
  const after = {
    plan: [], log: [{ at: 'b', event: 'sheet-unparsable: …' }], updatedAt: 'b',
    lastSheetError: { since: 'b', tab: 'Темы', missing: ['doc'] },
  };
  assert.equal(isSignificant(before, after), true);
  // А два одинаковых прогона подряд — нет: since стабилен.
  assert.equal(isSignificant(after, { ...after, updatedAt: 'c', log: [{ at: 'c', event: 'sheet-unparsable: …' }] }), false);
});
