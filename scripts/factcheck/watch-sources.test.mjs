/**
 * J-04. Обратный индекс источников.
 *
 * `snapshotHash` фиксировал состояние страницы, но фиксация сама по себе
 * ничего не запускала: норму правят, отчёт продолжает ссылаться на
 * прежний отпечаток, и никто не узнаёт. Здесь проверяется, что по
 * изменившемуся источнику очередь перепроверки собирается сама — включая
 * статьи, которые пользуются записью реестра, а не источником напрямую.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sourceIndex, staleSources, affectedBySource,
  mergeQueue, writeQueue, openQueue, QUEUE,
} from './watch-sources.mjs';

const URL_NORM = 'https://example.gov/norm';
const URL_OTHER = 'https://example.gov/other';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

const claim = (id, url, over = {}) => ({
  id, claimId: `c${id}`, raw: '10 000 ₽',
  evidence: [{ kind: 'primary', sourceRole: 'norm', url, snapshotHash: H1, retrievedAt: '2026-08-01', quote: 'x', ...over }],
});

function withRepo({ reports = {}, facts = [] }, fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'watch-')));
  mkdirSync(join(root, 'src/data/factcheck/results'), { recursive: true });
  for (const [slug, claims] of Object.entries(reports)) {
    writeFileSync(join(root, 'src/data/factcheck/results', `${slug}.json`), JSON.stringify({ claims }));
  }
  writeFileSync(join(root, 'src/data/factcheck/facts.json'), JSON.stringify({ facts }));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('индекс собирает зависимости и от отчётов, и от реестра', () => {
  withRepo({
    reports: { a: [claim('r1', URL_NORM)], b: [claim('r1', URL_NORM), claim('r2', URL_OTHER)] },
    facts: [{ id: 'f1', usedBy: ['a', 'c'], evidence: { url: URL_NORM, snapshotHash: H1, retrievedAt: '2026-08-05' } }],
  }, (root) => {
    const idx = sourceIndex(root);
    assert.equal(idx.size, 2);
    assert.equal(idx.get(URL_NORM).dependents.length, 3, 'два утверждения и запись реестра');
    assert.equal(idx.get(URL_NORM).retrievedAt, '2026-08-05', 'берётся самая свежая дата обращения');
  });
});

test('сменившийся отпечаток собирает очередь, включая статьи записи реестра', () => {
  withRepo({
    reports: { a: [claim('r1', URL_NORM)] },
    facts: [{ id: 'f1', usedBy: ['b', 'c'], evidence: { url: URL_NORM, snapshotHash: H1, retrievedAt: '2026-08-05' } }],
  }, (root) => {
    const r = affectedBySource(root, URL_NORM, H2);
    assert.equal(r.changed, true);
    assert.deepEqual(r.articles, ['a', 'b', 'c'], 'статьи, зависящие через реестр, не попали в очередь');
  });
});

test('совпавший отпечаток очереди не создаёт', () => {
  withRepo({ reports: { a: [claim('r1', URL_NORM)] } }, (root) => {
    const r = affectedBySource(root, URL_NORM, H1);
    assert.equal(r.changed, false);
    assert.deepEqual(r.articles, []);
  });
});

test('источник без отпечатка попадает в очередь: сравнить не с чем', () => {
  withRepo({
    reports: { a: [claim('r1', URL_NORM, { snapshotHash: undefined })] },
  }, (root) => {
    const r = affectedBySource(root, URL_NORM, H2);
    assert.equal(r.changed, true);
    assert.equal(r.hadSnapshot, false);
    assert.deepEqual(r.articles, ['a']);
  });
});

test('незнакомый источник — не повод паниковать', () => {
  withRepo({ reports: { a: [claim('r1', URL_NORM)] } }, (root) => {
    assert.equal(affectedBySource(root, 'https://example.gov/третий', H2).known, false);
  });
});

test('дата обращения неизвестна — источник считается просроченным, а не свежим', () => {
  withRepo({
    reports: { a: [claim('r1', URL_NORM, { retrievedAt: undefined })] },
  }, (root) => {
    const stale = staleSources(root, { days: 180, today: '2026-08-21' });
    assert.equal(stale.length, 1);
    assert.equal(stale[0].age, null);
  });
});

test('свежий источник в очередь не попадает, просроченный попадает', () => {
  withRepo({
    reports: {
      a: [claim('r1', URL_NORM, { retrievedAt: '2026-08-01' })],
      b: [claim('r1', URL_OTHER, { retrievedAt: '2025-01-01' })],
    },
  }, (root) => {
    const stale = staleSources(root, { days: 180, today: '2026-08-21' });
    assert.deepEqual(stale.map((s) => s.url), [URL_OTHER]);
  });
});

/* ── очередь перепроверки ────────────────────────────────────────────── */

/* Находка, напечатанная в stdout, не переживает прогон: обход
 * закончился — «источник изменился» знает только тот, кто в этот момент
 * смотрел в лог. Очередь существует затем, чтобы находка дожила до
 * работы, и снималась не отметкой «сделано», а самим фактом
 * перепроверки. */
function tempRoot(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-')));
  mkdirSync(join(root, 'src/data/factcheck'), { recursive: true });
  mkdirSync(join(root, '.claude/factchecked'), { recursive: true });
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('дата обнаружения не обнуляется при повторном обходе', () => {
  tempRoot((root) => {
    const found = [{ slug: 'a', url: 'https://x/1', reason: 'страница изменилась' }];
    const first = mergeQueue(root, found, { today: '2026-01-10' });
    writeQueue(root, first.entries, { today: '2026-01-10' });
    assert.equal(first.added.length, 1);

    const second = mergeQueue(root, found, { today: '2026-03-01' });
    assert.equal(second.added.length, 0, 'повтор той же находки новой записью не считается');
    assert.equal(second.entries[0].detectedAt, '2026-01-10',
      'возраст записи — мера долга, обнулять его значит прятать залежавшееся');
  });
});

test('запись снимается перепроверкой, а не отметкой «сделано»', () => {
  tempRoot((root) => {
    const found = [{ slug: 'a', url: 'https://x/1', reason: 'страница изменилась' }];
    writeQueue(root, mergeQueue(root, found, { today: '2026-01-10' }).entries);

    /* Маркер старше находки — статью проверяли до того, как источник
     * изменился, и запись обязана остаться. */
    writeFileSync(join(root, '.claude/factchecked/a'), 'date: 2025-12-01\nresult: passed\n');
    assert.equal(mergeQueue(root, [], { today: '2026-03-01' }).entries.length, 1);

    writeFileSync(join(root, '.claude/factchecked/a'), 'date: 2026-02-02\nresult: passed\n');
    const after = mergeQueue(root, [], { today: '2026-03-01' });
    assert.equal(after.entries.length, 0, 'перепроверка после обнаружения закрывает запись');
    assert.equal(after.closed[0].checkedAt, '2026-02-02');
  });
});

test('пустая очередь — тоже запись: «обходили, чисто»', () => {
  tempRoot((root) => {
    writeQueue(root, [], { today: '2026-03-01' });
    assert.deepEqual(openQueue(root), []);
    assert.ok(existsSync(join(root, QUEUE)), 'файл обязан существовать и при пустой очереди');
  });
});
