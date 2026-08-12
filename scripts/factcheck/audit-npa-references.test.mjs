// Тесты аудита ссылок на нормативку.
//
// Гейт стоит в CI со --strict и в выпуске: выдуманный номер закона не
// должен доехать до редактора. Скрипт работает от текущего каталога,
// поэтому тесты гоняют его на временном репозитории-фикстуре со своим
// справочником норм — настоящий sources.json не участвует.
//
// Запуск: node --test scripts/factcheck/audit-npa-references.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'audit-npa-references.mjs');

const SOURCES = {
  npaWhitelist: {
    fz: { 54: { topic: 'kkt', title: 'О применении ККТ' } },
    pp: {
      1944: { topic: 'markirovka', title: 'Разрешительный режим' },
      303: { topic: 'markirovka', title: 'Правила маркировки' },
    },
    prikaz: {},
  },
};

function withRepo(articles, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'npa-audit-test-'));
  mkdirSync(join(dir, 'src/content/blog'), { recursive: true });
  mkdirSync(join(dir, 'src/data/factcheck'), { recursive: true });
  writeFileSync(join(dir, 'src/data/factcheck/sources.json'), JSON.stringify(SOURCES));
  for (const [name, body] of Object.entries(articles)) {
    writeFileSync(join(dir, 'src/content/blog', name), body);
  }
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(dir, args = []) {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const article = (body, category = 'kkt') =>
  `---\ntitle: "Т"\ncategories:\n  - ${category}\ndraft: false\n---\n${body}\n`;

test('известный закон проходит', () => {
  withRepo({ 'a.md': article('Согласно 54-ФЗ касса обязана передавать чек.') }, (dir) => {
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 0, r.out);
  });
});

test('выдуманный номер закона — находка и ненулевой код', () => {
  withRepo({ 'a.md': article('Согласно 9999-ФЗ всё иначе.') }, (dir) => {
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 1);
    assert.match(r.out, /9999/);
  });
});

// Регрессия 12.08.2026: в соседнем скрипте постановления не находились
// вообще — «постановлени\w*» не матчит кириллическое окончание. Здесь
// regex другой, и это ровно то, что нужно закрепить.
test('постановление находится в любой падежной форме', () => {
  const forms = {
    'a.md': article('установлено постановлением Правительства РФ от 21.11.2023 № 1944.', 'markirovka'),
    'b.md': article('по пункту 19 постановления Правительства РФ № 303.', 'markirovka'),
    'c.md': article('см. постановление Правительства РФ № 1944.', 'markirovka'),
  };
  withRepo(forms, (dir) => {
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 0, `известные ПП не должны считаться неизвестными:\n${r.out}`);
    assert.match(r.out, /Уникальных ПП:\s+2/);
  });
});

test('незнакомое постановление не проходит молча', () => {
  withRepo({ 'a.md': article('постановлением Правительства РФ № 7777 введено новое.', 'markirovka') }, (dir) => {
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 1);
    assert.match(r.out, /7777/);
  });
});

// Номер настоящий, но норма не про тему статьи — это не блокер, а повод
// посмотреть глазами: слишком легко процитировать соседний закон.
test('норма из чужой темы попадает в needs-decision, но не роняет прогон', () => {
  withRepo({ 'a.md': article('см. постановление Правительства РФ № 1944.', 'kkt') }, (dir) => {
    const r = run(dir, ['--strict']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /needs-decision|не совпадает/i);
  });
});

test('без --strict находки печатаются, но код нулевой', () => {
  withRepo({ 'a.md': article('Согласно 9999-ФЗ всё иначе.') }, (dir) => {
    const r = run(dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /9999/);
  });
});

test('черновики тоже проверяются — ошибку дешевле поймать до выпуска', () => {
  withRepo({
    'a.md': `---\ntitle: "Т"\ncategories:\n  - kkt\ndraft: true\n---\nСогласно 9999-ФЗ.\n`,
  }, (dir) => {
    assert.equal(run(dir, ['--strict']).code, 1);
  });
});
