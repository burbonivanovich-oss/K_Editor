/**
 * H-03. Повторное извлечение не стирает смысловой проход.
 *
 * Regex видит числа, даты и номера норм. Он не видит «единого справочника
 * кодов нет» и «продажа запрещена» — то, ради чего и делается смысловой
 * проход. До этой правки `processOne` перезаписывал файл целиком, а
 * `--all` звал его для каждой статьи: 21 смысловое утверждение корпуса
 * стиралось одним прогоном, молча.
 *
 * Тесты гоняют скрипт подпроцессом на временном корне (FACTCHECK_ROOT),
 * а не на живом репозитории: тест, который пишет пробные статьи в
 * src/content/blog, однажды уже был принят за чужие правки и откачен.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'extract-claims.mjs');

const ARTICLE = `---
title: "Проба"
draft: true
---

Норматив ответа — 1,5 секунды, он установлен постановлением Правительства РФ от 21.11.2023 № 1944.

Единого справочника кодов в нормативных актах нет.

Штраф для юрлица — 30 000 ₽.
`;

/** Временный корень с одной статьёй. Живой корпус не трогаем. */
function sandbox(fn, { slug = '2026-01-01-proba', body = ARTICLE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'h03-'));
  mkdirSync(join(root, 'src/content/blog'), { recursive: true });
  mkdirSync(join(root, 'src/data/factcheck/claims'), { recursive: true });
  writeFileSync(join(root, 'src/content/blog', `${slug}.md`), body);
  const run = (args = [slug]) => {
    try {
      return { out: execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, FACTCHECK_ROOT: root } }), code: 0 };
    } catch (e) {
      return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status };
    }
  };
  const claims = () => JSON.parse(readFileSync(join(root, 'src/data/factcheck/claims', `${slug}.json`), 'utf8')).claims;
  const merge = (items) => {
    const f = join(root, 'semantic.json');
    writeFileSync(f, JSON.stringify(items));
    return run(['merge', slug, '--file', f]);
  };
  try { return fn({ root, slug, run, claims, merge, article: join(root, 'src/content/blog', `${slug}.md`) }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

const semantic = (cs) => cs.filter((c) => c.foundBy === 'semantic');

test('смысловое утверждение переживает повторное извлечение', () => {
  sandbox(({ run, claims, merge }) => {
    run();
    merge([{ raw: 'Единого справочника кодов в нормативных актах нет', why: 'regex такое не видит' }]);
    assert.equal(semantic(claims()).length, 1);

    run();                                   // ← прежде здесь всё стиралось
    const after = semantic(claims());
    assert.equal(after.length, 1, 'смысловое утверждение пропало при повторном прогоне');
    assert.equal(after[0].why, 'regex такое не видит', 'потеряна причина проверки');
    assert.equal(after[0].stale, undefined);
  });
});

test('--all тоже сохраняет: он зовёт тот же processOne', () => {
  sandbox(({ run, claims, merge }) => {
    run();
    merge([{ raw: 'Единого справочника кодов в нормативных актах нет' }]);
    run(['--all']);
    assert.equal(semantic(claims()).length, 1);
  });
});

test('позиция пересчитывается по цитате, а не переносится как есть', () => {
  sandbox(({ run, claims, merge, article }) => {
    run();
    merge([{ raw: 'Единого справочника кодов в нормативных актах нет' }]);
    const before = semantic(claims())[0].offset;

    // Дописали абзац сверху — текст сдвинулся.
    const src = readFileSync(article, 'utf8');
    writeFileSync(article, src.replace('Норматив ответа', 'Вводный абзац, которого раньше не было.\n\nНорматив ответа'));
    run();

    const after = semantic(claims())[0];
    assert.notEqual(after.offset, before, 'offset не пересчитан — указывает в другое место');
    assert.match(after.context, /справочника кодов/, 'контекст уехал вместе со старым offset');
  });
});

test('исчезнувшая цитата помечается stale и роняет прогон, а не исчезает молча', () => {
  sandbox(({ run, claims, merge, article }) => {
    run();
    merge([{ raw: 'Единого справочника кодов в нормативных актах нет' }]);

    writeFileSync(article, readFileSync(article, 'utf8')
      .replace('Единого справочника кодов в нормативных актах нет.', 'Справочник кодов ведёт оператор.'));

    const r = run();
    assert.equal(r.code, 1, 'исчезнувшее утверждение обязано ронять прогон');
    assert.match(r.out, /без цитаты в тексте/);

    const kept = semantic(claims());
    assert.equal(kept.length, 1, 'утверждение выброшено вместо пометки');
    assert.equal(kept[0].stale, true);
    assert.ok(kept[0].staleNote);
  });
});

test('--force удаляет stale осознанно', () => {
  sandbox(({ run, claims, merge, article }) => {
    run();
    merge([{ raw: 'Единого справочника кодов в нормативных актах нет' }]);
    writeFileSync(article, readFileSync(article, 'utf8')
      .replace('Единого справочника кодов в нормативных актах нет.', 'Справочник кодов ведёт оператор.'));

    const r = run([`${'2026-01-01-proba'}`, '--force']);
    assert.equal(r.code, 1, '--force всё равно сообщает о потере');
    assert.equal(semantic(claims()).length, 0);
  });
});

test('regex, доросший до места смыслового утверждения, не задваивает его', () => {
  sandbox(({ run, claims, merge }) => {
    run();
    // Цитата, которую regex уже находит сам (сумма).
    merge([{ raw: '30 000 ₽' }]);
    const n1 = claims().filter((c) => String(c.raw).includes('30 000')).length;
    run();
    const n2 = claims().filter((c) => String(c.raw).includes('30 000')).length;
    assert.equal(n2, n1, 'повторный прогон задвоил утверждение');
  });
});
