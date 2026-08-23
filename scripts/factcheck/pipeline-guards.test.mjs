/**
 * Инварианты уровня конвейера: то, что проверяется не внутри связки, а
 * между инструментами.
 *
 * Все они найдены повторным аудитом 21.08.2026, и у всех одна форма:
 * проверка видит красное и сообщает об этом текстом, а кодом возврата
 * говорит «всё в порядке». В CI и в скриптах читают код.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBundle } from './bundle-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = { audit: join(HERE, 'audit-bundles.mjs'), ratchet: join(HERE, 'debt-ratchet.mjs') };

const article = (slug, draft) => `---
title: "Статья ${slug}"
description: "Описание тестовой статьи достаточной длины для проверки инвариантов конвейера."
pubDate: "2026-08-13"
draft: ${draft}
---

Штраф по ч. 2 ст. 14.5 КоАП РФ — 10 000 ₽.
`;

function withRoot(fn, { allowlist = null, ratchet = null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'guards-')));
  mkdirSync(join(root, 'src/content/blog'), { recursive: true });
  mkdirSync(join(root, 'src/data/factcheck'), { recursive: true });
  if (allowlist) writeFileSync(join(root, 'src/data/factcheck/legacy-allowlist.json'), JSON.stringify(allowlist));
  if (ratchet) writeFileSync(join(root, 'src/data/factcheck/debt-ratchet.json'), JSON.stringify(ratchet));
  const add = (slug, draft = 'false') =>
    writeFileSync(join(root, 'src/content/blog', `${slug}.md`), article(slug, draft));
  try { return fn({ root, add }); } finally { rmSync(root, { recursive: true, force: true }); }
}

const run = (script, args, root) => {
  try {
    execFileSync('node', [script, ...args], { encoding: 'utf8', env: { ...process.env, FACTCHECK_ROOT: root } });
    return { code: 0 };
  } catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
};

/* ── пустой корпус ──────────────────────────────────────────────────── */

test('пустой корпус в строгом режиме — отказ, а не успех', () => {
  /* Прогон по пустому каталогу возвращал ноль и читался как «всё
   * проверено». Так выглядит битый checkout, неверный путь и рутина,
   * отработавшая не там. */
  withRoot(({ root }) => {
    assert.equal(run(SCRIPTS.audit, ['--strict'], root).code, 1);
    assert.equal(run(SCRIPTS.audit, ['--released', '--strict'], root).code, 1);
    assert.equal(run(SCRIPTS.ratchet, ['--check'], root).code, 1);
  });
});

test('без строгого режима пустой корпус — просто сообщение', () => {
  withRoot(({ root }) => {
    assert.equal(run(SCRIPTS.audit, [], root).code, 0);
  });
});

/* ── список исключений не прикрывает опубликованное ─────────────────── */

test('опубликованная статья в списке исключений роняет строгий прогон', () => {
  /* Список отделяет известный долг от новой поломки, и для черновика
   * это работает. Опубликованный материал читают сейчас: «известный
   * долг» на нём — договорённость показывать читателю непроверенное. */
  withRoot(({ root, add }) => {
    add('opublikovannaya', 'false');
    writeBundle(root, 'opublikovannaya', { report: null });   // связки нет
    const r = run(SCRIPTS.audit, ['--strict'], root);
    assert.equal(r.code, 1, 'опубликованная статья спряталась за списком исключений');
    assert.match(r.out, /Опубликованные статьи в списке исключений/);
  }, { allowlist: { baseline: ['opublikovannaya'], articles: [{ slug: 'opublikovannaya' }] } });
});

test('черновик в списке исключений строгий прогон не роняет', () => {
  withRoot(({ root, add }) => {
    add('chernovik', 'true');
    writeBundle(root, 'chernovik', { report: null });
    assert.equal(run(SCRIPTS.audit, ['--strict'], root).code, 0);
  }, { allowlist: { baseline: ['chernovik'], articles: [{ slug: 'chernovik' }] } });
});

test('--json в строгом режиме отвечает тем же кодом, что и обычный вывод', () => {
  /* Иначе достаточно попросить JSON, чтобы красное стало зелёным. */
  withRoot(({ root, add }) => {
    add('opublikovannaya', 'false');
    writeBundle(root, 'opublikovannaya', { report: null });
    assert.equal(run(SCRIPTS.audit, ['--strict', '--json'], root).code, 1);
  }, { allowlist: { baseline: ['opublikovannaya'], articles: [{ slug: 'opublikovannaya' }] } });
});

/* ── храповик долга ─────────────────────────────────────────────────── */

const RATCHET_ZERO = {
  schemaVersion: 1,
  sealedAt: '2026-08-21',
  metrics: {
    unchecked: 0, unclassifiedUnits: 0, orphans: 0, unlinked: 0, wrongTarget: 0, danglingId: 0,
    coverageMissing: 0, coveragePartial: 0, coverageConflicting: 0, weakEvidence: 0, allowlistDebt: 0,
  },
  concessions: [],
};

test('рост долга роняет прогон и называет показатели', () => {
  withRoot(({ root, add }) => {
    add('a', 'true');                       // статья без разбора — долг вырос
    const r = run(SCRIPTS.ratchet, ['--check'], root);
    assert.equal(r.code, 1);
    assert.match(r.out, /Долг вырос/);
  }, { ratchet: RATCHET_ZERO });
});

test('расширить потолок можно только с причиной', () => {
  withRoot(({ root, add }) => {
    add('a', 'true');
    assert.equal(run(SCRIPTS.ratchet, ['--accept'], root).code, 2, '--accept без причины должен отказывать');
    assert.equal(run(SCRIPTS.ratchet, ['--seal'], root).code, 1, '--seal не должен опускать потолок при росте');
  }, { ratchet: RATCHET_ZERO });
});

test('уступка записывается в журнал, а не просто меняет число', () => {
  withRoot(({ root, add }) => {
    add('a', 'true');
    assert.equal(run(SCRIPTS.ratchet, ['--accept', 'обкатка на тестовой статье'], root).code, 0);
    const after = JSON.parse(execFileSync('cat', [join(root, 'src/data/factcheck/debt-ratchet.json')], { encoding: 'utf8' }));
    assert.equal(after.concessions.length, 1);
    assert.equal(after.concessions[0].reason, 'обкатка на тестовой статье');
    assert.ok(after.concessions[0].grown.length, 'в уступке должно быть записано, что именно выросло');
    /* И после уступки прогон снова зелёный — потолок поднят осознанно. */
    assert.equal(run(SCRIPTS.ratchet, ['--check'], root).code, 0);
  }, { ratchet: RATCHET_ZERO });
});

/* ── происхождение разбора ───────────────────────────────────────────── */

/* Печать, которую ставит тот же прогон, что её и проверяет, не
 * свидетельствует ни о чём. `write-marker` раньше переписывал
 * `policyHash` и `contractVersion` текущими значениями до вызова
 * валидатора — и `policy-changed` с `weaker-contract` не срабатывали
 * никогда: к моменту проверки поля уже совпадали. */
const MARKER = join(HERE, 'write-marker.mjs');

function withPolicy(fn) {
  return withRoot(({ root, add }) => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs/editorial-policy.md'), '# Редполитика\n\nПравило первое.\n');
    const policy = (text) => writeFileSync(join(root, 'docs/editorial-policy.md'), text);
    return fn({ root, add, policy });
  });
}

test('редполитика изменилась после разбора — маркер не переставляется молча', () => {
  withPolicy(({ root, add, policy }) => {
    add('a-policy', 'true');
    writeBundle(root, 'a-policy', {});
    assert.equal(run(MARKER, ['a-policy'], root).code, 0, 'первый разбор обязан пройти');

    policy('# Редполитика\n\nПравило первое. Правило второе.\n');
    const again = run(MARKER, ['a-policy'], root);
    assert.equal(again.code, 1, 'разбор по прежним правилам не подтверждается новой печатью');
    assert.match(again.out, /Редполитика изменилась/);

    const accepted = run(MARKER, ['a-policy', '--accept-policy', 'переверстка, правил не меняет'], root);
    assert.equal(accepted.code, 0, 'осознанная оговорка должна проходить');
    const rep = JSON.parse(
      readFileSync(join(root, 'src/data/factcheck/results/a-policy.json'), 'utf8'),
    );
    assert.equal(rep.policyReview?.length, 1, 'оговорка обязана остаться записью в отчёте');
    assert.match(rep.policyReview[0].reason, /переверстка/);
  });
});

test('версию контракта проверок задним числом не поднять', () => {
  withPolicy(({ root, add }) => {
    add('a-contract', 'true');
    writeBundle(root, 'a-contract', {});
    assert.equal(run(MARKER, ['a-contract'], root).code, 0);

    const p = join(root, 'src/data/factcheck/results/a-contract.json');
    const rep = JSON.parse(readFileSync(p, 'utf8'));
    rep.contractVersion = 1;
    writeFileSync(p, JSON.stringify(rep, null, 2));

    const r = run(MARKER, ['a-contract'], root);
    assert.equal(r.code, 1, 'старый контракт нельзя объявить пройденным');
    assert.match(r.out, /контракту проверок 1/);
  });
});
