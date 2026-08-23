// Тесты миграции связок на текущий контракт.
//
// Главное, что здесь проверяется, — чего миграция НЕ делает. Соблазн
// «домигрировать до зелёного» ровно в том, чтобы дописать недостающие
// цитаты и источники: тогда все счётчики сойдутся, а доказательств
// по-прежнему не будет. Поэтому отдельный тест требует, чтобы связка
// после миграции оставалась красной, пока факты не сверены заново.
//
// Запуск: node --test scripts/factcheck/migrate-bundle.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateOne, todo } from './migrate-bundle.mjs';
import { validateFactcheckBundle } from './validate-bundle.mjs';
import { SCHEMA_VERSION } from './report-schema.mjs';
import { articleHash, articleNormHash } from './hashes.mjs';

const SLUG = '2026-08-06-legacy';

const ARTICLE = `---
title: "Старая статья"
description: "Описание статьи, зафакчеканной по предыдущему контракту факчека."
pubDate: "2026-08-06"
draft: false
---

Штраф по ч. 2 ст. 14.5 КоАП РФ — 10 000 ₽.
`;

/* Отчёт ровно того вида, что лежал в корпусе: ни версии контракта, ни
 * привязки к тексту, ни id, вердикт объявлен строкой «match». */
const LEGACY_REPORT = {
  claims: [
    {
      type: 'MONEY', raw: '10 000 ₽', status: 'match', severity: 'critical', confidence: 0.95,
      expectedValue: '10 000 ₽', explanation: 'Подтверждено research brief',
      sources: ['http://publication.pravo.gov.ru/document/0001202301010001'],
      action: 'keep', actionDetail: '',
    },
    {
      type: 'NPA_KOAP', raw: 'ч. 2 ст. 14.5', status: 'match', severity: 'critical', confidence: 0.9,
      expectedValue: 'ч. 2 ст. 14.5 КоАП РФ', explanation: 'Проверено ранее в этой сессии',
      sources: ['http://publication.pravo.gov.ru/document/0001202301010001'],
      action: 'keep', actionDetail: '',
    },
  ],
  summary: { overallStatus: 'match', criticalIssues: 0 },
};

const LEGACY_MARKER = (hash) => ({
  date: '2026-08-12', hash, result: 'passed', criticalMismatches: 0,
  rulesVersion: '2026-08-04', report: `src/data/factcheck/results/${SLUG}.json`,
});

function withRepo(fn, { hash = articleHash(ARTICLE), report = LEGACY_REPORT } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'migrate-bundle-')));
  for (const d of ['src/content/blog', 'src/data/factcheck/results', '.claude/factchecked']) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  writeFileSync(join(dir, 'src/content/blog', `${SLUG}.md`), ARTICLE);
  writeFileSync(join(dir, 'src/data/factcheck/results', `${SLUG}.json`), JSON.stringify(report));
  writeFileSync(join(dir, '.claude/factchecked', SLUG), JSON.stringify(LEGACY_MARKER(hash)));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const apply = (dir, r) => {
  writeFileSync(r.reportPath, r.text);
  writeFileSync(r.markerPath, JSON.stringify(r.marker, null, 2) + '\n');
};

test('печати контракта проставляются из того, что уже известно', () => {
  withRepo((dir) => {
    const r = migrateOne(SLUG, { root: dir });
    assert.equal(r.blocked, null);
    assert.equal(r.report.schemaVersion, SCHEMA_VERSION);
    assert.equal(r.report.articleHash, articleHash(ARTICLE));
    assert.equal(r.report.articleNormHash, articleNormHash(ARTICLE));
    assert.equal(r.report.policyVersion, '2026-08-04', 'rulesVersion не перенесён в policyVersion');
    assert.equal(r.report.checkedAt, '2026-08-12');
    /* Пространство отчёта, а не реестра (H-01). Прежняя раздача `c1…cN`
     * пересекалась с нумерацией извлечения и делала чужие id
     * резолвимыми: 159 ложных ссылок на корпусе. */
    assert.deepEqual(r.report.claims.map((c) => c.id), ['r1', 'r2']);
    assert.ok(r.marker.reportHash && r.marker.claimsHash);
  });
});

test('итог пересчитывается из утверждений, а не переносится', () => {
  const report = JSON.parse(JSON.stringify(LEGACY_REPORT));
  report.claims[1].status = 'uncertain'; // критическое утверждение открыто
  report.claims[1].action = 'add-references';
  withRepo((dir) => {
    const r = migrateOne(SLUG, { root: dir });
    assert.equal(r.report.summary.overallStatus, 'needs-rewrite');
    assert.equal(r.marker.result, 'failed', 'объявленный «passed» пережил миграцию');
    assert.equal(r.marker.criticalMismatches, 1);
  }, { report });
});

test('статья, правленная после факчека, не мигрируется', () => {
  withRepo((dir) => {
    const r = migrateOne(SLUG, { root: dir });
    assert.match(r.blocked, /правилась после факчека/);
  }, { hash: 'f'.repeat(64) });
});

/* ── и главное: миграция не выдаёт себя за проверку ─────────────────── */

test('после миграции связка остаётся красной: доказательств не прибавилось', () => {
  withRepo((dir) => {
    const r = migrateOne(SLUG, { root: dir });
    apply(dir, r);
    const v = validateFactcheckBundle({ root: dir, slug: SLUG, articleRaw: ARTICLE, staleDays: null });
    assert.equal(v.ok, false, 'миграция сделала связку зелёной — значит она дописала доказательства');
    assert.ok(v.blocking.some((p) => p.code === 'weak-evidence'), JSON.stringify(v.blocking));
  });
});

test('миграция не дописывает цитаты и формулировки', () => {
  withRepo((dir) => {
    const r = migrateOne(SLUG, { root: dir });
    for (const c of r.report.claims) {
      assert.equal(c.quote, undefined, 'появилась цитата, которой не было в отчёте');
      assert.equal(c.statement, undefined, 'появилась формулировка, которой не было в отчёте');
    }
  });
});

test('миграция идемпотентна: второй прогон менять нечего', () => {
  withRepo((dir) => {
    const first = migrateOne(SLUG, { root: dir });
    apply(dir, first);
    const second = migrateOne(SLUG, { root: dir });
    assert.deepEqual(second.done, [], `второй прогон снова что-то меняет: ${second.done.join(', ')}`);
  });
});

test('--todo считает работу по существу, а не строки файла', () => {
  withRepo((dir) => {
    const t = todo(SLUG, { root: dir });
    assert.equal(t.claims, 2);
    assert.equal(t.risky, 2, 'оба утверждения значимые: деньги и КоАП');
    assert.equal(t.noStatement, 2);
    assert.equal(t.noQuote, 2);
    assert.equal(t.coverageGaps, 0);
  });
});
