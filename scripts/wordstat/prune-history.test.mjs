// Тесты ретенции Wordstat-данных (D-01) через реальный CLI (subprocess) на
// временной фикстуре (WORDSTAT_ROOT). Скрипт рекурсивно удаляет каталоги —
// без оверрайда пути тесты рвали бы настоящий src/data/wordstat/ (T-01).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'prune-history.mjs');

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'prune-history-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeDiscoveryDay(base, date) {
  mkdirSync(join(base, date), { recursive: true });
  writeFileSync(join(base, date, 'seed-a.json'), JSON.stringify({ seed: 'a', phrases: [] }));
}

function makeSnapshot(dir, date) {
  writeFileSync(join(dir, 'src/data/wordstat/snapshots', `${date}.json`), '{}');
}

function makeDiff(dir, date) {
  writeFileSync(join(dir, 'src/data/wordstat/discoveries/diffs', `${date}.md`), '# diff');
  writeFileSync(join(dir, 'src/data/wordstat/discoveries/diffs', `${date}.json`), '{}');
}

function run(dir, args = [], env = {}) {
  return execFileSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WORDSTAT_ROOT: dir, ...env },
  });
}

function seedFixture(dir, { discoveryDates, snapshotDates, diffDates, kontur = false }) {
  mkdirSync(join(dir, 'src/data/wordstat/snapshots'), { recursive: true });
  mkdirSync(join(dir, 'src/data/wordstat/discoveries/diffs'), { recursive: true });
  for (const d of discoveryDates) makeDiscoveryDay(join(dir, 'src/data/wordstat/discoveries'), d);
  for (const d of snapshotDates) makeSnapshot(dir, d);
  for (const d of diffDates) makeDiff(dir, d);
  if (kontur) {
    mkdirSync(join(dir, 'src/data/wordstat/discoveries/kontur/diffs'), { recursive: true });
    for (const d of discoveryDates) makeDiscoveryDay(join(dir, 'src/data/wordstat/discoveries/kontur'), d);
  }
}

test('prune-history: не трогает данные в пределах лимита', () => {
  withFixture((dir) => {
    seedFixture(dir, {
      discoveryDates: ['2026-08-01', '2026-08-02', '2026-08-03'],
      snapshotDates: ['2026-08-01', '2026-08-02'],
      diffDates: ['2026-08-01'],
    });
    run(dir, [], { KEEP_DISCOVERIES: '8', KEEP_SNAPSHOTS: '8', KEEP_DIFFS: '26' });
    const discDir = join(dir, 'src/data/wordstat/discoveries');
    const dated = readdirSync(discDir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n));
    assert.equal(dated.length, 3);
  });
});

test('prune-history: удаляет лишние datированные папки discoveries, оставляя самые свежие', () => {
  withFixture((dir) => {
    seedFixture(dir, {
      discoveryDates: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'],
      snapshotDates: [],
      diffDates: [],
    });
    run(dir, [], { KEEP_DISCOVERIES: '2', KEEP_SNAPSHOTS: '1', KEEP_DIFFS: '1' });
    const discDir = join(dir, 'src/data/wordstat/discoveries');
    const dated = readdirSync(discDir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
    assert.deepEqual(dated, ['2026-08-04', '2026-08-05']);
  });
});

test('prune-history: KEEP_DISCOVERIES никогда не опускается ниже 2 (diff-snapshots.mjs нужно две даты)', () => {
  withFixture((dir) => {
    seedFixture(dir, {
      discoveryDates: ['2026-08-01', '2026-08-02', '2026-08-03'],
      snapshotDates: [],
      diffDates: [],
    });
    run(dir, [], { KEEP_DISCOVERIES: '0' });
    const discDir = join(dir, 'src/data/wordstat/discoveries');
    const dated = readdirSync(discDir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n));
    assert.equal(dated.length, 2);
  });
});

test('prune-history: --dry-run ничего не удаляет', () => {
  withFixture((dir) => {
    seedFixture(dir, {
      discoveryDates: ['2026-08-01', '2026-08-02', '2026-08-03'],
      snapshotDates: ['2026-08-01', '2026-08-02', '2026-08-03'],
      diffDates: [],
    });
    const out = run(dir, ['--dry-run'], { KEEP_DISCOVERIES: '1', KEEP_SNAPSHOTS: '1' });
    assert.match(out, /dry-run/);
    const discDir = join(dir, 'src/data/wordstat/discoveries');
    const dated = readdirSync(discDir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n));
    assert.equal(dated.length, 3, 'dry-run не должен был ничего удалить');
    const snapFiles = readdirSync(join(dir, 'src/data/wordstat/snapshots'));
    assert.equal(snapFiles.length, 3);
  });
});

test('prune-history: чистит snapshots/*.json по KEEP_SNAPSHOTS', () => {
  withFixture((dir) => {
    seedFixture(dir, {
      discoveryDates: [],
      snapshotDates: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'],
      diffDates: [],
    });
    run(dir, [], { KEEP_DISCOVERIES: '2', KEEP_SNAPSHOTS: '2' });
    const snapFiles = readdirSync(join(dir, 'src/data/wordstat/snapshots')).sort();
    assert.deepEqual(snapFiles, ['2026-08-03.json', '2026-08-04.json']);
  });
});

test('prune-history: чистит diffs/ парами .md+.json по дате, по KEEP_DIFFS', () => {
  withFixture((dir) => {
    seedFixture(dir, {
      discoveryDates: [],
      snapshotDates: [],
      diffDates: ['2026-08-01', '2026-08-02', '2026-08-03'],
    });
    run(dir, [], { KEEP_DIFFS: '1', KEEP_DISCOVERIES: '2', KEEP_SNAPSHOTS: '1' });
    const diffFiles = readdirSync(join(dir, 'src/data/wordstat/discoveries/diffs')).sort();
    assert.deepEqual(diffFiles, ['2026-08-03.json', '2026-08-03.md']);
  });
});

test('prune-history: вложенный namespace (kontur) чистится независимо от корня', () => {
  withFixture((dir) => {
    seedFixture(dir, {
      discoveryDates: ['2026-08-01', '2026-08-02', '2026-08-03'],
      snapshotDates: [],
      diffDates: [],
      kontur: true,
    });
    run(dir, [], { KEEP_DISCOVERIES: '2', KEEP_SNAPSHOTS: '1', KEEP_DIFFS: '1' });
    const rootDated = readdirSync(join(dir, 'src/data/wordstat/discoveries'))
      .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
    const konturDated = readdirSync(join(dir, 'src/data/wordstat/discoveries/kontur'))
      .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
    assert.deepEqual(rootDated, ['2026-08-02', '2026-08-03']);
    assert.deepEqual(konturDated, ['2026-08-02', '2026-08-03']);
  });
});

test('prune-history: seeds.json и seeds-kontur.json не тронуты (это ручные входные данные, не дампы)', () => {
  withFixture((dir) => {
    seedFixture(dir, { discoveryDates: ['2026-08-01', '2026-08-02', '2026-08-03'], snapshotDates: [], diffDates: [] });
    writeFileSync(join(dir, 'src/data/wordstat/discoveries/seeds.json'), '[]');
    run(dir, [], { KEEP_DISCOVERIES: '1' });
    assert.ok(existsSync(join(dir, 'src/data/wordstat/discoveries/seeds.json')));
  });
});

test('prune-history: отсутствующие каталоги не роняют скрипт', () => {
  withFixture((dir) => {
    mkdirSync(join(dir, 'src/data/wordstat'), { recursive: true });
    const out = run(dir);
    assert.match(out, /Нечего удалять|К удалению/);
  });
});
