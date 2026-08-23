/**
 * H-07. Что именно сломала правка — и что после неё можно сохранить.
 *
 * C-02 закрыл дыру, через которую маркер переживал смену смысла: теперь
 * любая правка, кроме доказанно форматной, делает маркер недействительным.
 * Это верно и в этом виде неподъёмно. Доказательного долга по корпусу —
 * сотни пунктов; правило «поправил абзац — перепроверяй статью целиком»
 * означает, что править не будут вовсе или будут обходить проверку. Гейт,
 * который дешевле обойти, чем выполнить, не работает.
 *
 * Отсюда разбор по месту правки. Правка касается конкретных абзацев;
 * доказательства относятся к конкретным утверждениям; утверждения имеют
 * позиции в тексте. Значит, можно ответить точнее, чем «всё или ничего»:
 * какие именно утверждения затронуты и что с ними делать.
 *
 * Три исхода, и умолчание среди них — самое строгое:
 *
 *   preserve    — правка форматная, доказательства относятся к тому же
 *                 тексту. Ничего перепроверять не надо.
 *   invalidate  — изменились числа, знак, модальность или субъект.
 *                 Перепроверить затронутые утверждения, остальные живут.
 *   refactcheck — класс правки определить не удалось: абзац дописали,
 *                 удалили, или он изменился до неузнаваемости. Полный
 *                 факчек.
 *
 * Почему `unknown` уходит в полный факчек, а не в «наверное, стиль».
 * Дописанный абзац не с чем сравнивать: в нём может быть новая сумма,
 * новая норма, новое условие — и ни одно из них не будет замечено
 * сравнением с тем, чего раньше не было. Ошибиться здесь в сторону
 * лишней работы дёшево, в другую сторону — это и есть тот случай, ради
 * которого весь контур существует.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { diffParagraphs, body } from '../editor-edits.mjs';
import { articleHash } from './hashes.mjs';

const ROOT = process.env.FACTCHECK_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Строгость класса: чем больше, тем хуже исход. */
const RANK = { style: 0, fact: 1, scope: 2, unknown: 3 };

const DECISION = {
  style: 'preserve',
  fact: 'invalidate',
  scope: 'invalidate',
  unknown: 'refactcheck',
};

const norm = (s) => String(s ?? '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Утверждения реестра, которых коснулась правка.
 *
 * Затронутым считается утверждение, чья цитата встречается в изменённом
 * куске — до правки или после. Обе стороны важны: цитата, исчезнувшая из
 * текста, затронута ровно так же, как переписанная.
 */
function affectedBy(edits, extractionClaims) {
  const touched = new Set();
  const blocks = edits.flatMap((e) => [e.before, e.after]).filter(Boolean).map(norm);
  for (const c of extractionClaims || []) {
    const raw = norm(c.raw);
    if (!raw) continue;
    if (blocks.some((b) => b.includes(raw))) touched.add(String(c.id));
  }
  return [...touched];
}

/**
 * Событие правки: что было, что стало, чего это касается и что делать.
 *
 * @param {object} opts
 * @param {string} opts.before — текст статьи до правки (целиком, с frontmatter).
 * @param {string} opts.after — текст после.
 * @param {object|null} [opts.extraction] — реестр извлечения для привязки.
 * @returns {{beforeHash, afterHash, class, decision, affectedClaimIds, edits, reasons}}
 */
export function impactOf({ before, after, extraction = null }) {
  const beforeHash = articleHash(before);
  const afterHash = articleHash(after);

  if (beforeHash === afterHash) {
    return {
      beforeHash, afterHash, class: 'style', decision: 'preserve',
      affectedClaimIds: [], edits: [], reasons: ['текст не менялся'],
    };
  }

  const edits = diffParagraphs(body(before), body(after));

  /* Правок нет, а хеш другой — значит, изменилось то, чего сравнение
   * абзацев не видит: frontmatter, пробелы, экранирование. Это
   * единственный случай, когда «ничего не нашли» честно означает
   * «менять нечего». */
  if (!edits.length) {
    return {
      beforeHash, afterHash, class: 'style', decision: 'preserve',
      affectedClaimIds: [], edits: [],
      reasons: ['различий по тексту нет — правка в frontmatter или в форматировании'],
    };
  }

  let worst = 'style';
  const reasons = [];
  for (const e of edits) {
    /* Заголовки классу не подлежат: переписанный заголовок меняет
     * обещание раздела, а проверить это сравнением слов нельзя. */
    const cls = e.class ?? (String(e.kind).startsWith('заголовок') ? 'unknown' : 'unknown');
    if (RANK[cls] > RANK[worst]) worst = cls;
    if (e.reasons?.length) reasons.push(`${e.kind}: ${e.reasons.join(', ')}`);
    else if (cls === 'unknown') reasons.push(`${e.kind}: сравнивать не с чем`);
  }

  const affectedClaimIds = affectedBy(edits, extraction?.claims);

  /* Затронутых утверждений не нашлось, а правка смысловая — это не
   * «значит, ничего не сломалось». Это значит, что правка попала в
   * место, которого реестр не знает, и сузить перепроверку не по чему. */
  let decision = DECISION[worst];
  if (decision === 'invalidate' && !affectedClaimIds.length) {
    decision = 'refactcheck';
    reasons.push('правка смысловая, но ни одно утверждение реестра к этому месту не привязано — сузить перепроверку не по чему');
  }

  return { beforeHash, afterHash, class: worst, decision, affectedClaimIds, edits, reasons };
}

/* ── CLI ────────────────────────────────────────────────────────────── */

const readArticle = (slug) => {
  for (const ext of ['.md', '.mdx']) {
    const p = join(ROOT, 'src/content/blog', `${slug}${ext}`);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
};

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--'));
  const i = args.indexOf('--before');
  const beforePath = i === -1 ? null : args[i + 1];

  if (!slug || !beforePath) {
    console.error('Использование: impact.mjs <slug> --before <файл с прежней версией> [--json]');
    process.exit(2);
  }
  const after = readArticle(slug);
  if (after === null) { console.error(`✖ Нет статьи ${slug}`); process.exit(2); }
  if (!existsSync(beforePath)) { console.error(`✖ Нет файла ${beforePath}`); process.exit(2); }

  const exPath = join(ROOT, 'src/data/factcheck/claims', `${slug}.json`);
  let extraction = null;
  if (existsSync(exPath)) {
    try { extraction = JSON.parse(readFileSync(exPath, 'utf8')); } catch { /* реестра нет — сузить не по чему */ }
  }

  const r = impactOf({ before: readFileSync(beforePath, 'utf8'), after, extraction });
  if (args.includes('--json')) {
    console.log(JSON.stringify({
      beforeHash: r.beforeHash, afterHash: r.afterHash,
      class: r.class, decision: r.decision, affectedClaimIds: r.affectedClaimIds,
    }, null, 2));
  } else {
    const WHAT = {
      preserve: 'доказательства относятся к тому же тексту — перепроверять нечего',
      invalidate: 'перепроверить затронутые утверждения, остальные остаются в силе',
      refactcheck: `полный факчек: /factcheck ${slug}`,
    };
    console.log(`${slug}: класс правки «${r.class}» → ${r.decision}`);
    console.log(`  ${WHAT[r.decision]}`);
    if (r.affectedClaimIds.length) console.log(`  затронуто утверждений реестра: ${r.affectedClaimIds.length} — ${r.affectedClaimIds.join(', ')}`);
    for (const why of r.reasons.slice(0, 8)) console.log(`  · ${why}`);
  }
  process.exit(r.decision === 'preserve' ? 0 : 1);
}
