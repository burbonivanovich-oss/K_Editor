#!/usr/bin/env node
/**
 * Каждое значение статьи разобрано факчеком — и разобрано целиком.
 *
 * Сверка отвечает на вопрос, которого не задаёт проверка отчёта:
 * доказанность разобранного — половина дела, вторая — не осталось ли в
 * статье значений, которых в отчёте нет вовсе. Отсутствующее следа не
 * оставляет: 38 утверждений, все подтверждены, а норма, о которой не
 * вспомнили, нигде не видна (ст. 15.12.1 КоАП РФ, 13.08.2026).
 *
 * Что изменилось в D-01. Раньше сверка склеивала все claims в одну
 * строку и считала значение покрытым, если где-нибудь совпало хотя бы
 * одно числовое ядро. Совпасть можно было с посторонней датой или с
 * другой нормой — связи «это значение разбирал вот этот claim» не
 * существовало. Теперь каждое значение сопоставляется с КОНКРЕТНЫМ
 * утверждением, у значения есть позиция в тексте, а у ссылки на норму и
 * у диапазона проверяются все элементы, а не один.
 *
 * Три исхода вместо двух:
 *   covered — значение разобрано целиком;
 *   partial — утверждение про это значение есть, но часть не
 *             подтверждена (в статье «ч. 2 ст. 14.5», в отчёте только
 *             «ст. 14.5»: у частей разные санкции);
 *   missing — про значение в отчёте нет ничего.
 *
 * Разделение важно: «не разбирали вовсе» и «разобрали не до конца» —
 * разная работа, и объединять их в одну красную строку значит получить
 * сверку, которую выключат.
 *
 * Запуск:
 *   node scripts/factcheck/check-coverage.mjs <slug> [--json]
 *   node scripts/factcheck/check-coverage.mjs --all
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { semanticsMatch, sentenceAt, foreignStatement } from './semantics.mjs';

const ROOT = process.env.FACTCHECK_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLOG = join(ROOT, 'src/content/blog');
const RESULTS = join(ROOT, 'src/data/factcheck/results');

/* ── 1. Что в статье считается значением ───────────────────────────── */

/**
 * Текст статьи, где всё «не значение» заменено пробелами.
 *
 * Именно заменено, а не вырезано: длина сохраняется, и позиция значения
 * в маске — это его позиция в файле. Без этого «спан» указывал бы в
 * никуда, а вся связка «место в статье → утверждение → доказательство»
 * держится на том, что место настоящее.
 */
export function mask(raw) {
  /* Переводы строк сохраняем: по ним считается номер строки, а он и есть
   * половина ценности спана — «строка 42» находится глазами, смещение в
   * символах нет. */
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  let t = String(raw);
  t = t.replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*/, blank);   // frontmatter
  t = t.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (m, anchor) => `${' '.repeat(m.length - anchor.length - 1)}${anchor} `.slice(0, m.length));
  t = t.replace(/\[(Промоблок|Врезка)[^\]]*\]/gi, blank);    // служебные маркеры
  t = t.replace(/^\s*\d+[.)]\s+/gm, blank);                  // нумерация списков
  t = t.replace(/^#{1,6}\s+/gm, blank);                      // заголовки
  t = t.replace(/`[^`]*`/g, blank);                          // код
  return t;
}

/** Совместимость с прежним API: та же вычистка, длина сохраняется. */
export const strip = mask;

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[йя]', 'июн', 'июл',
  'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

/**
 * «1 октября 2026» и «01.10.2026» — одна дата и должны давать один ключ.
 * Без этого статья, где дата написана словами, а отчёт — цифрами, вечно
 * числится непроверенной, и сверку выключают.
 */
export function normalizeDates(text) {
  let out = String(text ?? '');
  MONTHS.forEach((m, i) => {
    const re = new RegExp(`(\\d{1,2})\\s+${m}\\p{L}*\\s+(\\d{4})`, 'giu');
    out = out.replace(re, (_, d, y) => `${String(d).padStart(2, '0')}.${String(i + 1).padStart(2, '0')}.${y}`);
  });
  return out;
}

/**
 * Значимые числовые «ядра» строки. Оставлено для совместимости и для
 * грубых сверок; точное сопоставление ниже работает не на них, а на
 * типизированных ядрах значения.
 */
export function significantKeys(text) {
  const runs = normalizeDates(text).match(/\d{1,3}(?:[\s ]\d{3})+|\d+(?:[.,]\d+)+|\d+/g) || [];
  return new Set(runs.map((r) => r.replace(/[\s .,]/g, '')).filter((r) => r.length >= 2));
}

const squashDigits = (s) => s.replace(/(\d)[\s ](?=\d{3}\b)/g, '$1');

/**
 * Текст в виде, пригодном для точного сравнения.
 *
 * Нормализуются ровно те записи, которые в русском тексте означают одно
 * и то же: «часть 2» / «ч. 2» / «ч.2», «статья 14.5» / «ст. 14.5»,
 * «10 000» / «10000», «22 процента» / «22 %», даты словами и цифрами.
 */
export function normalizeForMatch(text) {
  /* Границы слова здесь не \b, а (?<!\p{L}): \b в JS считает словом
   * только ASCII, поэтому «ст.» в начале строки под \bст не подпадало
   * вовсе — и «ст. 14.5» из отчёта не сходилось с «ст.14.5» из статьи.
   * Ровно этот класс ошибок и делает сверку тихо бесполезной. */
  const B = '(?<!\\p{L})';
  const rules = [
    [`${B}част(?:ь|и|ью|ей|ям|ями)\\s*`, 'ч.'],
    [`${B}ч\\s*\\.\\s*`, 'ч.'],
    [`${B}стат(?:ья|ьи|ье|ьёй|ей|ьями)\\s*`, 'ст.'],
    [`${B}ст\\s*\\.\\s*`, 'ст.'],
    [`${B}подпункт(?:а|е|ом|ов|ы)?\\s*`, 'пп.'],
    [`${B}пп\\s*\\.\\s*`, 'пп.'],
    [`${B}пункт(?:а|е|ом|ов|ы)?\\s*`, 'п.'],
    [`${B}п\\s*\\.\\s*`, 'п.'],
    [`${B}процент\\p{L}*`, '%'],
  ];

  let t = normalizeDates(String(text ?? '').toLowerCase());
  t = t.replace(/[\u00A0\u202F]/g, ' ');
  t = squashDigits(t);
  for (const [re, to] of rules) t = t.replace(new RegExp(re, 'gu'), to);
  t = t.replace(/\s*%/g, '%');
  /* Диапазон в отчёте раскрываем в границы: «25–50%» подтверждает и
   * «25%», и «50%» из статьи. Обратное неверно — граница диапазона не
   * подтверждает весь диапазон, — но для покрытия важно именно
   * направление «значение статьи разобрано». */
  t = t.replace(/(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)%/g, '$1% $2% $1-$2%');
  t = t.replace(/№\s*/g, '№');
  t = t.replace(/\s+/g, ' ');
  return t;
}

/** Ядро найдено в тексте как самостоятельное значение, а не внутри числа. */
function hasCore(normText, core) {
  const esc = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const numeric = /^[\d.]+$/.test(core);
  /* Точка после числа — конец предложения, а не часть числа.
   *
   * Прежний хвост `(?![\d.,])` отвергал совпадение, если сразу за
   * значением стояла точка: «опубликован 27.06.2025.» не подтверждал
   * «27.06.2025», и дата числилась неразобранной. Ловилось это только
   * на утверждениях, которые заканчиваются датой, — то есть на
   * аккуратно написанных. Значащая точка — только та, за которой идёт
   * цифра: «14.5» внутри «114.55». */
  const re = numeric
    ? new RegExp(`(?<![\\d.,])${esc}(?![\\d,])(?!\\.\\d)`)
    : new RegExp(esc);
  return re.test(normText);
}

/* Классы значений. Каждый — про решение читателя: сколько заплатит, по
 * какой норме, до какого числа, что настраивать. */
const PATTERNS = [
  // Диапазон сумм: обе границы, а не только та, что ближе к «₽».
  {
    kind: 'money-range',
    re: /(?:от\s*)?(\d[\d\s ]*)\s*(?:до|[-–—])\s*(\d[\d\s ]*)\s*(?:₽|руб(?:лей|ля|\.)?|тыс(?:яч)?|млн)/gi,
    cores: (m) => [m[1], m[2]].map((x) => x.replace(/[\s ]/g, '')),
  },
  { kind: 'money', re: /\d[\d\s ]*(?:\s?₽|\s+(?:руб(?:лей|ля|\.)?|тыс(?:яч)?|млн))/gi,
    cores: (m) => [m[0].replace(/[^\d]/g, '')] },
  // Доли: «1/4», «3/4» — терялись целиком.
  /* Дробь, но не номер версии. «ФФД 1.1/1.2» — это два формата через
   * косую черту, а не одна вторая: правило читало из них дробь «1/1»
   * и требовало разобрать значение, которого в тексте нет. Отсекаем по
   * контексту: перед дробью стоит слово с точкой в номере либо сама
   * дробь состоит из версий вида «1.1». */
  { kind: 'fraction', re: /(?<![\d.])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d.])/g, cores: (m) => [`${m[1]}/${m[2]}`] },
  // Диапазон процентов и одиночный процент.
  { kind: 'percent-range', re: /(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)\s*%/g,
    cores: (m) => [`${m[1]}%`, `${m[2]}%`] },
  { kind: 'percent', re: /\b(\d+(?:[.,]\d+)?)\s*%/g, cores: (m) => [`${m[1]}%`] },
  // Ссылка на норму: часть и статья — разные элементы, у частей разные санкции.
  {
    kind: 'npa',
    re: /(?:(?:ч(?:асть|\.)\s*(\d+)\s*)|(?:п(?:ункт|\.)\s*(\d+)\s*))?ст(?:атья|\.)\s*(\d+(?:\.\d+)?)/gi,
    cores: (m) => [
      `ст.${m[3]}`,
      ...(m[1] ? [`ч.${m[1]}`] : []),
      ...(m[2] ? [`п.${m[2]}`] : []),
    ],
  },
  { kind: 'npa', re: /№\s*(\d{2,})|\b(\d{2,3})-ФЗ\b/gi,
    cores: (m) => [m[1] ? `№${m[1]}` : `${m[2]}-фз`] },
  { kind: 'date', re: /\b\d{1,2}\.\d{2}\.\d{4}\b/g, cores: (m) => [m[0]] },
  {
    kind: 'date',
    re: /\b\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\p{L}*\s+\d{4}/giu,
    cores: (m) => [normalizeDates(m[0]).match(/\d{2}\.\d{2}\.\d{4}/)?.[0] ?? m[0]],
  },
  /* Длительности. Класса не было вовсе, и «Накопитель на 36 месяцев
   * блокируется досрочно… или услуги» не видел никто: ни один шаблон
   * не считал «36 месяцев» значением, а в отчёте про этот факт не было
   * ни одного утверждения. Ошибка операционная и денежная — читатель
   * покупает не тот накопитель. */
  {
    kind: 'duration',
    /* До трёх цифр: длительностей вроде «2026 лет» не бывает, а вот
     * «2026 года» из даты под этот шаблон подпадало и превращало
     * хвост даты в отдельное значение. */
    re: /(?<![\d.,])(\d{1,3}(?:[.,]\d+)?)\s*(секунд\p{L}*|минут\p{L}*|час\p{L}*|(?:рабочих\s+|календарных\s+)?дн\p{L}*|сут\p{L}*|недел\p{L}*|месяц\p{L}*|год\p{L}*|лет)(?!\p{L})/giu,
    /* Единицу режем до основы: «72 часа» в статье и «72 часов» в
     * утверждении — одно и то же значение, и требовать совпадения
     * падежа значит объявлять честный разбор неполным. */
    cores: (m) => [`${m[1]} ${durationUnit(m[2])}`, m[1]],
  },
  { kind: 'tech', re: /(?:тег|реквизит|код(?:а|ы)?)\s*№?\s*(\d{3,})/gi, cores: (m) => [`тег ${m[1]}`, m[1]] },
  { kind: 'tech', re: /\bФФД\s*(\d\.\d)\b/gi, cores: (m) => [`ффд ${m[1]}`, m[1]] },
];

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/* Единица длительности к канону.
 *
 * «72 часа» в статье и «72 часов» в утверждении — одно значение.
 * Обрезать по числу букв не выходит: «дня» и «дней» расходятся уже на
 * третьей. Поэтому список приставок, а не эвристика. */
const DURATION_UNITS = [
  [/^секунд/, 'сек'], [/^минут/, 'мин'], [/^час/, 'час'],
  [/^(дн|дне|дня|дней|день)/, 'дн'], [/^сут/, 'сут'],
  [/^недел/, 'нед'], [/^месяц/, 'мес'], [/^(год|лет|года)/, 'год'],
];
const durationUnit = (raw) => {
  const u = String(raw).toLowerCase().replace(/^(рабочих|календарных)\s+/, '');
  return (DURATION_UNITS.find(([re]) => re.test(u)) ?? [null, u])[1];
};

/**
 * Значения статьи с позициями.
 *
 * Одно значение — одна запись, даже если встречается несколько раз: у
 * записи список спанов. Повторное упоминание той же суммы не отдельная
 * работа для факчека, но знать все места полезно при правке.
 */
export function extractValues(maskedText) {
  const out = [];
  const claimed = [];
  for (const { kind, re, cores } of PATTERNS) {
    for (const m of maskedText.matchAll(re)) {
      const list = cores(m).filter(Boolean);
      if (!list.length) continue;
      const text = m[0].trim().replace(/\s+/g, ' ');
      const span = { start: m.index, end: m.index + m[0].length, line: lineOf(maskedText, m.index) };
      /* Более общий шаблон не должен перебивать более точный: «ст. 14.5»
       * внутри уже разобранного «ч. 2 ст. 14.5» и «30 000 ₽» внутри
       * диапазона «от 10 000 до 30 000 ₽» — те же самые места, и
       * считать их отдельными значениями значит требовать от факчека
       * разобрать одно и то же дважды. */
      /* Пересечение, а не вложенность: «1 октября 2026» и «2026 года»
       * друг в друга не вложены, но это одно место текста, и
       * считать их двумя значениями значит требовать разобрать
       * хвост даты отдельно. */
      if (claimed.some((sp) => sp.start < span.end && span.start < sp.end)) continue;
      claimed.push(span);
      out.push({ kind, text, cores: list, keys: significantKeys(text), spans: [span] });
    }
  }
  /* H-04. Ключ значения — спан, а не число.
   *
   * Раньше записи схлопывались по ключу `вид:ядра`: два вхождения
   * «10 000 ₽» в разных абзацах становились одной записью со списком
   * спанов, и одно утверждение отчёта закрывало оба. На инъекции
   * аудита это означало, что «обязана заплатить 10 000 ₽» и «не
   * обязана платить 10 000 ₽» проходят одинаково: число одно, значит
   * «факт один».
   *
   * Число — не факт. Факт — это число в конкретном месте с конкретным
   * предикатом, и разбирать каждое место надо отдельно. */
  out.sort((a, b) => a.spans[0].start - b.spans[0].start);
  return out;
}

/** Всё, что факчек вообще разбирал, одной строкой для поиска. */
export function claimsHaystack(report) {
  return (report.claims || [])
    .map((c) => claimText(c))
    .join('  ');
}

/** Текст одного утверждения — вместе с доказательствами. */
function claimText(c) {
  const evidence = (c.evidence || []).map((e) => [e?.locator, e?.quote].filter(Boolean).join(' ')).join(' ');
  return [c.raw, c.statement, c.expectedValue, c.quote, c.explanation, evidence].filter(Boolean).join(' ');
}

/* ── 2. Значение → утверждение ─────────────────────────────────────── */

/**
 * @param {string} articleRaw
 * @param {object} report
 * @returns {{total, covered, missing, partial, links}}
 *   links — связка «спан в статье → id утверждения», ради которой всё и
 *   затевалось: по ней видно, кто именно проверял это место.
 */
export function checkCoverage(articleRaw, report) {
  const masked = mask(articleRaw);
  const values = extractValues(masked);
  const claims = (report?.claims || []).map((c, i) => ({
    id: c.id || `#${i + 1}`,
    norm: normalizeForMatch(claimText(c)),
    statement: c.statement,
    /* Текст для сверки знака, модальности и субъекта.
     *
     * Нормализованный не годится: `normalizeForMatch` приводит текст к
     * сравнимым числам, а «не» и «обязан» ей безразличны. И `raw` не
     * годится: это сам токен, предиката в нём нет — окно вокруг него
     * пустое, и сравнение выродилось бы в «утверждение молчит, значит
     * противоречит». Сверяем формулировку. */
    text: [c.statement, c.expectedValue, c.explanation].filter(Boolean).join('. '),
  }));

  const missing = [];
  const partial = [];
  const conflicting = [];
  const suspicious = [];
  const links = [];

  for (const v of values) {
    const cores = v.cores.map((c) => normalizeForMatch(c).trim());
    /* Утверждение считается «про это значение», если подтверждает хотя
     * бы один его элемент: статью без части, верхнюю границу диапазона
     * без нижней. Это ещё не покрытие — но и не «не разбирали»: разница
     * между «никто не смотрел» и «посмотрели не всё» стоит того, чтобы
     * её сохранить. */
    const candidates = claims.filter((c) => cores.some((core) => hasCore(c.norm, core)));

    if (!candidates.length) {
      missing.push({ ...v, reason: 'в отчёте нет утверждения про это значение' });
      continue;
    }

    /* H-04. Совпадение числа — ещё не подтверждение.
     *
     * Утверждение считается «про это место», только если сходится и по
     * смыслу: знак (отрицание), модальность (обязан против вправе) и
     * названный субъект. Без этой проверки дата «1 сентября 2025» в
     * статье про разрешительный режим считалась разобранной
     * утверждением про регистрацию ККТ через Госуслуги — потому что
     * дата в нём та же. */
    const sentence = sentenceAt(masked, v.spans[0].start, v.spans[0].end);
    const agrees = (c) => {
      const r = semanticsMatch(sentence, c.text, v.text);
      /* Отдельный признак поверх знака, модальности и субъекта:
       * утверждение может не расходиться ни по одному из них и всё
       * равно быть написано не про эту статью. Ровно так выглядело
       * загрязнение в опубликованном разрешительном режиме — дата та
       * же, а речь про регистрацию ККТ через Госуслуги. */
      const foreign = c.statement ? foreignStatement(masked, c.statement) : { foreign: false, ratio: null };
      /* Полоса «похоже, но не наверняка»: 0.4…0.55. Блокировать по ней
       * нельзя — там живут честные утверждения языком нормы, — но и
       * молчать не стоит: человеку показывают, что утверждение и статья
       * говорят на разных языках, а решает он. */
      if (!foreign.foreign) {
        const near = foreign.ratio !== null && foreign.ratio < 0.55;
        return near && r.ok
          ? { ok: true, reasons: [], suspicion: `формулировка мало пересекается со статьёй: из ${foreign.stems} значимых слов нашлось ${foreign.hits}` }
          : r;
      }
      /* Лексический признак сам по себе приговором не служит.
       *
       * На корпусе с настоящими формулировками он дал две ошибки из
       * пятнадцати: утверждение, написанное языком нормы
       * («немаркированных продовольственных товаров»), законно
       * расходится со словами статьи. Блокировать по нему значит
       * наказывать за точную цитату закона.
       *
       * Поэтому он добавляется к расхождению, когда расхождение уже
       * есть, и остаётся пометкой, когда его нет: подозрение видно,
       * а решение принимает человек. */
      /* Ниже порога — расхождение, и оно блокирует. Знак, модальность и
       * субъект здесь ничего не видят: утверждение не спорит со статьёй,
       * оно про другое. Кроме лексики опереться не на что. */
      const note = `формулировка написана не про эту статью: из ${foreign.stems} значимых слов в тексте нашлось ${foreign.hits}`;
      return { ok: false, reasons: [...r.reasons, note] };
    };

    const full = candidates.find((c) => cores.every((core) => hasCore(c.norm, core)) && agrees(c).ok);
    if (full) {
      const s = agrees(full).suspicion;
      if (s) suspicious.push({ ...v, claimId: full.id, reason: s });
      links.push({ value: v.text, kind: v.kind, spans: v.spans, claimId: full.id });
      continue;
    }

    /* Значение разобрано целиком, но утверждение говорит про место
     * другое. Это не «разобрано не полностью» — это противоречие, и
     * отдельный исход у него потому, что чинится оно иначе: не дописать
     * недостающее, а разобраться, к чему относится утверждение. */
    const covered = candidates.filter((c) => cores.every((core) => hasCore(c.norm, core)));
    if (covered.length) {
      const why = covered.map((c) => `${c.id}: ${agrees(c).reasons.join('; ')}`).join(' | ');
      conflicting.push({
        ...v,
        claimIds: covered.map((c) => c.id),
        sentence,
        reason: `значение разобрано, но утверждение расходится по смыслу — ${why}`,
      });
      continue;
    }

    const notConfirmed = cores.filter((core) => !candidates.some((c) => hasCore(c.norm, core)));
    partial.push({
      ...v,
      claimIds: candidates.map((c) => c.id),
      unconfirmed: notConfirmed,
      reason: `утверждение есть (${candidates.map((c) => c.id).join(', ')}), но не подтверждено: ${notConfirmed.join(', ')}`,
    });
    links.push({ value: v.text, kind: v.kind, spans: v.spans, claimId: candidates[0].id, partial: true });
  }

  return {
    total: values.length,
    covered: values.length - missing.length - partial.length - conflicting.length,
    missing, partial, conflicting, suspicious, links,
  };
}

function readArticle(slug) {
  for (const ext of ['.md', '.mdx']) {
    const p = join(BLOG, slug + ext);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const slugs = all
    ? (existsSync(BLOG) ? readdirSync(BLOG).filter((f) => /\.mdx?$/.test(f)).map((f) => f.replace(/\.mdx?$/, '')) : [])
    : [args.find((a) => !a.startsWith('--'))].filter(Boolean);

  if (!slugs.length) {
    console.error('Использование: check-coverage.mjs <slug> [--json] | --all');
    process.exit(2);
  }

  let bad = 0;
  const out = [];
  for (const slug of slugs) {
    const raw = readArticle(slug);
    if (raw === null) { console.error(`✖ Нет статьи ${slug}`); bad++; continue; }
    const reportPath = join(RESULTS, `${slug}.json`);
    if (!existsSync(reportPath)) { console.error(`✖ Нет отчёта для ${slug}`); bad++; continue; }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const r = checkCoverage(raw, report);
    out.push({ slug, ...r });
    if (r.missing.length || r.partial.length || r.conflicting.length) bad++;
    if (args.includes('--json')) continue;
    const head = `${slug}: значений ${r.total}, разобрано ${r.covered}`;
    if (!r.missing.length && !r.partial.length && !r.conflicting.length) { console.log(`✓ ${head}`); continue; }
    console.log(`✖ ${head}, не разобрано ${r.missing.length}, частично ${r.partial.length}, противоречий ${r.conflicting.length}`);
    for (const m of r.missing.slice(0, 10)) console.log(`    [${m.kind}] ${m.text} (строка ${m.spans[0].line}) — ${m.reason}`);
    for (const p of r.partial.slice(0, 10)) console.log(`    [${p.kind}] ${p.text} (строка ${p.spans[0].line}) — ${p.reason}`);
    for (const c of r.conflicting.slice(0, 10)) console.log(`    ! [${c.kind}] ${c.text} (строка ${c.spans[0].line}) — ${c.reason}`);
  }
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
  process.exit(bad ? 1 : 0);
}
