#!/usr/bin/env node
/**
 * Текст промпта рутины — отдельно от её паспорта.
 *
 * Файлы `docs/routines/*.md` устроены в две части: шапка (триггер,
 * расписание, окружение, репозиторий) и после разделителя `---` — сам
 * промпт, который исполняется. Шапка нужна человеку, чтобы сверить файл
 * с платформой; исполнителю она не нужна и мешает — идентификатор
 * триггера конкретной платформы в промпте не значит ничего.
 *
 * Скрипт отдаёт вторую часть. Два применения, оба реальные:
 *
 *   1. Запланированная задача Codex. Промпт вставляется в неё руками, и
 *      вставлять надо ровно то, что версионируется, а не пересказ.
 *      `node scripts/routine-prompt.mjs c | pbcopy` — и в буфере текст.
 *   2. GitHub Actions (`.github/workflows/routines-codex.yml`) — шаг
 *      кладёт вывод в файл и передаёт его в `codex exec` как prompt-file.
 *
 * Без скрипта оба применения свелись бы к «скопируй руками нужный
 * кусок», а это ровно тот механизм, из-за которого промпты уже один раз
 * разошлись с репозиторием (docs/routines/README.md).
 *
 * Запуск:
 *   node scripts/routine-prompt.mjs <a0|a|b|c>
 *   node scripts/routine-prompt.mjs c --meta     только паспорт
 *   node scripts/routine-prompt.mjs --list
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'docs/routines';

/** Короткое имя рутины → файл. Совпадает с таблицей в docs/routines/README.md. */
export const ROUTINES = {
  a0: { file: 'a0-backlog.md', title: 'A0 — недельный бэклог тем' },
  a: { file: 'a-plan.md', title: 'A — контент-план цикла' },
  b: { file: 'b-listen.md', title: 'B — слушатель редактора' },
  c: { file: 'c-batch.md', title: 'C — батч статей' },
};

/**
 * Делит файл рутины на паспорт и промпт по первому разделителю `---`.
 *
 * @param {string} text
 * @returns {{ meta: Record<string,string>, prompt: string }}
 */
export function splitRoutine(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === '---');
  const headLines = at === -1 ? lines : lines.slice(0, at);
  const bodyLines = at === -1 ? [] : lines.slice(at + 1);

  const meta = {};
  for (const line of headLines) {
    const m = /^-\s+\*\*(.+?):\*\*\s*(.*)$/.exec(line);
    if (m) meta[m[1].trim()] = m[2].trim().replace(/^`|`$/g, '');
  }

  return { meta, prompt: bodyLines.join('\n').trim() + '\n' };
}

/**
 * @param {string} key — короткое имя рутины
 * @param {string} [root]
 */
export function routinePrompt(key, root = REPO) {
  const entry = ROUTINES[String(key).toLowerCase()];
  if (!entry) {
    throw new Error(`неизвестная рутина «${key}»; известны: ${Object.keys(ROUTINES).join(', ')}`);
  }
  const path = join(root, DIR, entry.file);
  if (!existsSync(path)) throw new Error(`нет файла ${DIR}/${entry.file}`);
  const { meta, prompt } = splitRoutine(readFileSync(path, 'utf8'));
  if (!prompt.trim()) throw new Error(`в ${DIR}/${entry.file} нет текста после разделителя ---`);
  return { ...entry, meta, prompt };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args.includes('--list') || args.length === 0) {
    console.log('Рутины:');
    for (const [key, { file, title }] of Object.entries(ROUTINES)) {
      console.log(`  ${key.padEnd(3)} ${title.padEnd(32)} ${DIR}/${file}`);
    }
    console.log('\nТекст промпта:  node scripts/routine-prompt.mjs <ключ>');
    process.exit(args.length === 0 ? 1 : 0);
  }

  try {
    const { meta, prompt } = routinePrompt(args[0]);
    if (args.includes('--meta')) {
      for (const [k, v] of Object.entries(meta)) console.log(`${k}: ${v}`);
    } else {
      process.stdout.write(prompt);
    }
  } catch (e) {
    console.error(`Ошибка: ${e.message}`);
    process.exit(1);
  }
}
