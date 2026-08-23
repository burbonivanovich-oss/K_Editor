/**
 * Статическая SEO-проверка статьи блога.
 * Использование:
 *   node scripts/check-seo.mjs <файл.md>           # файл
 *   git show ":src/..." | node scripts/check-seo.mjs  # stdin (для git hook)
 * Флаги:
 *   --label=<имя>   имя файла для вывода (при чтении из stdin)
 *   --p1            показывать P1-предупреждения (по умолчанию только P0)
 * Выход: 0 = OK, 1 = есть P0-ошибки.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args  = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);
const SHOW_P1 = flags.p1 === true;

// Чтение контента
let content, label;
if (args[0]) {
  const abs = path.resolve(args[0]);
  content = fs.readFileSync(abs, 'utf8');
  label   = args[0];
} else {
  // stdin — fd 0, не путь '/dev/stdin': путь не всегда открывается, если
  // stdin — анонимный pipe от child_process (а не shell-пайп терминала).
  content = fs.readFileSync(0, 'utf8');
  label   = flags.label ?? '<stdin>';
}

// Парсинг frontmatter
function parseFrontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: { _categories: [], _tags: [], _keywords: [] }, body: src };
  const raw  = m[1];
  const body = m[2];
  const fm   = {};

  // title, description, pubDate, draft
  for (const line of raw.split('\n')) {
    const kv = line.match(/^(\w+):\s*"?([^"#\n]*)"?\s*$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }

  // categories list
  const catMatch = raw.match(/categories:\s*\n((?:\s+-\s+\S+\n?)+)/);
  fm._categories = catMatch
    ? catMatch[1].match(/\S+(?=\n|$)/g)?.filter(s => s !== '-') ?? []
    : [];

  // tags list
  const tagMatch = raw.match(/tags:\s*\n((?:\s+-\s+[^\n]+\n?)+)/);
  fm._tags = tagMatch
    ? tagMatch[1].match(/(?<=-\s)(.+)/g)?.map(s => s.trim()) ?? []
    : [];

  // seo.keywords list
  const kwBlock = raw.match(/seo:\s*\n((?:\s+\S[^\n]*\n?)+)/);
  if (kwBlock) {
    const kwMatch = kwBlock[1].match(/keywords:\s*\n((?:\s+-\s+[^\n]+\n?)+)/);
    fm._keywords = kwMatch
      ? kwMatch[1].match(/(?<=-\s)(.+)/g)?.map(s => s.trim()) ?? []
      : [];
  } else {
    fm._keywords = [];
  }

  return { fm, body };
}

const { fm, body } = parseFrontmatter(content);

const p0 = [];
const p1 = [];

// ── P0 — блокирующие ─────────────────────────────────────────────────────────

if (!fm.title) {
  p0.push('Нет поля title во frontmatter');
} else {
  if (fm.title.length > 75)
    p0.push(`title слишком длинный: ${fm.title.length} симв. (макс. 75) — обрежется в Яндексе и Google`);
  else if (fm.title.length > 65)
    p1.push(`title ${fm.title.length} симв. — может обрезаться в Google (рекомендовано ≤ 65)`);
}

if (!fm.description) {
  p0.push('Нет поля description во frontmatter');
} else {
  if (fm.description.length > 165)
    p0.push(`description слишком длинный: ${fm.description.length} симв. (макс. 165) — обрежется в SERP`);
  if (fm.description.length < 100)
    p0.push(`description слишком короткий: ${fm.description.length} симв. (мин. 100)`);
}

if (fm._categories.length === 0)
  p0.push('Не указана категория (categories)');

if (fm._tags.length < 4)
  p0.push(`Мало тегов: ${fm._tags.length} (норма 4–7)`);

if (fm._keywords.length === 0)
  p0.push('Нет seo.keywords во frontmatter');

// Внутренние ссылки
const internalLinks = (body.match(/\(\/(?:blog|category|tag|slovar|kalkulyator)[^\)]+\)/g) ?? []);
if (internalLinks.length === 0)
  p0.push('Нет ни одной внутренней ссылки (/blog/, /category/, …)');

// Промоблоки: id должен существовать в каталоге. Выдуманный номер ведёт
// в никуда так же, как выдуманный НПА, — а на глаз это не отличить.
const promoIds = [...body.matchAll(/^\[Промоблок:\s*([^\]]+)\]\s*$/gim)].map((m) => m[1].trim());
// От расположения скрипта, а не от cwd: скрипт зовут и из git-хука,
// и из корня, и с произвольным путём к статье.
const CPA_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'cpa-blocks.json',
);

if (promoIds.length && fs.existsSync(CPA_FILE)) {
  const catalog = JSON.parse(fs.readFileSync(CPA_FILE, 'utf8'));
  const byId = new Map((catalog.blocks ?? []).map((b) => [String(b.id), b]));

  const unknown = promoIds.filter((id) => !byId.has(id));
  if (unknown.length)
    p0.push(`Промоблоки не найдены в cpa-blocks.json: ${unknown.join(', ')}`);

  // Блок из чужого кластера — не ошибка формата, но повод посмотреть:
  // читателю предлагают оффер не по теме статьи.
  const articleCluster = fm._categories[0];
  // Ругаться есть смысл, только если выбор был. В каталоге 9 кластеров, и
  // для ts-piot — профильной темы модуля — блоков нет вообще: каждая такая
  // статья получала предупреждение, которое нечем закрыть. Проверка,
  // которую невозможно удовлетворить, учит игнорировать все остальные.
  const clusterHasBlocks = [...byId.values()].some((b) => b.cluster === articleCluster);
  if (articleCluster && clusterHasBlocks) {
    const mismatched = [...new Set(promoIds)]
      .filter((id) => byId.has(id))
      .filter((id) => byId.get(id).cluster && byId.get(id).cluster !== articleCluster);
    if (mismatched.length)
      p1.push(`Промоблоки из другого кластера (статья — ${articleCluster}): ${mismatched.join(', ')}`);
  }

  const dupes = promoIds.filter((id, i) => promoIds.indexOf(id) !== i);
  if (dupes.length)
    p1.push(`Один и тот же промоблок повторяется: ${[...new Set(dupes)].join(', ')}`);
}

/* Промоблоки (F-01): 0–3 по пользе читателю, а не ровно три.
 *
 * Норма «ровно 3» выполнялась в девяти статьях из десяти — включая те,
 * где третьей подводке не было места и она превращалась в общий абзац
 * ради счётчика. Отсутствие промо — законный результат: не в каждой
 * статье есть что предложить. Перебор — по-прежнему повод спросить. */
if (promoIds.length > 3)
  p1.push(`Подводок к промоблокам: ${promoIds.length} — больше трёх, читателю это уже реклама`);

// ── P1 — предупреждения ───────────────────────────────────────────────────────

if (fm.description && fm.description.length < 140)
  p1.push(`description короткий: ${fm.description.length} симв. (рекомендовано 140–165)`);

if (internalLinks.length > 0 && internalLinks.length < 3)
  p1.push(`Мало внутренних ссылок: ${internalLinks.length} (рекомендовано 3+)`);

if (fm._tags.length > 7)
  p1.push(`Много тегов: ${fm._tags.length} (норма 4–7)`);

// Порог совпадает с нижней границей нормы 5–7: раньше здесь стояло 3
// при тексте предупреждения «рекомендовано 5–7».
const h2count = (body.match(/^## /gm) ?? []).length;
if (h2count < 5)
  p1.push(`Мало H2-заголовков: ${h2count} (норма 5–7)`);

/* Целевой ключ в заголовке.
 *
 * Сравнение было подстрочное, и оно почти всегда врало: Wordstat отдаёт
 * ключ в именительном падеже и без дефисов («личный кабинет онлайн
 * кассы»), а заголовок пишется по-человечески («Личный кабинет
 * онлайн-кассы: как войти…»). Из шести статей предупреждение сработало
 * на пяти, и лишь одно из них было настоящим — предупреждение, которое
 * горит всегда, перестают читать вместе с полезными.
 *
 * Теперь сверяем по словам: дефисы разбиваем, служебные слова
 * выбрасываем, словоформы склеиваем по общему началу («касса» и «кассе»,
 * «банк» и «банка»). Показываем, каких слов не хватает, — так понятно,
 * что править. */
const KEY_STOP = new Set(['и', 'в', 'на', 'с', 'по', 'для', 'от', 'до', 'из', 'к',
  'о', 'об', 'у', 'при', 'за', 'что', 'как', 'кто', 'это', 'или', 'а', 'но', 'же',
  'ли', 'год', 'года', 'году']);

function keyWords(text) {
  return String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'.,:;!?()\[\]–—\-/№]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !KEY_STOP.has(w));
}

/** Одно слово в разных падежах — одно слово: сверяем по общему началу. */
function sameWord(a, b) {
  const n = Math.min(4, a.length, b.length);
  return a.slice(0, n) === b.slice(0, n) && Math.abs(a.length - b.length) <= 3;
}

if (fm._keywords.length > 0 && fm.title) {
  const inTitle = keyWords(fm.title);
  const missing = keyWords(fm._keywords[0]).filter((w) => !inTitle.some((t) => sameWord(w, t)));
  if (missing.length)
    p1.push(`Целевой ключ «${fm._keywords[0]}» не отражён в title: нет «${missing.join('», «')}»`);
}

/* FAQ (F-01).
 *
 * Раньше блок был обязателен без исключений — «критичен для нейровыдачи».
 * Требование выполнялось буквально: FAQ появился во всех десяти статьях
 * корпуса, и в большинстве он пересказывает собственные H2. Обязательная
 * секция, которую нечем наполнить, наполняется повтором — и это ухудшает
 * статью, а не улучшает выдачу.
 *
 * Теперь наличие блока не проверяется вовсе: он нужен там, где у
 * читателя правда остаются вопросы, которых нет в тексте. Проверяется
 * другое — что уже существующий FAQ не пустой пересказ. */
/* Заголовок ищем по «FAQ» или «вопрос», но не по «частые»: «## Частые
 * ошибки при работе с кабинетами» — не блок вопросов, а раздел статьи.
 * Берём последнее совпадение: FAQ стоит в конце. */
const faqHeadings = [...body.matchAll(/^#{2,3}[ \t].*(?:FAQ|вопрос).*$/gim)];
const faqHeading = faqHeadings.length ? faqHeadings[faqHeadings.length - 1] : null;
if (faqHeading) {
  const after = body.slice(faqHeading.index + faqHeading[0].length);
  const faqBody = after.split(/^##\s/m)[0];
  const questions = [
    ...faqBody.matchAll(/^\*\*(.+?)\*\*\s*$/gm),
    ...faqBody.matchAll(/^#{3,4}\s+(.+?)\s*$/gm),
  ].map((m) => m[1].trim());

  if (questions.length < 2) {
    p1.push(`FAQ из ${questions.length} вопрос(ов) — либо дополните реальными вопросами, либо уберите блок`);
  } else {
    /* Вопрос, который повторяет заголовок раздела, ответа не добавляет:
     * читатель уже прочитал этот раздел. Сравниваем по значимым словам,
     * а не по строке: «Что такое ТС ПИоТ» и «Что такое ТС ПИоТ простыми
     * словами» — один и тот же вопрос. */
    const h2s = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
    const sig = (t) => new Set(keyWords(t).filter((w) => w.length > 3));

    /* Слова самой темы совпадением не считаются.
     *
     * В статье «Ошибки при работе с ТС ПИоТ» слова «ошибка» и «ПИоТ»
     * стоят в каждом втором H2 и в каждом вопросе — по построению, а не
     * от повтора. Правило ловило на них «Ошибка ТС ПИоТ и ошибка ОФД —
     * одно и то же?»: вопрос про разницу двух контуров, которого в
     * тексте нет нигде. Наказывать статью за то, что она про свою тему,
     * — тот же род ошибки, что требовать цитировать норму пересказом.
     *
     * Тематическим считаем слово, которое встречается больше чем в
     * половине заголовков. Совпадение только по таким словам сигнала не
     * несёт; чтобы вопрос считался повтором, пересечение должно
     * содержать хотя бы одно слово помимо темы. */
    const topic = new Set();
    if (h2s.length >= 3) {
      const freq = new Map();
      for (const h of h2s) for (const w of sig(h)) {
        const key = [...freq.keys()].find((k) => sameWord(k, w)) ?? w;
        freq.set(key, (freq.get(key) ?? 0) + 1);
      }
      for (const [w, n] of freq) if (n > h2s.length / 2) topic.add(w);
    }
    const isTopic = (w) => [...topic].some((t) => sameWord(t, w));

    const repeats = questions.filter((q) => {
      const qw = sig(q);
      if (qw.size < 2) return false;
      return h2s.some((h) => {
        const hw = sig(h);
        if (!hw.size) return false;
        const shared = [...qw].filter((w) => [...hw].some((x) => sameWord(w, x)));
        if (!shared.some((w) => !isTopic(w))) return false;
        return shared.length / Math.min(qw.size, hw.size) >= 0.6;
      });
    });
    if (repeats.length && repeats.length / questions.length >= 0.5) {
      p1.push(`FAQ пересказывает собственные H2 (${repeats.length} из ${questions.length}): «${repeats[0]}»`);
    }
  }
}

// ── Вывод ─────────────────────────────────────────────────────────────────────

const hasP0 = p0.length > 0;
const hasP1 = p1.length > 0;

if (!hasP0 && (!SHOW_P1 || !hasP1)) {
  console.log(`SEO OK: ${label}`);
  process.exit(0);
}

console.log(`\nSEO-проверка: ${label}`);
console.log('─'.repeat(60));

if (hasP0) {
  console.log(`\nP0 — блокирующие (${p0.length}):`);
  for (const e of p0) console.log(`  ✗ ${e}`);
}

if (SHOW_P1 && hasP1) {
  console.log(`\nP1 — предупреждения (${p1.length}):`);
  for (const w of p1) console.log(`  ⚠ ${w}`);
}

console.log('');
process.exit(hasP0 ? 1 : 0);
