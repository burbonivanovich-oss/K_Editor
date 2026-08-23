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
 * Заголовки разбираются отдельным проходом. Сначала они отсекались вместе
 * с короткими строками, но переписанный заголовок — как раз то, что стоит
 * запомнить: он задаёт, как называть такой раздел в следующих статьях.
 *
 * Скрипт фиксирует разницу, но не понимает её. Смысл правки называет
 * сессия: дописывает под записью строку «**Вывод:**» — что редакция
 * меняет систематически. Команда pending показывает, где вывода ещё нет.
 *
 * Запуск:
 *   node scripts/editor-edits.mjs record --slug <slug> --doc /tmp/<slug>.md
 *   node scripts/editor-edits.mjs record --slug <slug> --doc … --dry-run
 *   node scripts/editor-edits.mjs pending
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { isNegative, modalityOf, subjectsOf } from './factcheck/semantics.mjs';

const ROOT = process.env.EDITS_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOG = join(ROOT, 'src', 'content', 'blog');
const JOURNAL = join(ROOT, 'docs', 'editorial-feedback.md');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
};
const die = (m) => { console.error(`✖ ${m}`); process.exit(1); };

/** Тело без frontmatter: сравниваем текст, а не служебные поля. */
export function body(src) {
  const m = src.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? src.slice(m[0].length) : src;
}

/** Заголовки разделов — отдельно от текста: правка заголовка это правка. */
function headings(text) {
  return (text.match(/^#{2,4} .+$/gm) ?? [])
    .map((h) => h.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Абзацы без markdown-шума, который экспорт Google Docs переставляет.
 * Заголовки сюда не попадают — у них свой проход: строка «## Как войти»
 * и абзац сравниваются по-разному, и мешать их в одну кучу значит
 * потерять и то и другое.
 */
function paragraphs(text) {
  return text
    .split(/\n{2,}/)
    .filter((p) => !/^#{1,6} /.test(p.trim()))
    .filter((p) => !isTable(p))              // таблицы разбираются построчно
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/* H-05. Порога длины больше нет.
 *
 * Раньше здесь стояло `.filter((p) => p.length > 40)` с пометкой
 * «подписи и однострочники не сравниваем». Отбрасывались как раз те
 * блоки, где живут цифры: врезки со штрафом, подписи под таблицами,
 * короткие пункты порядка действий. Замена «10 000 → 100 000» внутри
 * такого блока в журнал не попадала вовсе — правка была, следа не
 * оставалось. Короткий блок сравнить не дороже длинного, а пропустить
 * его дороже на порядок. */

const isTable = (block) => /^\s*\|/.test(block) && /\|\s*$/m.test(block);

/**
 * Строки таблиц — отдельными единицами сравнения.
 *
 * Таблица без пустых строк внутри — один «абзац», и правка одной ячейки
 * выглядела как «абзац изменён» без указания места. Между тем строка
 * таблицы — это обычно целый факт: норма, сумма для ИП, сумма для
 * юрлица. Ключ строки — первая ячейка: по ней строка узнаётся после
 * правки любой из остальных.
 */
function tableRows(text) {
  const rows = [];
  for (const block of text.split(/\n{2,}/)) {
    if (!isTable(block)) continue;
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('|')) continue;
      if (/^\|[\s|:-]+\|$/.test(t)) continue;          // разделитель шапки
      const cells = t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (!cells.length) continue;
      rows.push({ key: cells[0].toLowerCase(), text: t.replace(/\s+/g, ' ') });
    }
  }
  return rows;
}

/* ── Класс правки ───────────────────────────────────────────────────── */

/* Цифры из адресов ссылок — не факты статьи.
 *
 * `cons_doc_LAW_10699`, `cd90f24ea…3f756123` и прочие хвосты URL дают
 * десятки «чисел», которых читатель не видит. Без вычистки замена одной
 * ссылки на другую выглядела бы как правка сумм, а список причин
 * становился нечитаемым. Текст ссылки остаётся: он-то как раз часть
 * статьи. */
const withoutUrls = (t) => String(t ?? '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/`[^`]*`/g, ' ');

const NUMBERS = (t) => (withoutUrls(t).match(/\d[\d\s .,]*\d|\d/g) ?? [])
  .map((x) => x.replace(/[\s ]/g, '').replace(/[.,]$/, ''))
  .filter(Boolean);

/**
 * Что это была за правка: стиль, факт, область применимости или неясно.
 *
 * H-07 использует класс, чтобы решить судьбу доказательств: форматную
 * правку можно пережить, смысловую — нет. Классификация намеренно
 * пессимистична: всё, что не удалось уверенно назвать стилем, называется
 * `unknown` и требует перепроверки. Ошибиться в сторону «перепроверить
 * лишний раз» дёшево; в сторону «сойдёт» — это и есть тот случай, когда
 * маркер переживает смену смысла.
 */
export function classifyEdit(before, after) {
  const a = String(before ?? '');
  const b = String(after ?? '');
  if (!a || !b) return { kind: 'unknown', reasons: ['абзац добавлен или удалён целиком'] };

  const reasons = [];
  const na = NUMBERS(a).join(',');
  const nb = NUMBERS(b).join(',');
  if (na !== nb) reasons.push(`числа: «${na || '—'}» → «${nb || '—'}»`);

  const scope = [];
  if (isNegative(a) !== isNegative(b)) scope.push('отрицание');
  if (modalityOf(a) !== modalityOf(b)) scope.push(`модальность ${modalityOf(a)} → ${modalityOf(b)}`);
  const sa = subjectsOf(a).join('/');
  const sb = subjectsOf(b).join('/');
  if (sa !== sb) scope.push(`субъект «${sa || '—'}» → «${sb || '—'}»`);

  if (scope.length) return { kind: 'scope', reasons: [...scope, ...reasons] };
  if (reasons.length) return { kind: 'fact', reasons };

  /* Ни числа, ни знак, ни модальность, ни субъект не изменились. Это
   * ещё не доказательство, что правка косметическая: сравниваются
   * признаки, а не смысл. Но для журнала правок этого достаточно, а
   * решение о доказательствах принимает не журнал, а safe-diff. */
  return { kind: 'style', reasons: [] };
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
  const edits = [];

  /* Заголовки. Переписанный заголовок — самая частая правка редакции и
   * самая полезная: он задаёт, как называть раздел в следующих статьях.
   * Сравниваем по позиции: разделы идут в одном порядке, а если редактор
   * добавил или убрал раздел, это видно по хвосту списка. */
  const hSrc = headings(before);
  const hDst = headings(after);
  for (let i = 0; i < Math.max(hSrc.length, hDst.length); i++) {
    const b = hSrc[i];
    const a = hDst[i];
    if (b === a) continue;
    if (b && a) edits.push({ kind: 'заголовок', before: b, after: a });
    else if (a) edits.push({ kind: 'заголовок добавлен', before: null, after: a });
    else edits.push({ kind: 'заголовок убран', before: b, after: null });
  }

  /* Строки таблиц — свой проход, по ключу первой ячейки. Правка суммы
   * в строке «Юрлицо» и правка в строке «ИП» — разные факты, и
   * показывать их как «таблица изменилась» бесполезно. */
  const rSrc = new Map(tableRows(before).map((r) => [r.key, r.text]));
  const rDst = new Map(tableRows(after).map((r) => [r.key, r.text]));
  for (const [key, text] of rDst) {
    const was = rSrc.get(key);
    if (was === undefined) { edits.push({ kind: 'строка таблицы добавлена', before: null, after: text }); continue; }
    rSrc.delete(key);
    if (was !== text) edits.push({ kind: 'строка таблицы', before: was, after: text });
  }
  for (const [, text] of rSrc) edits.push({ kind: 'строка таблицы убрана', before: text, after: null });

  const src = paragraphs(before);
  const dst = paragraphs(after);
  const untouched = new Set(src);

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

  /* Класс правки — тем, у кого есть обе половины. Он и есть вход для
   * решения «пережили ли доказательства эту правку». */
  for (const e of edits) {
    if (!e.before || !e.after) continue;
    const { kind, reasons } = classifyEdit(e.before, e.after);
    /* Именно `class`, а не `kind`: `kind` говорит, что случилось с
     * текстом (абзац переписан, строка таблицы поправлена), `class` —
     * что это меняет по существу. Смешать их значит потерять одно из
     * двух. */
    e.class = kind;
    e.reasons = reasons;
  }
  return edits;
}

/* CLI выполняется только при прямом запуске. Без этой проверки импорт
 * diffParagraphs из тестов запускал разбор аргументов и завершал процесс
 * на первой же строке. */
if (isMain(import.meta.url)) {
  const cmd = process.argv[2];

  /* Записи, к которым сессия ещё не приписала вывод.
   *
   * Скрипт видит разницу, но не понимает её. «Было: … Стало: …» — это
   * сырьё; ценность появляется, когда кто-то прочитал пару и назвал
   * причину: убрали пассив, добавили конкретную сумму, сократили лид.
   * Такой вывод пишет сессия рутины B, а команда ниже показывает, где
   * его ещё нет. */
  if (cmd === 'pending') {
    if (!existsSync(JOURNAL)) { console.log('Журнала ещё нет — правок не было.'); process.exit(0); }
    const entries = readFileSync(JOURNAL, 'utf8').split(/^## /m).slice(1);
    const pending = entries.filter((e) => !e.includes('**Вывод:**'));
    if (!pending.length) { console.log('Все записи журнала осмыслены.'); process.exit(0); }
    console.log(`Записей без вывода: ${pending.length}\n`);
    for (const e of pending) {
      const [head, ...rest] = e.split('\n');
      console.log(`## ${head}`);
      console.log(rest.join('\n').trim().slice(0, 600));
      console.log('—'.repeat(60));
    }
    console.log('\nПрочитать пары «было/стало» и дописать под каждой строку:');
    console.log('  **Вывод:** <что редакция систематически меняет>');
    console.log('Повторился один и тот же вывод в третий раз — предложить правило в docs/content-rules.md.');
    process.exit(0);
  }

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

  /* Пометка класса рядом с правкой: журнал читает человек, и «правка
   * фактическая» отличает «поправили цифру» от «переставили слова». */
  const MARK = { fact: ' _(факт)_', scope: ' _(область применимости)_', unknown: ' _(класс неясен)_' };
  const mark = (e) => MARK[e.class] ?? '';

  const date = new Date().toISOString().slice(0, 10);
  const lines = [`\n## ${date} · ${slug}\n`];
  for (const e of edits) {
    if (e.kind === 'заголовок') {
      lines.push(`**Переписали заголовок.**\n\n- Было: ${e.before}\n- Стало: ${e.after}\n`);
    } else if (e.kind === 'заголовок добавлен') {
      lines.push(`**Добавили раздел** «${e.after}».\n`);
    } else if (e.kind === 'заголовок убран') {
      lines.push(`**Убрали раздел** «${e.before}».\n`);
    } else if (e.kind === 'изменён') {
      lines.push(`**Переписали абзац.**${mark(e)}\n\n- Было: ${e.before}\n- Стало: ${e.after}\n`);
    } else if (e.kind === 'строка таблицы') {
      lines.push(`**Поправили строку таблицы.**${mark(e)}\n\n- Было: ${e.before}\n- Стало: ${e.after}\n`);
    } else if (e.kind === 'строка таблицы добавлена') {
      lines.push(`**Дописали строку таблицы.** ${e.after}\n`);
    } else if (e.kind === 'строка таблицы убрана') {
      lines.push(`**Убрали строку таблицы.** ${e.before}\n`);
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
