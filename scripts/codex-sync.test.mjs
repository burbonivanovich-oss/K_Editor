// Тесты генератора точек входа для Codex.
//
// Главный тест здесь — последний: он прогоняет `--check` на реальном
// репозитории. Без него генератор бесполезен ровно в том случае, ради
// которого написан: кто-то добавил команду в `.claude/commands/`, забыл
// перегенерировать, и Codex про неё не знает. Молча, без единой ошибки.
//
// Запуск: node --test scripts/codex-sync.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, tomlString, tomlBlock, plan, sync } from './codex-sync.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'codex-sync.mjs');
const REPO = join(HERE, '..');

/** Временный репозиторий с одной командой и одним роль-брифом. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-sync-'));
  mkdirSync(join(root, '.claude/commands'), { recursive: true });
  mkdirSync(join(root, '.claude/agents'), { recursive: true });
  writeFileSync(
    join(root, '.claude/commands/demo.md'),
    '---\ndescription: Демо-процедура.\nargument-hint: "<slug>"\n---\n\n# demo\n',
  );
  writeFileSync(
    join(root, '.claude/agents/demo-role.md'),
    '---\nname: demo-role\ndescription: Демо-роль.\n---\n\n# роль\n',
  );
  return root;
}

test('parseFrontmatter читает скаляры и снимает кавычки', () => {
  const { data, body } = parseFrontmatter('---\ndescription: Текст\nargument-hint: "<slug>"\n---\nтело\n');
  assert.equal(data.description, 'Текст');
  assert.equal(data['argument-hint'], '<slug>');
  assert.equal(body.trim(), 'тело');
});

test('parseFrontmatter не падает на файле без frontmatter', () => {
  const { data, body } = parseFrontmatter('# просто заголовок\n');
  assert.deepEqual(data, {});
  assert.match(body, /просто заголовок/);
});

test('tomlString экранирует кавычки и обратные слэши', () => {
  assert.equal(tomlString('он сказал "да"'), '"он сказал \\"да\\""');
  assert.equal(tomlString('C:\\путь'), '"C:\\\\путь"');
});

test('tomlBlock не даёт закрыть блок изнутри', () => {
  assert.ok(!tomlBlock('текст """ хвост').includes('\n"""\n hvost'));
  assert.ok(tomlBlock('обычный текст').startsWith('"""\n'));
});

test('на каждую команду скилл, на каждую роль TOML', () => {
  const root = fixture();
  try {
    const files = plan(root).map((f) => f.path);
    assert.ok(files.includes('.agents/skills/demo/SKILL.md'));
    assert.ok(files.includes('.codex/agents/demo-role.toml'));
    assert.equal(files.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('скилл ссылается на канон и не копирует процедуру', () => {
  const root = fixture();
  try {
    sync({ root });
    const skill = readFileSync(join(root, '.agents/skills/demo/SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: demo\ndescription: Демо-процедура\./);
    assert.match(skill, /\.claude\/commands\/demo\.md/);
    assert.match(skill, /Аргумент: <slug>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TOML роли ссылается на бриф, а не пересказывает его', () => {
  const root = fixture();
  try {
    sync({ root });
    const toml = readFileSync(join(root, '.codex/agents/demo-role.toml'), 'utf8');
    assert.match(toml, /name = "demo-role"/);
    assert.match(toml, /description = "Демо-роль\."/);
    assert.match(toml, /\.claude\/agents\/demo-role\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--check видит устаревший файл и не чинит его молча', () => {
  const root = fixture();
  try {
    sync({ root });
    writeFileSync(join(root, '.agents/skills/demo/SKILL.md'), 'протухло\n');
    const dry = sync({ root, check: true });
    assert.deepEqual(dry.stale, ['.agents/skills/demo/SKILL.md']);
    assert.equal(readFileSync(join(root, '.agents/skills/demo/SKILL.md'), 'utf8'), 'протухло\n');
    const fixed = sync({ root });
    assert.deepEqual(fixed.written, ['.agents/skills/demo/SKILL.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('точка входа удалённой команды не остаётся мёртвой', () => {
  const root = fixture();
  try {
    sync({ root });
    rmSync(join(root, '.claude/commands/demo.md'));
    const { extra } = sync({ root });
    assert.deepEqual(extra, ['.agents/skills/demo/SKILL.md']);
    assert.ok(!existsSync(join(root, '.agents/skills/demo')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('репозиторий синхронизирован: node scripts/codex-sync.mjs --check', () => {
  // Падает — значит кто-то тронул .claude/commands или .claude/agents и
  // не перегенерировал. Чинится одной командой: npm run codex:sync
  execFileSync('node', [SCRIPT, '--check'], { cwd: REPO, stdio: 'pipe' });
});
