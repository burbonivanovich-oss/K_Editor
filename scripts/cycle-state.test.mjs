// Тесты машины состояний cycle-state.mjs через реальный CLI (subprocess),
// на временном state-файле (CYCLE_STATE_PATH) — не трогают
// src/data/editorial-cycle.json и не требуют доступа к Google Drive.
//
// Запуск: node --test scripts/cycle-state.test.mjs
//     или: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'cycle-state.mjs');

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cycle-state-test-'));
  const statePath = join(dir, 'editorial-cycle.json');
  try {
    return fn(statePath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(statePath, args) {
  return execFileSync('node', [SCRIPT, ...args], {
    env: { ...process.env, CYCLE_STATE_PATH: statePath },
    encoding: 'utf8',
  });
}

function runFail(statePath, args) {
  try {
    run(statePath, args);
    assert.fail(`ожидался ненулевой exit code для: ${args.join(' ')}`);
  } catch (e) {
    return e; // e.status, e.stderr, e.stdout
  }
}

function getState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function find(s, slug) {
  return s.plan.find((t) => t.slug === slug);
}

function writePlan(dir, topics) {
  const p = join(dir, 'plan.json');
  writeFileSync(p, JSON.stringify(topics));
  return p;
}

function initCycle(statePath, dir, topics, extraArgs = []) {
  const plan = writePlan(dir, topics);
  run(statePath, [
    'init', '--cycle', 'test', '--plan', plan,
    '--sheet-id', 'sid', '--sheet-url', 'surl', '--folder-id', 'fid',
    ...extraArgs,
  ]);
}

/* ------------------------------------------------------------------ init */

test('init создаёт цикл в awaiting_review со слагами из заголовков', () => {
  withTmp((statePath, dir) => {
    initCycle(statePath, dir, [{ title: 'Тема раз' }, { title: 'Тема два' }]);
    const s = getState(statePath);
    assert.equal(s.state, 'awaiting_review');
    assert.equal(s.plan.length, 2);
    assert.deepEqual(s.plan.map((t) => t.slug), ['tema-raz', 'tema-dva']);
    assert.ok(s.plan.every((t) => t.status === 'planned' && t.owner === 'bot'));
  });
});

test('init отказывает, если цикл уже идёт', () => {
  withTmp((statePath, dir) => {
    initCycle(statePath, dir, [{ title: 'Тема' }]);
    run(statePath, ['set-state', 'running']);
    const err = runFail(statePath, ['init', '--cycle', 'x', '--plan', writePlan(dir, [{ title: 'Y' }])]);
    assert.match(err.stderr, /уже идёт/);
  });
});

/* ---------------------------------------------------- apply-decisions */

test('apply-decisions: ОДОБРЕН переводит цикл в running', () => {
  withTmp((statePath, dir) => {
    initCycle(statePath, dir, [{ title: 'Тема' }]);
    const pull = join(dir, 'pull.json');
    writeFileSync(pull, JSON.stringify({ approval: 'ОДОБРЕН', topics: [] }));
    const out = JSON.parse(run(statePath, ['apply-decisions', '--file', pull]));
    assert.equal(out.approved, true);
    assert.equal(getState(statePath).state, 'running');
  });
});

test('apply-decisions: решение "убрать" снимает тему по slug', () => {
  withTmp((statePath, dir) => {
    initCycle(statePath, dir, [{ title: 'Тема раз' }, { title: 'Тема два' }]);
    run(statePath, ['set-state', 'running']);
    const pull = join(dir, 'pull.json');
    writeFileSync(pull, JSON.stringify({
      approval: '', topics: [
        { row: 5, title: 'Тема раз', decision: 'убрать', slug: 'tema-raz' },
        { row: 6, title: 'Тема два', decision: '', slug: 'tema-dva' },
      ],
    }));
    const out = JSON.parse(run(statePath, ['apply-decisions', '--file', pull]));
    assert.deepEqual(out.dropped, ['Тема раз']);
    const s = getState(statePath);
    assert.equal(s.plan.find((t) => t.slug === 'tema-raz').status, 'dropped');
    assert.equal(s.plan.find((t) => t.slug === 'tema-dva').status, 'planned');
  });
});

// Регрессия: раньше строки сопоставлялись по номеру, а не по slug. Если
// редактор удаляет строку, все нижние строки физически сдвигаются, и
// решение по одной теме применялось к другой, которая просто оказалась
// на освободившемся номере строки.
test('apply-decisions: сдвиг строк после удаления не путает темы (регрессия)', () => {
  withTmp((statePath, dir) => {
    initCycle(statePath, dir, [
      { title: 'Тема A' }, { title: 'Тема B' }, { title: 'Тема C' },
    ]);
    run(statePath, ['set-state', 'running']);

    // Первый pull — темы на исходных местах (row 5/6/7), без решений.
    const pull1 = join(dir, 'pull1.json');
    writeFileSync(pull1, JSON.stringify({
      approval: '', topics: [
        { row: 5, title: 'Тема A', decision: '', slug: 'tema-a' },
        { row: 6, title: 'Тема B', decision: '', slug: 'tema-b' },
        { row: 7, title: 'Тема C', decision: '', slug: 'tema-c' },
      ],
    }));
    run(statePath, ['apply-decisions', '--file', pull1]);

    // Редактор удалил строку Темы A из таблицы: Тема B физически сдвинулась
    // на row 5 (был у Темы A) и получила решение «убрать», Тема C — на row 6.
    const pull2 = join(dir, 'pull2.json');
    writeFileSync(pull2, JSON.stringify({
      approval: '', topics: [
        { row: 5, title: 'Тема B', decision: 'убрать', slug: 'tema-b' },
        { row: 6, title: 'Тема C', decision: '', slug: 'tema-c' },
      ],
    }));
    const out = JSON.parse(run(statePath, ['apply-decisions', '--file', pull2]));

    assert.deepEqual(out.dropped, ['Тема B'], 'снята должна быть именно Тема B, а не A');
    assert.deepEqual(out.missing, ['Тема A'], 'Тема A реально пропала из таблицы');

    const s = getState(statePath);
    assert.equal(s.plan.find((t) => t.slug === 'tema-a').status, 'planned', 'Тема A не должна пострадать');
    assert.equal(s.plan.find((t) => t.slug === 'tema-b').status, 'dropped');
    assert.equal(s.plan.find((t) => t.slug === 'tema-c').status, 'planned');
  });
});

test('apply-decisions: новая строка без slug подхватывается как добавленная редактором', () => {
  withTmp((statePath, dir) => {
    initCycle(statePath, dir, [{ title: 'Тема раз' }]);
    run(statePath, ['set-state', 'running']);
    const pull = join(dir, 'pull.json');
    writeFileSync(pull, JSON.stringify({
      approval: '', topics: [
        { row: 5, title: 'Тема раз', decision: '', slug: 'tema-raz' },
        { row: 6, title: 'Новая тема от редактора', decision: '', slug: '' },
      ],
    }));
    const out = JSON.parse(run(statePath, ['apply-decisions', '--file', pull]));
    assert.deepEqual(out.added, ['Новая тема от редактора']);
    assert.equal(getState(statePath).plan.length, 2);
  });
});

/* ---------------------------------------------- очередь редактора (review) */

test('can-start-batch: потолок очереди блокирует новый батч', () => {
  withTmp((statePath, dir) => {
    initCycle(statePath, dir, [
      { title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' },
    ], ['--max-in-review', '2', '--batch-size', '2']);
    run(statePath, ['set-state', 'running']);

    // Заполняем очередь редактора до потолка (2 темы на вычитке).
    run(statePath, ['start-batch', '--slugs', 'a,b']);
    run(statePath, ['to-review', '--slug', 'a']);
    run(statePath, ['to-review', '--slug', 'b']);

    const err = runFail(statePath, ['can-start-batch']);
    assert.match(err.stdout, /потолок/);

    // Один из них принят — освобождается ровно одно место.
    run(statePath, ['accept', '--slug', 'a']);
    const out = run(statePath, ['can-start-batch']);
    assert.match(out, /влезет ещё 1/);
  });
});

// Находка из внешнего ревью (F-03): can-start-batch/next-batch считали
// ёмкость только по review, в то время как реальный гейт (transitionTopic,
// внутри start-batch) считает writing+review. can-start-batch мог честно
// сказать «ДА, влезет ещё N», пока start-batch эту же партию отклонял —
// потому что писавшиеся (writing) темы уже заняли часть потолка, а
// предварительная проверка их не видела.
test('can-start-batch/next-batch учитывают writing, а не только review', () => {
  withTmp((statePath, dir) => {
    initCycle(statePath, dir, [
      { title: 'A' }, { title: 'B' }, { title: 'C' },
    ], ['--max-in-review', '2', '--batch-size', '2']);
    run(statePath, ['set-state', 'running']);

    // Один батч уже пишется (writing), в review пока никого нет.
    run(statePath, ['start-batch', '--slugs', 'a,b']);

    // can-start-batch должен видеть потолок исчерпанным (2 writing = 2/2),
    // а не свободным (0 review = 0/2), иначе он врёт про доступную ёмкость.
    const err = runFail(statePath, ['can-start-batch']);
    assert.match(err.stdout, /потолок/);
    assert.match(err.stdout, /2\/2/);

    // next-batch должен вернуть пустой список — комнаты нет вообще,
    // а не size=Math.min(batchSize, 2) по старой (неверной) формуле.
    const picked = JSON.parse(run(statePath, ['next-batch']));
    assert.deepEqual(picked, []);
  });
});

// Регрессия из аудита (п.5): can-start-batch/start-batch раньше считали
// только review, не writing. Второй батч мог стартовать, пока первый ещё
// пишется, и оба одновременно доходили до review, превышая потолок.
test('start-batch: второй батч не стартует, пока первый ещё writing (учёт writing+review)', () => {
  withTmp((statePath, dir) => {
    initCycle(statePath, dir, [
      { title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' },
    ], ['--max-in-review', '3', '--batch-size', '3']);
    run(statePath, ['set-state', 'running']);

    run(statePath, ['start-batch', '--slugs', 'a,b,c']); // 3 writing, потолок 3 — впритык
    const err = runFail(statePath, ['start-batch', '--slugs', 'd']);
    assert.match(err.stderr, /потолок очереди/);

    const s = getState(statePath);
    assert.deepEqual(
      s.plan.filter((t) => t.status === 'writing').map((t) => t.slug).sort(),
      ['a', 'b', 'c'],
    );
    assert.equal(find(s, 'd').status, 'planned');
  });
});

// Регрессия из аудита (п.5): to-review для тем owner:editor («пишем
// сами») никогда не проверял потолок вообще — можно было отправить на
// вычитку сколько угодно тем в обход start-batch.
test('to-review: тема owner:editor тоже упирается в потолок очереди', () => {
  withTmp((statePath, dir) => {
    initCycle(statePath, dir, [{ title: 'A' }, { title: 'B' }, { title: 'C' }], ['--max-in-review', '2']);
    run(statePath, ['set-state', 'running']);

    run(statePath, ['to-review', '--slug', 'a']);
    run(statePath, ['to-review', '--slug', 'b']);
    const err = runFail(statePath, ['to-review', '--slug', 'c']);
    assert.match(err.stderr, /потолок очереди/);

    const s = getState(statePath);
    assert.equal(find(s, 'c').status, 'planned');
  });
});

test('start-batch отказывает, если тем в батче больше, чем есть места в очереди', () => {
  withTmp((statePath, dir) => {
    initCycle(statePath, dir, [{ title: 'A' }, { title: 'B' }, { title: 'C' }], ['--max-in-review', '2']);
    run(statePath, ['set-state', 'running']);
    const err = runFail(statePath, ['start-batch', '--slugs', 'a,b,c']);
    assert.match(err.stderr, /потолок очереди/);
    // Атомарность: неудавшийся батч не должен оставлять темы в writing.
    const s = getState(statePath);
    assert.ok(s.plan.every((t) => t.status === 'planned'), 'откат должен вернуть все темы в planned');
  });
});

/* ------------------------------------------------------ accept/release */

test('accept требует статус review, release закрывает батч', () => {
  withTmp((statePath, dir) => {
    initCycle(statePath, dir, [{ title: 'A' }]);
    run(statePath, ['set-state', 'running']);

    const early = runFail(statePath, ['accept', '--slug', 'a']);
    assert.match(early.stderr, /переход planned → accepted не разрешён/);

    run(statePath, ['start-batch', '--slugs', 'a']);
    run(statePath, ['to-review', '--slug', 'a']);
    run(statePath, ['accept', '--slug', 'a']);
    run(statePath, ['release', '--slug', 'a']);

    const s = getState(statePath);
    assert.equal(s.plan[0].status, 'released');
    assert.equal(s.batches[0].state, 'closed');
    assert.equal(s.state, 'done', 'все темы released → цикл done');
  });
});

/* --------------------------------------------------------------- reset */

test('reset без --force отказывает, с --force возвращает idle', () => {
  withTmp((statePath, dir) => {
    initCycle(statePath, dir, [{ title: 'A' }]);
    runFail(statePath, ['reset']);
    run(statePath, ['reset', '--force']);
    assert.equal(getState(statePath).state, 'idle');
  });
});
