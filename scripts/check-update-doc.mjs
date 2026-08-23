#!/usr/bin/env node
/**
 * Проверка документа актуализации.
 *
 * Актуализация — не статья, и проверять её как статью нельзя. Здесь нет
 * своего заголовка, своей длины и своих ключей; есть чужой текст и
 * предложения к нему. Прогонять такой документ через check-seo
 * бессмысленно, а не прогонять ничего — опасно: именно в этом жанре
 * проще всего незаметно съехать в пересказ.
 *
 * 13.08.2026 съехали ровно так. Редактор просил: «Не менять в тексте то,
 * что еще актуально, только предложить новые правки», — а в ответ
 * получил новую статью на ту же тему. Формально хорошую: 100/100,
 * факчек зелёный, 0/10 маркеров. По задаче — не то.
 *
 * Скрипт проверяет форму, а не содержание:
 *   • у каждой правки есть цитата «Было» — иначе неясно, что меняем;
 *   • у каждой правки есть «Почему» со ссылкой — иначе это вкусовщина;
 *   • раздел «Что оставить как есть» заполнен — это прямая просьба
 *     редакции, и молчание о ней читается как «переписать всё»;
 *   • у каждого места под промо есть и подводка, и ссылка.
 *
 * Что́ правильно менять и правда ли норма изменилась — решает ИИ и
 * факчек, не этот скрипт.
 *
 * Запуск:
 *   node scripts/check-update-doc.mjs src/content/updates/<файл>.md
 *   node scripts/check-update-doc.mjs --all
 *
 * Коды: 0 — форма в порядке, 1 — есть нарушения, 2 — файл не найден.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const ROOT = process.env.UPDATE_DOC_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATES_DIR = join(ROOT, 'src/content/updates');

const REQUIRED_FIELDS = ['sourceUrl', 'sourceTitle', 'checkedAt', 'verdict'];
const VERDICTS = ['needs-update', 'up-to-date'];

/** Разделы верхнего уровня, по которым режется документ. */
function sections(body) {
  const out = new Map();
  const parts = body.split(/^##\s+/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const title = (nl === -1 ? p : p.slice(0, nl)).trim();
    out.set(title.toLowerCase(), nl === -1 ? '' : p.slice(nl + 1));
  }
  return out;
}

/** Блоки третьего уровня внутри раздела. */
const blocks = (text) =>
  text.split(/^###\s+/m).slice(1).map((b) => {
    const nl = b.indexOf('\n');
    return { title: (nl === -1 ? b : b.slice(0, nl)).trim(), body: nl === -1 ? '' : b.slice(nl + 1) };
  });

const field = (block, name) =>
  block.match(new RegExp(`\\*\\*${name}:?\\*\\*:?\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*|$)`, 'i'))?.[1]?.trim() ?? '';

const hasUrl = (s) => /https?:\/\/\S+/.test(s);

export function checkUpdateDoc(text, name = 'документ') {
  const problems = [];
  const fmRaw = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!fmRaw) return [{ name, problem: 'нет frontmatter — документ не привязан к исходной статье' }];

  const fm = {};
  for (const line of fmRaw.split('\n')) {
    const kv = line.match(/^(\w+):\s*["']?(.*?)["']?\s*$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }

  for (const f of REQUIRED_FIELDS) {
    if (!fm[f]) problems.push({ name, problem: `в frontmatter нет поля ${f}` });
  }
  if (fm.verdict && !VERDICTS.includes(fm.verdict)) {
    problems.push({ name, problem: `verdict «${fm.verdict}» — ожидается ${VERDICTS.join(' или ')}` });
  }
  if (fm.sourceUrl && !hasUrl(fm.sourceUrl)) {
    problems.push({ name, problem: 'sourceUrl не похож на ссылку' });
  }

  const body = text.slice(text.indexOf('\n---', 3) + 4);
  const secs = sections(body);
  const edits = blocks(secs.get('правки') ?? '');

  /* Вердикт «нужна актуализация» без единой правки — это не результат, а
   * незаконченная работа. Обратное тоже проверяем: правки при вердикте
   * «актуальна» означают, что вердикт забыли переставить. */
  if (fm.verdict === 'needs-update' && !edits.length) {
    problems.push({ name, problem: 'вердикт needs-update, но в разделе «Правки» нет ни одной' });
  }
  if (fm.verdict === 'up-to-date' && edits.length) {
    problems.push({ name, problem: `вердикт up-to-date, но правок ${edits.length} — вердикт или правки лишние` });
  }

  for (const e of edits) {
    const label = `«${e.title}»`;
    const was = field(e.body, 'Было');
    const now = field(e.body, 'Стало');
    const why = field(e.body, 'Почему');

    // Цитата обязана быть цитатой: без неё редактор не найдёт место в
    // своей статье, а мы не докажем, что не выдумали исходный текст.
    if (!was) problems.push({ name, problem: `${label}: нет блока «Было» — неясно, какой фрагмент меняем` });
    else if (!/^>/m.test(e.body)) {
      problems.push({ name, problem: `${label}: «Было» не оформлено цитатой (строка с «>»)` });
    }
    if (!now) problems.push({ name, problem: `${label}: нет блока «Стало»` });
    if (!why) problems.push({ name, problem: `${label}: нет блока «Почему»` });
    else if (!hasUrl(why)) {
      problems.push({ name, problem: `${label}: в «Почему» нет ссылки на источник — правка ничем не подкреплена` });
    }
  }

  /* Прямая просьба редакции: «не менять то, что ещё актуально». Пустой
   * раздел означает, что проверяли только то, что меняем, — а редактору
   * нужно знать и обратное, иначе он перечитывает статью целиком сам. */
  const keep = (secs.get('что оставить как есть') ?? '').trim();
  if (fm.verdict === 'needs-update' && !/^[-*]\s+\S/m.test(keep)) {
    problems.push({ name, problem: 'раздел «Что оставить как есть» пуст — редакция просила назвать и то, что не трогаем' });
  }

  for (const p of blocks(secs.get('промо маркета') ?? '')) {
    const lead = field(p.body, 'Подводка');
    const link = field(p.body, 'Ссылка');
    if (!lead) problems.push({ name, problem: `промо «${p.title}»: нет подводки — редакция просила текстовую подводку, а не голую ссылку` });
    if (!hasUrl(link)) problems.push({ name, problem: `промо «${p.title}»: нет ссылки` });
  }

  return problems;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  let files;
  if (args.includes('--all')) {
    // README каталога — описание формата, а не документ актуализации.
    files = existsSync(UPDATES_DIR)
      ? readdirSync(UPDATES_DIR)
        .filter((f) => /\.mdx?$/.test(f) && f.toLowerCase() !== 'readme.md')
        .map((f) => join(UPDATES_DIR, f))
      : [];
    if (!files.length) {
      console.log('Документов актуализации нет — проверять нечего.');
      process.exit(0);
    }
  } else {
    const p = args.find((a) => !a.startsWith('--'));
    if (!p) {
      console.error('Использование: check-update-doc.mjs <файл> | --all');
      process.exit(2);
    }
    if (!existsSync(p)) {
      console.error(`✖ Файла ${p} нет.`);
      process.exit(2);
    }
    files = [p];
  }

  let total = 0;
  for (const f of files) {
    const problems = checkUpdateDoc(readFileSync(f, 'utf8'), basename(f));
    if (!problems.length) {
      console.log(`✓ ${basename(f)} — форма в порядке`);
      continue;
    }
    total += problems.length;
    console.log(`✖ ${basename(f)} — ${problems.length}:`);
    for (const p of problems) console.log(`    ${p.problem}`);
  }
  process.exit(total ? 1 : 0);
}
