// Тесты write-marker: маркер нельзя перепривязать к изменённой статье.
//
// Дыра, которую закрывают эти тесты (C-02 внешнего аудита): маркер
// считал хеш ТЕКУЩЕГО текста, а отчёт своего хеша статьи не хранил
// вовсе. Инструкция после редакторской замены тела прямо предлагала
// позвать write-marker заново — и правка «не обязан» → «обязан»
// получала свежий маркер со старыми доказательствами, если набор чисел
// в статье не менялся. Сверить было не с чем.
//
// Теперь отчёт хранит смысловой отпечаток текста. Косметическая правка
// (снятый draft, экспорт из Google Docs) маркер перевыписать позволяет,
// смысловая — нет.
//
// Запуск: node --test scripts/factcheck/write-marker.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeBundle } from './bundle-fixture.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from './report-schema.mjs';
import { articleHash, articleNormHash } from './hashes.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'write-marker.mjs');
const SLUG = '2026-08-13-marker';

const article = (body) => `---
title: "Тестовая статья про кассы"
description: "Описание тестовой статьи достаточной длины для проверки маркера факчека."
pubDate: "2026-08-13"
draft: true
categories:
  - kkt
---

${body}
`;

const BODY = 'Продавец не обязан применять кассу. Штраф по ч. 2 ст. 14.5 КоАП РФ — 10 000 ₽.';

const CLAIMS = [
  {
    id: 'c1', type: 'MONEY', raw: '10 000 ₽',
    statement: 'штраф по ч. 2 ст. 14.5 КоАП РФ для должностных лиц — не менее 10 000 ₽',
    subject: 'должностное лицо', modality: 'statement', negated: false,
    status: 'match', severity: 'critical', confidence: 0.95,
    evidence: [{
      kind: 'primary', sourceRole: 'norm', url: 'http://publication.pravo.gov.ru/document/0001202301010001',
      locator: 'статья 14.5, часть 2', retrievedAt: '2026-08-20', effectiveAsOf: '2026-08-20',
      snapshotHash: 'c'.repeat(64),
      quote: 'влечёт наложение административного штрафа на должностных лиц в размере не менее 10 000 рублей',
    }],
    sources: ['http://publication.pravo.gov.ru/document/0001202301010001'],
    action: 'keep',
  },
  {
    id: 'c2', type: 'NPA_KOAP', raw: 'ч. 2 ст. 14.5',
    statement: 'ответственность за неприменение кассы установлена ч. 2 ст. 14.5 КоАП РФ',
    subject: 'пользователь ККТ', modality: 'statement', negated: false,
    status: 'match', severity: 'critical', confidence: 0.9,
    evidence: [{
      kind: 'primary', sourceRole: 'norm', url: 'http://publication.pravo.gov.ru/document/0001202301010001',
      locator: 'статья 14.5, часть 2', retrievedAt: '2026-08-20', effectiveAsOf: '2026-08-20',
      snapshotHash: 'd'.repeat(64),
      quote: 'Неприменение контрольно-кассовой техники в установленных законодательством случаях (ч. 2 ст. 14.5)',
    }],
    sources: ['http://publication.pravo.gov.ru/document/0001202301010001'],
    action: 'keep',
  },
];

function withRepo(fn, { body = BODY, summary = { overallStatus: 'ok', criticalIssues: 0 } } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'write-marker-')));
  for (const d of ['src/content/blog', 'src/data/factcheck/results', 'docs']) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  writeFileSync(join(dir, 'docs/editorial-policy.md'), '# Редполитика фикстуры\n');
  writeFileSync(join(dir, 'src/content/blog', `${SLUG}.md`), article(body));
  /* Связка достраивается общим помощником: реестр, классификация и
   * снимки первоисточников. Тест про маркер проверяет маркер, а не
   * умение собрать все бумаги руками. */
  const raw = article(body);
  const data = completeBundle(dir, SLUG, raw, { claims: structuredClone(CLAIMS), summary });
  writeFileSync(join(dir, 'src/data/factcheck/results', `${SLUG}.json`), JSON.stringify(data));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(dir, { expectFail = false } = {}) {
  try {
    const out = execFileSync('node', [SCRIPT, SLUG], {
      encoding: 'utf8', env: { ...process.env, FACTCHECK_ROOT: dir },
    });
    if (expectFail) assert.fail(`ожидался отказ, а маркер выписан: ${out}`);
    return { code: 0, out };
  } catch (e) {
    if (!expectFail) assert.fail(`write-marker упал: ${(e.stdout || '') + (e.stderr || '')}`);
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const readArticle = (dir) => readFileSync(join(dir, 'src/content/blog', `${SLUG}.md`), 'utf8');
const readReport = (dir) => JSON.parse(readFileSync(join(dir, 'src/data/factcheck/results', `${SLUG}.json`), 'utf8'));
const markerPath = (dir) => join(dir, '.claude/factchecked', SLUG);
const readMarker = (dir) => JSON.parse(readFileSync(markerPath(dir), 'utf8'));
const edit = (dir, from, to) => {
  const p = join(dir, 'src/content/blog', `${SLUG}.md`);
  const before = readFileSync(p, 'utf8');
  const after = before.replace(from, to);
  assert.notEqual(after, before, `правка «${from}» ничего не изменила — тест бы ничего не проверял`);
  writeFileSync(p, after);
};

/* ── контракт артефактов (C-01) ────────────────────────────────────── */

test('первый вызов проставляет печати контракта в отчёт и маркер', () => {
  withRepo((dir) => {
    run(dir);
    const report = readReport(dir);
    assert.equal(report.schemaVersion, SCHEMA_VERSION);
    assert.equal(report.articleHash, articleHash(readArticle(dir)));
    assert.equal(report.articleNormHash, articleNormHash(readArticle(dir)));
    assert.ok(report.policyVersion, 'нет policyVersion');

    const marker = readMarker(dir);
    assert.equal(marker.schemaVersion, SCHEMA_VERSION);
    assert.equal(marker.hash, articleHash(readArticle(dir)));
    assert.equal(marker.result, 'passed');
    assert.ok(marker.reportHash, 'нет reportHash — правку отчёта после маркера нечем поймать');
    assert.ok(marker.claimsHash, 'нет claimsHash');
    assert.equal(marker.policyVersion, report.policyVersion);
  });
});

test('итог маркера считается из утверждений, а не берётся из summary', () => {
  // Проверяющий объявил «ok», хотя одно критическое утверждение открыто.
  withRepo((dir) => {
    const p = join(dir, 'src/data/factcheck/results', `${SLUG}.json`);
    const r = JSON.parse(readFileSync(p, 'utf8'));
    r.claims[1].status = 'uncertain';
    r.claims[1].action = 'add-references';   // H-02: незакрытый вопрос обязан называть правку
    writeFileSync(p, JSON.stringify(r));

    run(dir);
    const marker = readMarker(dir);
    assert.equal(marker.result, 'failed', 'объявленный «ok» пересилил утверждения');
    assert.equal(marker.criticalMismatches, 1);
    assert.equal(readReport(dir).summary.overallStatus, 'needs-rewrite');
  });
}, );

/* ── C-02: перепривязка ────────────────────────────────────────────── */

test('смысловая правка при тех же числах — маркер не перевыписывается', () => {
  withRepo((dir) => {
    run(dir);
    const before = readMarker(dir);

    // Ровно случай из аудита: смысл на противоположный, цифры те же.
    edit(dir, 'не обязан применять', 'обязан применять');

    const r = run(dir, { expectFail: true });
    assert.match(r.out, /изменилась по существу|не совпадает/);
    assert.deepEqual(readMarker(dir), before, 'маркер всё-таки переписали');
  });
});

test('удаление куска текста — тоже смысловая правка', () => {
  withRepo((dir) => {
    run(dir);
    edit(dir, 'Продавец не обязан применять кассу. ', '');
    run(dir, { expectFail: true });
  });
});

test('снятие draft — косметическая правка, маркер перевыписывается', () => {
  withRepo((dir) => {
    run(dir);
    const before = readMarker(dir);
    edit(dir, 'draft: true', 'draft: false');

    const r = run(dir);
    assert.match(r.out, /косметическая правка/);
    const after = readMarker(dir);
    assert.equal(after.hash, articleHash(readArticle(dir)), 'хеш маркера не догнал текст');
    assert.notEqual(after.hash, before.hash);
    // Отчёт продолжает указывать на версию, на которой факчек делали.
    assert.equal(readReport(dir).articleHash, before.hash);
  });
});

test('мусор из экспорта Google Docs — косметическая правка', () => {
  withRepo((dir) => {
    run(dir);
    // Docs меняет тире и кавычки, добавляет хвостовые пробелы и слеши.
    const p = join(dir, 'src/content/blog', `${SLUG}.md`);
    writeFileSync(p, readFileSync(p, 'utf8')
      .replace('—', '-')
      .replace('ч. 2 ст. 14.5', 'ч\\. 2 ст\\. 14.5')
      .replace(/\n/g, '  \n'));
    run(dir);
  });
});

test('без отчёта маркера не бывает', () => {
  withRepo((dir) => {
    rmSync(join(dir, 'src/data/factcheck/results', `${SLUG}.json`));
    const r = run(dir, { expectFail: true });
    assert.match(r.out, /Нет отчёта факчека/);
    assert.ok(!existsSync(markerPath(dir)), 'маркер всё-таки появился');
  });
});

test('отчёт без доказательств маркера не даёт', () => {
  withRepo((dir) => {
    const p = join(dir, 'src/data/factcheck/results', `${SLUG}.json`);
    const r = JSON.parse(readFileSync(p, 'utf8'));
    delete r.claims[0].evidence;
    writeFileSync(p, JSON.stringify(r));
    const out = run(dir, { expectFail: true });
    assert.match(out.out, /не проходит контракт/);
    assert.ok(!existsSync(markerPath(dir)));
  });
});

test('значение из статьи, которого нет в отчёте, маркера не даёт', () => {
  withRepo((dir) => {
    const p = join(dir, 'src/data/factcheck/results', `${SLUG}.json`);
    const r = JSON.parse(readFileSync(p, 'utf8'));
    r.claims = [r.claims[1]]; // убрали утверждение про 10 000 ₽
    writeFileSync(p, JSON.stringify(r));
    const out = run(dir, { expectFail: true });
    /* Сообщение переехало в общий валидатор вместе с проверкой:
     * важно, что маркер не выписан и значение названо. */
    assert.match(out.out, /факчеком не разбирались|которых нет в отчёте/);
    assert.match(out.out, /10 000/);
  });
});
