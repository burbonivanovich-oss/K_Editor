// Тесты проверки «нет ли уже статьи по этой теме».
//
// Живой случай 13.08.2026: рутина C посреди работы обнаружила, что тема
// «Касса от банка или отдельно» повторяет черновик четырёхдневной
// давности, остановилась и спросила владельца. Батч встал на несколько
// часов. Вопрос правильный, момент неправильный — проверка должна идти
// до ресёрча и отвечать сама.
//
// Запуск: node --test scripts/audit/check-draft-duplication.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-draft-duplication.mjs');

const DRAFT = `---
title: "Онлайн-кассы от банка или своя касса: что выбрать в 2026 году"
draft: true
seo:
  keywords:
    - онлайн кассы банк
    - касса от банка
---
Текст.
`;

const RELEASED = `---
title: "Маркировка обуви в рознице: что проверять на кассе"
draft: false
seo:
  keywords:
    - маркировка обуви
---
Текст.
`;

function withRepo(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dup-test-'));
  mkdirSync(join(dir, 'src/content/blog'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, 'src/content/blog', name), body);
  }
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(dir, query, args = []) {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, query, ...args], { encoding: 'utf8', env: { ...process.env, DUP_ROOT: dir } }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// Собственно случай, из-за которого скрипт появился.
test('дубль с черновиком находится и возвращает код 1', () => {
  withRepo({ 'a.md': DRAFT }, (dir) => {
    const r = run(dir, 'Касса от банка или отдельно: как банки предлагают онлайн-кассы бизнесу');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /черновик/);
    assert.match(r.out, /не писать/);
  });
});

test('черновики учитываются наравне с выпущенными', () => {
  withRepo({ 'a.md': DRAFT }, (dir) => {
    assert.notEqual(run(dir, 'онлайн кассы банк').code, 0, 'черновик не должен быть невидимым');
  });
});

test('несвязанная тема проходит чисто', () => {
  withRepo({ 'a.md': DRAFT, 'b.md': RELEASED }, (dir) => {
    const r = run(dir, 'Категории ВСД в Меркурии: чем отличаются и когда какая нужна');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /совпадений в репозитории нет/);
  });
});

test('совпадение по целевому запросу считается, даже если заголовки разные', () => {
  withRepo({ 'a.md': RELEASED }, (dir) => {
    assert.notEqual(run(dir, 'маркировка обуви').code, 0);
  });
});

test('пустой репозиторий — чисто, а не падение', () => {
  withRepo({}, (dir) => {
    assert.equal(run(dir, 'любая тема').code, 0);
  });
});

test('--json отдаёт машиночитаемый ответ с оценкой', () => {
  withRepo({ 'a.md': DRAFT }, (dir) => {
    const r = run(dir, 'онлайн кассы банк', ['--json']);
    const data = JSON.parse(r.out);
    assert.ok(data.hits.length >= 1);
    assert.ok(data.hits[0].score >= data.threshold);
    assert.equal(data.hits[0].draft, true);
  });
});

test('без темы — понятная ошибка использования', () => {
  try {
    execFileSync('node', [SCRIPT], { encoding: 'utf8' });
    assert.fail('ожидался ненулевой код');
  } catch (e) {
    assert.equal(e.status, 2);
    assert.match(e.stderr, /Использование/);
  }
});
