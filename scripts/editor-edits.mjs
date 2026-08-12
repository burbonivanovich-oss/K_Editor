#!/usr/bin/env node
/**
 * Что редакция поправила руками — журнал правок, который читает автор.
 *
 * Вопрос со встречи 12.08.2026: «если я просто исправлю текст в доке, а не
 * напишу комментарий, бот это учтёт?». До сих пор — нет. Правка уезжала
 * в репозиторий вместе с принятым текстом и на этом заканчивалась: в
 * следующей статье бот писал ту же формулировку, потому что нигде не было
 * записано, что её не любят.
 *
 * Комментарий работал, а прямая правка — нет. Разница для редактора
 * необъяснимая: и то и другое он считает обратной связью.
 *
 * Скрипт сравнивает то, что бот написал (файл в репозитории), с тем, что
 * вернулось из дока после вычитки, и складывает разницу в журнал
 * docs/editorial-feedback.md. Журнал читает content-writer перед
 * написанием следующей статьи — это и есть «учёл».
 *
 * Сравнение по абзацам: правка внутри абзаца видна целиком, с контекстом,
 * а не как «слово туда, слово сюда». Абзацы, которые не менялись,
 * в журнал не попадают.
 *
 * Запуск:
 *   node scripts/editor-edits.mjs record --slug <slug> --doc /tmp/<slug>.md
 *   node scripts/editor-edits.mjs record --slug <slug> --doc … --dry-run
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.EDITS_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOG = join(ROOT, 'src', 'content', 'blog');
const JOURNAL = join(ROOT, 'docs', 'editorial-feedback.md');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
};
const die = (m) => { console.error(`✖ ${m}`); process.exit(1); };

/** Тело без frontmatter: сравниваем текст, а не служебные поля. */
function body(src) {
  const m = src.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? src.slice(m[0].length) : src;
}

/** Абзацы без markdown-шума, который экспорт Google Docs переставляет. */
function paragraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 40);           // заголовки и подписи не сравниваем
}

/** Похожесть двух абзацев по словам: ищем, откуда правка, а не что новое. */
function similarity(a, b) {
  const wa = new Set(a.toLowerCase().split(/\s+/));
  const wb = new Set(b.toLowerCase().split(/\s+/));
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(1, Math.min(wa.size, wb.size));
}

/**
 * Правки: для каждого абзаца из дока ищем ближайший исходный.
 * Совпал дословно — не правка. Похож, но не совпал — правка редакции.
 * Не похож ни на что — абзац дописали, тоже полезно знать.
 */
export function diffParagraphs(before, after) {
  const src = paragraphs(before);
  const dst = paragraphs(after);
  const untouched = new Set(src);
  const edits = [];

  for (const p of dst) {
    if (untouched.has(p)) { untouched.delete(p); continue; }
    let best = { score: 0, text: null };
    for (const s of src) {
      if (!untouched.has(s)) continue;
      const score = similarity(s, p);
      if (score > best.score) best = { score, text: s };
    }
    // 0.5 — переписанный абзац ещё узнаётся как тот же; ниже это уже
    // другой текст, и показывать «было» рядом бессмысленно.
    if (best.score >= 0.5) {
      untouched.delete(best.text);
      edits.push({ kind: 'изменён', before: best.text, after: p });
    } else {
      edits.push({ kind: 'добавлен', before: null, after: p });
    }
  }
  for (const s of untouched) edits.push({ kind: 'удалён', before: s, after: null });
  return edits;
}

/* CLI выполняется только при прямом запуске. Без этой проверки импорт
 * diffParagraphs из тестов запускал разбор аргументов и завершал процесс
 * на первой же строке. */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd !== 'record') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].split('/**')[1]);
    process.exit(cmd ? 1 : 0);
  }

  const slug = arg('slug');
  const docPath = arg('doc');
  if (!slug) die('нужен --slug <slug>');
  if (!docPath || !existsSync(docPath)) die('нужен --doc <файл с экспортом дока>');

  const file = existsSync(BLOG)
    ? readdirSync(BLOG).find((f) => f.replace(/\.mdx?$/, '').endsWith(slug))
    : null;
  if (!file) die(`статьи со slug «${slug}» нет в ${BLOG}`);

  const edits = diffParagraphs(body(readFileSync(join(BLOG, file), 'utf8')), body(readFileSync(docPath, 'utf8')));

  if (!edits.length) {
    console.log('Редакция текст не трогала — записывать нечего.');
    process.exit(0);
  }

  const date = new Date().toISOString().slice(0, 10);
  const lines = [`\n## ${date} · ${slug}\n`];
  for (const e of edits) {
    if (e.kind === 'изменён') {
      lines.push(`**Переписали абзац.**\n\n- Было: ${e.before}\n- Стало: ${e.after}\n`);
    } else if (e.kind === 'добавлен') {
      lines.push(`**Дописали абзац.** ${e.after}\n`);
    } else {
      lines.push(`**Убрали абзац.** ${e.before}\n`);
    }
  }
  const entry = lines.join('\n');

  if (process.argv.includes('--dry-run')) {
    console.log(entry);
    process.exit(0);
  }

  const head = [
    '# Что редакция правит руками',
    '',
    'Журнал прямых правок в доках: что бот написал и на что редакция это',
    'заменила. Ведётся автоматически при приёмке статьи.',
    '',
    '**Читать перед написанием следующей статьи.** Это единственный способ,',
    'которым прямая правка в документе влияет на будущие тексты: сама по себе',
    'она уезжает в репозиторий и забывается.',
    '',
    'Если одна и та же правка повторяется третий раз — это не правка, а',
    'правило. Место правила — `docs/content-rules.md`, а не этот журнал.',
    '',
  ].join('\n');

  const prev = existsSync(JOURNAL) ? readFileSync(JOURNAL, 'utf8') : head;
  writeFileSync(JOURNAL, prev.trimEnd() + '\n' + entry);
  console.log(`✅ Записано правок: ${edits.length} → docs/editorial-feedback.md`);
}
