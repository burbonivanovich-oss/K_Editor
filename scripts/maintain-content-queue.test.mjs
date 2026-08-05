import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyDemand, demandForArticle, parseFrontmatter, parseMaintainQueue, buildQueue, ageDays } from './maintain-content-queue.mjs';

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'maintain-queue-test-'));
  const blogDir = join(dir, 'blog');
  const markersDir = join(dir, 'factchecked');
  mkdirSync(blogDir, { recursive: true });
  mkdirSync(markersDir, { recursive: true });
  try {
    return fn({ blogDir, markersDir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeArticle(blogDir, slug, fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push('---', 'Тело статьи.');
  writeFileSync(join(blogDir, `${slug}.md`), lines.join('\n') + '\n');
}

function writeMarker(markersDir, slug, date) {
  writeFileSync(join(markersDir, slug), JSON.stringify({ date, hash: 'x' }));
}

/* ------------------------------------------------------------ ageDays */

test('ageDays: null для отсутствующей даты, целые дни для присутствующей', () => {
  assert.equal(ageDays(null), null);
  const now = new Date('2026-08-05T00:00:00Z');
  assert.equal(ageDays('2026-07-01T00:00:00Z', now), 35);
});

/* --------------------------------------------------------- parseFrontmatter */

test('parseFrontmatter: читает reviewDate/updatedDate/draft и seo.keywords', () => {
  const text = `---
title: "Тест"
draft: false
reviewDate: "2026-01-01"
updatedDate: "2025-12-01"
seo:
  keywords:
    - целевой ключ
    - второй ключ
---
Тело статьи.
`;
  const fm = parseFrontmatter(text);
  assert.equal(fm.draft, 'false');
  assert.equal(fm.reviewDate, '2026-01-01');
  assert.deepEqual(fm._keywords, ['целевой ключ', 'второй ключ']);
});

test('parseFrontmatter: null без frontmatter', () => {
  assert.equal(parseFrontmatter('просто текст'), null);
});

/* ------------------------------------------------------- parseMaintainQueue */

test('parseMaintainQueue: разбирает записи с источником и без', () => {
  const text = `# Очередь
- 2026-01-15-chto-takoe-ts-piot — добавить письмо ФНС (источник: https://example.com/x)
- 2026-02-01-shtrafy — переформулировать вывод
`;
  const q = parseMaintainQueue(text);
  assert.equal(q.size, 2);
  assert.equal(q.get('2026-01-15-chto-takoe-ts-piot').source, 'https://example.com/x');
  assert.equal(q.get('2026-02-01-shtrafy').source, null);
});

/* ---------------------------------------------------------- classifyDemand */

test('classifyDemand: recent3/baseline6 >= 2 → up', () => {
  const history = [
    ...Array(6).fill(0).map((_, i) => ({ date: `2026-0${i + 1}`, count: 100 })),
    { date: '2026-07', count: 500 }, { date: '2026-08', count: 500 }, { date: '2026-09', count: 500 },
  ];
  const d = classifyDemand({ history });
  assert.equal(d.signal, 'up');
  assert.equal(d.baseline6, 100);
  assert.equal(d.recent3, 500);
});

test('classifyDemand: recent3/baseline6 <= 0.5 → down', () => {
  const history = [
    ...Array(6).fill(0).map((_, i) => ({ date: `2026-0${i + 1}`, count: 1000 })),
    { date: '2026-07', count: 100 }, { date: '2026-08', count: 100 }, { date: '2026-09', count: 100 },
  ];
  assert.equal(classifyDemand({ history }).signal, 'down');
});

test('classifyDemand: между порогами → stable', () => {
  const history = [
    ...Array(6).fill(0).map((_, i) => ({ date: `2026-0${i + 1}`, count: 1000 })),
    { date: '2026-07', count: 1000 }, { date: '2026-08', count: 1100 }, { date: '2026-09', count: 900 },
  ];
  assert.equal(classifyDemand({ history }).signal, 'stable');
});

test('classifyDemand: короче 9 точек — используем trend напрямую', () => {
  const history = [{ date: '2026-07', count: 10 }, { date: '2026-08', count: 20 }];
  assert.equal(classifyDemand({ history, trend: 'up' }).signal, 'up');
  assert.equal(classifyDemand({ history }).signal, null);
});

test('classifyDemand: baseline6 = 0 и recent3 > 0 → up (без деления на ноль)', () => {
  const history = [
    ...Array(6).fill(0).map((_, i) => ({ date: `2026-0${i + 1}`, count: 0 })),
    { date: '2026-07', count: 10 }, { date: '2026-08', count: 10 }, { date: '2026-09', count: 10 },
  ];
  assert.equal(classifyDemand({ history }).signal, 'up');
});

test('classifyDemand: узкий ключ, если topShows >= 3× shows', () => {
  const d = classifyDemand({ history: [], shows: 100, topShows: 400, topPhrase: 'широкий запрос' });
  assert.equal(d.narrowKeyword, 'широкий запрос');
});

test('demandForArticle: берёт первый keyword с записью в keys.json', () => {
  const keys = { 'ключ два': { history: [], trend: 'down' } };
  const d = demandForArticle(keys, ['Ключ Один', '"ключ два"']);
  assert.equal(d.keyword, 'ключ два');
  assert.equal(d.signal, 'down');
});

test('demandForArticle: null, если ни один keyword не найден', () => {
  assert.equal(demandForArticle({}, ['неизвестный']), null);
});

/* --------------------------------------------------------------- buildQueue */

const NOW = new Date('2026-08-05T00:00:00Z');

test('buildQueue: пустой blogDir → пустая очередь, без падения', () => {
  withFixture(({ blogDir, markersDir }) => {
    const rows = buildQueue({ blogDir, markersDir, keys: {}, queueEntries: new Map(), now: NOW });
    assert.deepEqual(rows, []);
  });
});

test('buildQueue: draft: true никогда не попадает в очередь', () => {
  withFixture(({ blogDir, markersDir }) => {
    writeArticle(blogDir, 'a', { title: '"A"', draft: 'true', reviewDate: '"2020-01-01"' });
    const rows = buildQueue({ blogDir, markersDir, keys: {}, queueEntries: new Map(), now: NOW });
    assert.deepEqual(rows, []);
  });
});

test('buildQueue: без маркера факчека → no-factcheck', () => {
  withFixture(({ blogDir, markersDir }) => {
    writeArticle(blogDir, 'a', { title: '"A"', draft: 'false' });
    const rows = buildQueue({ blogDir, markersDir, keys: {}, queueEntries: new Map(), now: NOW });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'no-factcheck');
    assert.equal(rows[0].factcheckStale, true);
  });
});

test('buildQueue: маркер старше 90 дней → stale-factcheck, свежий — не попадает', () => {
  withFixture(({ blogDir, markersDir }) => {
    writeArticle(blogDir, 'stale', { title: '"S"', draft: 'false' });
    writeMarker(markersDir, 'stale', '2026-01-01'); // > 90 дней до NOW
    writeArticle(blogDir, 'fresh', { title: '"F"', draft: 'false' });
    writeMarker(markersDir, 'fresh', '2026-08-01'); // < 90 дней до NOW

    const rows = buildQueue({ blogDir, markersDir, keys: {}, queueEntries: new Map(), now: NOW });
    assert.deepEqual(rows.map((r) => r.slug), ['stale']);
    assert.equal(rows[0].reason, 'stale-factcheck');
  });
});

test('buildQueue: reviewDate ≤ сегодня и маркер свежий → review-due', () => {
  withFixture(({ blogDir, markersDir }) => {
    writeArticle(blogDir, 'a', { title: '"A"', draft: 'false', reviewDate: '"2026-08-01"' });
    writeMarker(markersDir, 'a', '2026-08-01');
    const rows = buildQueue({ blogDir, markersDir, keys: {}, queueEntries: new Map(), now: NOW });
    assert.equal(rows[0].reason, 'review-due');
    assert.equal(rows[0].reviewDue, true);
  });
});

test('buildQueue: растущий спрос при свежем маркере и будущем reviewDate → demand-up', () => {
  withFixture(({ blogDir, markersDir }) => {
    writeArticle(blogDir, 'a', {
      title: '"A"', draft: 'false', reviewDate: '"2099-01-01"',
      seo: '\n  keywords:\n    - растущий ключ',
    });
    writeMarker(markersDir, 'a', '2026-08-01');
    const history = [
      ...Array(6).fill(0).map((_, i) => ({ date: `2026-0${i + 1}`, count: 100 })),
      { date: '2026-07', count: 500 }, { date: '2026-08', count: 500 }, { date: '2026-09', count: 500 },
    ];
    const keys = { 'растущий ключ': { history } };
    const rows = buildQueue({ blogDir, markersDir, keys, queueEntries: new Map(), now: NOW });
    assert.equal(rows[0].reason, 'demand-up');
    assert.equal(rows[0].demand.signal, 'up');
  });
});

test('buildQueue: статья без причин в очередь не попадает', () => {
  withFixture(({ blogDir, markersDir }) => {
    writeArticle(blogDir, 'a', { title: '"A"', draft: 'false', reviewDate: '"2099-01-01"' });
    writeMarker(markersDir, 'a', '2026-08-01');
    const rows = buildQueue({ blogDir, markersDir, keys: {}, queueEntries: new Map(), now: NOW });
    assert.deepEqual(rows, []);
  });
});

test('buildQueue: сортировка — maintain-queue, потом no-factcheck, потом stale-factcheck, потом review-due', () => {
  withFixture(({ blogDir, markersDir }) => {
    writeArticle(blogDir, 'due', { title: '"D"', draft: 'false', reviewDate: '"2026-08-01"' });
    writeMarker(markersDir, 'due', '2026-08-01');

    writeArticle(blogDir, 'stale', { title: '"S"', draft: 'false' });
    writeMarker(markersDir, 'stale', '2026-01-01');

    writeArticle(blogDir, 'none', { title: '"N"', draft: 'false' });
    // без маркера

    writeArticle(blogDir, 'queued', { title: '"Q"', draft: 'false' });
    writeMarker(markersDir, 'queued', '2026-08-01');

    const queueEntries = new Map([['queued', { note: 'из RSS', source: null }]]);
    const rows = buildQueue({ blogDir, markersDir, keys: {}, queueEntries, now: NOW });
    assert.deepEqual(rows.map((r) => r.slug), ['queued', 'none', 'stale', 'due']);
  });
});

test('buildQueue: несколько stale — старые маркеры впереди', () => {
  withFixture(({ blogDir, markersDir }) => {
    writeArticle(blogDir, 'older', { title: '"O"', draft: 'false' });
    writeMarker(markersDir, 'older', '2025-06-01');
    writeArticle(blogDir, 'newer', { title: '"N"', draft: 'false' });
    writeMarker(markersDir, 'newer', '2026-01-01');
    const rows = buildQueue({ blogDir, markersDir, keys: {}, queueEntries: new Map(), now: NOW });
    assert.deepEqual(rows.map((r) => r.slug), ['older', 'newer']);
  });
});
