#!/usr/bin/env node
/**
 * Точки входа для Codex — генерируются, а не пишутся руками.
 *
 * Процедуры цикла лежат в `.claude/commands/*.md`, роль-брифы — в
 * `.claude/agents/*.md`. Это канон, и он тоол-агностичен: обычный
 * markdown, который читает любой инструмент с доступом к файлам.
 *
 * Codex ищет своё в других местах и в другом формате:
 *
 *   .agents/skills/<имя>/SKILL.md   скиллы: явный вызов `$имя` и неявный
 *                                   подбор по description
 *   .codex/agents/<имя>.toml        субагенты: TOML с developer_instructions
 *
 * Соблазн — скопировать содержание в новый формат. Так делать нельзя, и
 * причина не эстетическая: два экземпляра процедуры расходятся молча.
 * Правку внесут в один файл, второй останется прежним, и разойдутся они
 * ровно в том месте, где текст важен, — в шлюзах и запретах. Проект уже
 * прошёл это с промптами рутин (docs/routines/README.md, причина 1):
 * пока текст жил только в платформе, правку 09.08 никто не отревьюил и
 * откатить её было нечем.
 *
 * Поэтому генерируемые файлы — точки входа, а не пересказ. Каждый
 * содержит ровно три вещи: имя, description для неявного подбора и
 * указание открыть канонический файл и выполнить его целиком. Меняется
 * процедура — генерировать заново не нужно: точка входа на неё только
 * ссылается. Перегенерация нужна лишь когда поменялся frontmatter
 * (description, argument-hint) или появился новый файл.
 *
 * `--check` ничего не пишет и возвращает 1, если сгенерированное
 * разошлось с каноном. Этим режимом гейт ловит забытую перегенерацию —
 * см. `scripts/codex-sync.test.mjs`.
 *
 * Запуск:
 *   node scripts/codex-sync.mjs            перегенерировать
 *   node scripts/codex-sync.mjs --check    только проверить (код 1 — разошлось)
 *   npm run codex:sync
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

export const COMMANDS_DIR = '.claude/commands';
export const AGENTS_DIR = '.claude/agents';
export const SKILLS_DIR = '.agents/skills';
export const CODEX_AGENTS_DIR = '.codex/agents';

/** Шапка «не правьте руками» — одинаковая во всех генерируемых файлах. */
const WARNING = 'Файл сгенерирован scripts/codex-sync.mjs. Не правьте его руками: правьте канонический файл, потом `npm run codex:sync`.';

/**
 * Минимальный разбор YAML-frontmatter: только строковые скаляры верхнего
 * уровня. Полный YAML здесь не нужен и был бы зависимостью ради двух
 * полей — `description` и `argument-hint`, оба всегда однострочные.
 *
 * @param {string} text
 * @returns {{ data: Record<string,string>, body: string }}
 */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    // Снимаем кавычки, если значение целиком в них.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    data[kv[1]] = v;
  }
  return { data, body: m[2] };
}

/** Значение для однострочной TOML-строки. */
export function tomlString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Значение для многострочной TOML-строки. */
export function tomlBlock(value) {
  const safe = String(value).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  return '"""\n' + safe + '\n"""';
}

/** Список `.md` в каталоге, без служебных файлов, отсортированный. */
function markdownFiles(root, dir) {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .sort();
}

/**
 * Текст скилла Codex для одной команды.
 *
 * @param {{ name: string, description: string, argumentHint: string }} cmd
 */
export function renderSkill(cmd) {
  const lines = [];
  lines.push('---');
  lines.push(`name: ${cmd.name}`);
  lines.push(`description: ${cmd.description}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${cmd.name}`);
  lines.push('');
  lines.push(`<!-- ${WARNING} -->`);
  lines.push('');
  lines.push(`Процедура целиком лежит в \`${COMMANDS_DIR}/${cmd.name}.md\`.`);
  lines.push('Открой этот файл и выполни его целиком, по порядку, не пропуская');
  lines.push('шлюзы и не пересказывая по памяти.');
  if (cmd.argumentHint) {
    lines.push('');
    lines.push(`Аргумент: ${cmd.argumentHint}`);
  }
  lines.push('');
  lines.push('Общие правила проекта, редполитика и словарь инструментов — `AGENTS.md`.');
  lines.push('');
  return lines.join('\n');
}

/**
 * Текст TOML-субагента Codex для одного роль-брифа.
 *
 * `developer_instructions` намеренно короткие: сам бриф остаётся в
 * markdown-файле, который субагент читает первым действием. Копия брифа
 * внутри TOML разошлась бы с оригиналом при первой же правке.
 *
 * @param {{ name: string, description: string }} agent
 */
export function renderAgent(agent) {
  const instructions = [
    `Твоя роль описана в ${AGENTS_DIR}/${agent.name}.md.`,
    '',
    'Первое действие — прочитать этот файл целиком и дальше следовать ему',
    'буквально. Не пересказывай его по памяти и не сокращай.',
    '',
    'Общие правила проекта, редполитика и словарь инструментов — AGENTS.md',
    'в корне репозитория. Язык работы и результата — только русский.',
  ].join('\n');

  return [
    `# ${WARNING}`,
    '',
    `name = ${tomlString(agent.name)}`,
    `description = ${tomlString(agent.description)}`,
    `developer_instructions = ${tomlBlock(instructions)}`,
    '',
  ].join('\n');
}

/**
 * Собирает полный список файлов, которые должны существовать.
 *
 * @param {string} [root]
 * @returns {Array<{ path: string, content: string }>}
 */
export function plan(root = REPO) {
  const out = [];

  for (const file of markdownFiles(root, COMMANDS_DIR)) {
    const name = file.replace(/\.md$/, '');
    const { data } = parseFrontmatter(readFileSync(join(root, COMMANDS_DIR, file), 'utf8'));
    const description = data.description || `Процедура ${name} из ${COMMANDS_DIR}/${file}.`;
    out.push({
      path: `${SKILLS_DIR}/${name}/SKILL.md`,
      content: renderSkill({ name, description, argumentHint: data['argument-hint'] || '' }),
    });
  }

  for (const file of markdownFiles(root, AGENTS_DIR)) {
    const fallback = file.replace(/\.md$/, '');
    const { data } = parseFrontmatter(readFileSync(join(root, AGENTS_DIR, file), 'utf8'));
    const name = data.name || fallback;
    const description = data.description || `Роль ${name} из ${AGENTS_DIR}/${file}.`;
    out.push({
      path: `${CODEX_AGENTS_DIR}/${name}.toml`,
      content: renderAgent({ name, description }),
    });
  }

  return out;
}

/**
 * @param {{ root?: string, check?: boolean }} [opts]
 * @returns {{ written: string[], stale: string[], extra: string[] }}
 */
export function sync({ root = REPO, check = false } = {}) {
  const files = plan(root);
  const written = [];
  const stale = [];

  for (const f of files) {
    const abs = join(root, f.path);
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    if (current === f.content) continue;
    stale.push(f.path);
    if (check) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    written.push(f.path);
  }

  // Файлы, оставшиеся от удалённых команд и ролей. Без этого шага
  // переименование команды оставляет мёртвый скилл, который Codex
  // продолжает предлагать по description.
  const expected = new Set(files.map((f) => f.path));
  const extra = [];

  const skillsRoot = join(root, SKILLS_DIR);
  if (existsSync(skillsRoot)) {
    for (const dir of readdirSync(skillsRoot)) {
      const rel = `${SKILLS_DIR}/${dir}/SKILL.md`;
      if (expected.has(rel) || !existsSync(join(root, rel))) continue;
      extra.push(rel);
      if (!check) rmSync(join(skillsRoot, dir), { recursive: true, force: true });
    }
  }

  const agentsRoot = join(root, CODEX_AGENTS_DIR);
  if (existsSync(agentsRoot)) {
    for (const file of readdirSync(agentsRoot)) {
      if (!file.endsWith('.toml')) continue;
      const rel = `${CODEX_AGENTS_DIR}/${file}`;
      if (expected.has(rel)) continue;
      extra.push(rel);
      if (!check) rmSync(join(agentsRoot, file), { force: true });
    }
  }

  return { written, stale, extra };
}

if (isMain(import.meta.url)) {
  const check = process.argv.includes('--check');
  const { written, stale, extra } = sync({ check });

  if (check) {
    if (stale.length === 0 && extra.length === 0) {
      console.log('Точки входа Codex совпадают с каноном.');
      process.exit(0);
    }
    console.error('Точки входа Codex разошлись с каноном.');
    for (const p of stale) console.error(`  устарел  ${p}`);
    for (const p of extra) console.error(`  лишний   ${p}`);
    console.error('\nПочините одной командой: npm run codex:sync');
    process.exit(1);
  }

  if (written.length === 0 && extra.length === 0) {
    console.log('Изменений нет — точки входа Codex уже актуальны.');
  } else {
    for (const p of written) console.log(`записан  ${p}`);
    for (const p of extra) console.log(`удалён   ${p}`);
    console.log(`\nИтого: ${written.length} записано, ${extra.length} удалено.`);
  }
}
