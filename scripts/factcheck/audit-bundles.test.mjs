// Тесты аудита связок по корпусу.
//
// Смысл проверки — отделить известный долг от новой поломки. Список
// исключений (legacy-allowlist.json) не делает статью зелёной: она
// по-прежнему печатается как непроверенная и не выпускается релизом.
// Он лишь удерживает CI от красного на десяти статьях, которые ждут
// перепроверки, — и обязан сокращаться, а не расти.
//
// Запуск: node --test scripts/factcheck/audit-bundles.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditBundles } from './audit-bundles.mjs';
import { writeBundle } from './bundle-fixture.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'audit-bundles.mjs');

const article = (slug, draft) => `---
title: "Статья ${slug}"
description: "Описание тестовой статьи достаточной длины для аудита связок факчека."
pubDate: "2026-08-13"
draft: ${draft}
---

Штраф по ч. 2 ст. 14.5 КоАП РФ — 10 000 ₽.
`;

function withCorpus(fn, { legacy = [], baselineOverride = null } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'audit-bundles-')));
  mkdirSync(join(dir, 'src/content/blog'), { recursive: true });
  mkdirSync(join(dir, 'src/data/factcheck'), { recursive: true });
  const add = (slug, draft = 'false') =>
    writeFileSync(join(dir, 'src/content/blog', `${slug}.md`), article(slug, draft));
  if (legacy.length) {
    /* baseline обязателен (I-03): список исключений сверяется с ним и
     * может только сокращаться. Без baseline сверять не с чем, и это
     * само по себе претензия — фикстура его проставляет. */
    writeFileSync(join(dir, 'src/data/factcheck/legacy-allowlist.json'),
      JSON.stringify({ reason: 'тест', baseline: baselineOverride ?? legacy, articles: legacy.map((slug) => ({ slug })) }));
  }
  try { return fn(dir, add); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const run = (dir, args = []) => {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, FACTCHECK_ROOT: dir } }) };
  } catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
};

test('здоровая связка проходит', () => {
  withCorpus((dir, add) => {
    add('a');
    writeBundle(dir, 'a');
    const rows = auditBundles({ root: dir });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ok, true, JSON.stringify(rows[0].problems));
  });
});

test('статья без факчека — находка, а не пропуск', () => {
  withCorpus((dir, add) => {
    add('a');
    const rows = auditBundles({ root: dir });
    assert.equal(rows[0].ok, false);
    assert.equal(rows[0].problems[0].code, 'no-marker');
  });
});

test('маркер старого контракта не считается проверкой', () => {
  withCorpus((dir, add) => {
    add('a');
    writeBundle(dir, 'a');
    // Тот самый старый вид: ни версии контракта, ни печатей.
    writeFileSync(join(dir, '.claude/factchecked/a'),
      JSON.stringify({ date: '2026-08-12', result: 'passed', criticalMismatches: 0, report: 'src/data/factcheck/results/a.json' }));
    const rows = auditBundles({ root: dir });
    assert.equal(rows[0].ok, false);
    assert.ok(rows[0].problems.some((p) => p.code === 'legacy-marker'), JSON.stringify(rows[0].problems));
  });
});

test('--strict краснеет на новой поломке', () => {
  withCorpus((dir, add) => {
    add('a');
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 1);
    assert.match(r.out, /не проходит контракт/);
  });
});

test('--strict не краснеет на черновике из списка исключений, но печатает его', () => {
  /* Черновик — статья с draft: true. Список исключений прикрывает
   * только их: опубликованный материал читают сейчас, и «известный
   * долг» на нём означает договорённость показывать читателю
   * непроверенное. Отдельный случай — в pipeline-guards.test.mjs. */
  withCorpus((dir, add) => {
    add('a', 'true');
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 0, 'известный долг черновика не должен ронять CI');
    assert.match(r.out, /Ждут перепроверки/);
    assert.match(r.out, /a —/);
  }, { legacy: ['a'] });
});

test('исключение для одной статьи не прикрывает другую', () => {
  withCorpus((dir, add) => {
    add('a');
    add('b');
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 1);
    assert.match(r.out, /b:/);
  }, { legacy: ['a'] });
});

test('--released смотрит только выпущенные', () => {
  withCorpus((dir, add) => {
    add('a', 'true');
    add('b', 'false');
    const rows = auditBundles({ root: dir, releasedOnly: true });
    assert.deepEqual(rows.map((r) => r.slug), ['b']);
  });
});

test('правка отчёта после выписки маркера — находка', () => {
  withCorpus((dir, add) => {
    add('a');
    const { report } = writeBundle(dir, 'a');
    report.claims[0].confidence = 0.5;
    writeFileSync(join(dir, 'src/data/factcheck/results/a.json'), JSON.stringify(report));
    const rows = auditBundles({ root: dir });
    assert.ok(rows[0].problems.some((p) => p.code === 'report-changed' || p.code === 'claims-changed'),
      JSON.stringify(rows[0].problems));
  });
});

test('вердикт маркера, не следующий из утверждений, — находка', () => {
  withCorpus((dir, add) => {
    add('a');
    writeBundle(dir, 'a', { result: 'passed', claims: [{
      id: 'c1', type: 'MONEY', raw: '10 000 ₽',
      statement: 'штраф по ч. 2 ст. 14.5 КоАП РФ для должностных лиц — не менее 10 000 ₽',
      status: 'uncertain', severity: 'critical', confidence: 0.4, action: 'add-references',
      quote: 'влечёт наложение административного штрафа на должностных лиц в размере не менее 10 000 рублей',
      sources: ['http://publication.pravo.gov.ru/document/0001202301010001'],
    }] });
    const rows = auditBundles({ root: dir });
    assert.ok(rows[0].problems.some((p) => p.code === 'result-mismatch'), JSON.stringify(rows[0].problems));
  });
});

/* ── I-03: список исключений может только сокращаться ───────────────── */

test('дописанная строка в списке исключений роняет строгий прогон', () => {
  withCorpus((dir, add) => {
    add('a');
    writeBundle(dir, 'a', { report: null });          // заведомо непроходящая связка
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 1, 'рост списка не уронил CI');
    assert.match(r.out, /Список исключений вырос/);
  }, { legacy: ['a'], baselineOverride: [] });
});

test('прогон печатает динамику долга, а не только его размер', () => {
  withCorpus((dir, add) => {
    add('a');
    writeBundle(dir, 'a', { report: null });
    assert.match(run(dir).out, /Долг по списку исключений: 1 из 2 \(закрыто 1\)/);
  }, { legacy: ['a'], baselineOverride: ['a', 'b'] });
});
