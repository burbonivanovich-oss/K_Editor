// Тесты памяти об отказах: заглушка, срок, пограничная зона.
//
// Пограничная зона появилась 12.08.2026: между 0.25 и 0.4 счётчик слов
// честно ответить не может — «интернет-эквайринг» и «Интернет-эквайринг
// для онлайн-магазина: как выбрать банк и тариф» для человека одна тема,
// для пересечения слов разные. Раньше такие пары молча проходили, и
// редактор отказывал второй раз.
//
// Запуск: node --test scripts/topics/suppressions.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE = {
  schemaVersion: 1,
  suppressions: [{
    topic: 'Интернет-эквайринг для онлайн-магазина: как выбрать банк и тариф',
    reason: 'core',
    cluster: 'ekvairing',
    note: 'выбор банка и тарифов не наша тема',
    declinedAt: '2026-08-09',
    suppressUntil: '2099-01-01',
    hits: 1,
  }],
};

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'suppressions-test-'));
  const file = join(dir, 'topic-suppressions.json');
  writeFileSync(file, JSON.stringify(FIXTURE));
  process.env.SUPPRESSIONS_PATH = file;
  try { return fn(); } finally {
    delete process.env.SUPPRESSIONS_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
}

const mod = () => import(`./suppressions.mjs?t=${Date.now()}`);

test('дословная тема заглушена', async () => {
  await withFixture(async () => {
    const { isSuppressed, load } = await mod();
    assert.ok(isSuppressed(FIXTURE.suppressions[0].topic, load()));
  });
});

test('короткая форма той же темы — пограничная, а не «чисто»', async () => {
  await withFixture(async () => {
    const { borderline, isSuppressed, load } = await mod();
    const data = load();
    assert.equal(isSuppressed('интернет-эквайринг', data), null, 'автоматически не глушим');
    const near = borderline('интернет-эквайринг', data);
    assert.equal(near.length, 1);
    assert.ok(near[0].score >= 0.25 && near[0].score < 0.4, `score вне зоны: ${near[0].score}`);
    assert.match(near[0].note, /не наша тема/);
  });
});

test('несвязанная тема не попадает в пограничные', async () => {
  await withFixture(async () => {
    const { borderline, load } = await mod();
    assert.deepEqual(borderline('маркировка обуви в рознице', load()), []);
  });
});

test('уже заглушённая тема в пограничные не дублируется', async () => {
  await withFixture(async () => {
    const { borderline, load } = await mod();
    assert.deepEqual(borderline(FIXTURE.suppressions[0].topic, load()), []);
  });
});
