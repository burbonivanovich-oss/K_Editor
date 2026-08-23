/**
 * I-02 и I-03. Показатели замкнутости и запрет роста списка исключений.
 *
 * Главное свойство обоих — различать «проверили, чисто» и «не
 * проверяли». Ровно на этой разнице держался прежний зелёный статус:
 * health писал «все статьи фактчекнуты», потому что смотрел наличие
 * маркера, а не то, что маркер утверждает.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closureMetrics, metricRows } from './metrics.mjs';
import { allowlistGrowth } from './audit-bundles.mjs';
import { writeBundle } from './bundle-fixture.mjs';

const ARTICLE = `---
title: "Проба"
description: "Тестовая статья достаточной длины для подсчёта показателей."
pubDate: "2026-08-13"
draft: true
---

Штраф по ч. 2 ст. 14.5 КоАП РФ — 10 000 ₽.
`;

function withRepo(fn, { allowlist = null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'metrics-')));
  mkdirSync(join(root, 'src/content/blog'), { recursive: true });
  mkdirSync(join(root, 'src/data/factcheck'), { recursive: true });
  if (allowlist) {
    writeFileSync(join(root, 'src/data/factcheck/legacy-allowlist.json'), JSON.stringify(allowlist));
  }
  const add = (slug) => writeFileSync(join(root, 'src/content/blog', `${slug}.md`), ARTICLE);
  try { return fn({ root, add }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('здоровая связка даёт нули по всем показателям', () => {
  withRepo(({ root, add }) => {
    add('a');
    writeBundle(root, 'a');
    const m = closureMetrics(root);
    assert.equal(m.articles, 1);
    assert.deepEqual(metricRows(m).filter(([, v]) => Number(v) > 0), []);
  });
});

test('утверждение без исхода видно как orphan', () => {
  withRepo(({ root, add }) => {
    add('a');
    writeBundle(root, 'a', {
      extraction: [
        { id: 'cfix0001', type: 'MONEY', raw: '10 000 ₽', offset: 0, line: 8 },
        { id: 'clost', type: 'NPA_KOAP', raw: 'ч. 2 ст. 14.5', offset: 0, line: 8 },
      ],
    });
    assert.equal(closureMetrics(root).orphans, 1);
  });
});

test('ссылка в чужое утверждение считается отдельно от ссылки в никуда', () => {
  withRepo(({ root, add }) => {
    add('a');
    writeBundle(root, 'a', {
      claims: [{
        id: 'r1', claimId: 'cother', type: 'MONEY', raw: '10 000 ₽',
        statement: 'штраф по ч. 2 ст. 14.5 КоАП РФ — не менее 10 000 ₽',
        status: 'match', severity: 'critical', confidence: 0.9, action: 'keep',
        sources: ['http://publication.pravo.gov.ru/document/0001202301010001'],
      }],
      extraction: [{ id: 'cother', type: 'NPA_KOAP', raw: 'ч. 2 ст. 14.5', offset: 0, line: 8 }],
    });
    const m = closureMetrics(root);
    assert.equal(m.wrongTarget, 1, 'ссылка на другое место не посчитана');
    assert.equal(m.danglingId, 0, 'ссылка существует — это не «в никуда»');
  });
});

test('статья без отчёта не считается нулём проблем', () => {
  withRepo(({ root, add }) => {
    add('a');
    const m = closureMetrics(root);
    assert.equal(m.articles, 1);
    assert.equal(m.perArticle[0].checked, false, 'неразобранная статья попала в «проверено»');
  });
});

/* ── I-03: список исключений может только сокращаться ───────────────── */

test('строка, которой нет в baseline, — рост списка', () => {
  withRepo(({ root }) => {
    const g = allowlistGrowth(root);
    assert.equal(g.length, 1);
    assert.equal(g[0].slug, 'новенькая');
    assert.match(g[0].problem, /может только сокращаться/);
  }, { allowlist: { baseline: ['старая'], articles: [{ slug: 'старая' }, { slug: 'новенькая' }] } });
});

test('сокращение списка — не рост', () => {
  withRepo(({ root }) => {
    assert.deepEqual(allowlistGrowth(root), []);
  }, { allowlist: { baseline: ['a', 'b', 'c'], articles: [{ slug: 'b' }] } });
});

test('список без baseline сверять не с чем — и это претензия, а не «ок»', () => {
  withRepo(({ root }) => {
    const g = allowlistGrowth(root);
    assert.equal(g.length, 1);
    assert.match(g[0].problem, /нет baseline/);
  }, { allowlist: { articles: [{ slug: 'a' }] } });
});

test('пустого списка исключений достаточно, baseline при нём не нужен', () => {
  withRepo(({ root }) => {
    assert.deepEqual(allowlistGrowth(root), []);
  }, { allowlist: { articles: [] } });
});

test('живой список исключений корпуса не вырос', () => {
  /* Прямая проверка репозитория, а не фикстуры: именно здесь долг и
   * может незаметно прирасти. */
  assert.deepEqual(allowlistGrowth(), []);
});
