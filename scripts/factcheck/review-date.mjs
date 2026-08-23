/**
 * J-03. Дата проверки — по ближайшему событию, а не единым сроком.
 *
 * Что было. Все десять статей корпуса имели `reviewDate = pubDate + 6
 * месяцев`, ровно, до дня. Для статьи «ТС ПИоТ: кто обязан подключить
 * модуль до 1 октября 2026 года» это означает плановую проверку
 * 9 февраля 2027-го — через четыре месяца после того, как срок из
 * заголовка пройдёт. К моменту проверки материал уже месяцами вводит
 * читателя в заблуждение, и календарь об этом не знает.
 *
 * Единый TTL исходит из предположения, что материалы стареют равномерно.
 * Они стареют событиями: вступает в силу норма, заканчивается
 * переходный период, закрывается временный доступ. Дата такого события
 * известна заранее — она прямо написана в статье и лежит в утверждениях
 * отчёта.
 *
 * Правило: дата проверки — ближайшее из трёх.
 *
 *   1. Ближайшая будущая дата события из утверждений статьи и записей
 *      реестра, которыми она пользуется.
 *   2. `effectiveTo` источника: норма с известной датой окончания
 *      перестаёт действовать в этот день, а не через полгода.
 *   3. `pubDate + TTL` по типу материала — потолок, а не расписание.
 *
 * Даты в прошлом не участвуют: событие, которое уже случилось, не
 * повод проверять статью в прошлом. Если будущих событий нет вовсе,
 * остаётся потолок — и это честный ответ, а не совпадение.
 */

import { normalizeDates } from './check-coverage.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DMY = /(?<!\d)(\d{1,2})\.(\d{2})\.(\d{4})(?!\d)/g;

/**
 * Потолок по типу материала — в месяцах, а не в днях.
 *
 * Правило репозитория звучит как «pubDate + 6 месяцев», и считать его
 * днями значит расходиться с ним на три-четыре дня в зависимости от
 * месяца. Расхождение мелкое и целиком паразитное: оно засоряет отчёт
 * замечаниями там, где никто ничего не нарушал.
 *
 * Правовой обзор стареет быстрее инструкции по интерфейсу, а сравнение
 * тарифов — быстрее обоих; отсюда разные потолки.
 */
export const TTL_MONTHS = {
  legal: 6,
  troubleshooting: 9,
  instruction: 12,
  comparison: 6,
  update: 6,
  default: 6,
};

const toISO = (d) => d.toISOString().slice(0, 10);
const parse = (s) => (ISO.test(String(s)) ? new Date(`${s}T00:00:00Z`) : null);
const addMonths = (iso, n) => {
  const d = parse(iso);
  if (!d) return null;
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + n);
  /* 31 августа + 6 месяцев — это 28 (или 29) февраля, а не 3 марта:
   * перескок через конец месяца сдвинул бы проверку в следующий. */
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return toISO(d);
};

/**
 * Даты, встречающиеся в тексте, — как ISO.
 *
 * И цифрами, и словами: «1 октября 2026 года» в статье пишут чаще, чем
 * «01.10.2026», и не считать такие даты значит не видеть ровно те
 * события, ради которых всё и затевалось. Приведение делает
 * `normalizeDates` из покрытия — тот же разбор, что и там, чтобы
 * «событие» и «значение» не расходились в трактовке.
 */
export function datesIn(text) {
  const out = [];
  for (const m of normalizeDates(String(text ?? '')).matchAll(DMY)) {
    const iso = `${m[3]}-${m[2]}-${String(m[1]).padStart(2, '0')}`;
    if (ISO.test(iso) && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) out.push(iso);
  }
  return out;
}

/**
 * Даты событий, к которым привязана статья.
 *
 * Берём из трёх мест, потому что в трёх местах они и лежат:
 * `effectiveFrom`/`effectiveTo` утверждений отчёта, `effectiveAsOf` и
 * `effectiveTo` доказательств, и записи реестра, которыми статья
 * пользуется. Плюс сам текст — даты в нём написаны прямым текстом, и
 * не считать их значит доверять полноте отчёта больше, чем стоит.
 */
export function eventDates({ articleRaw = '', report = null, facts = [] } = {}) {
  const dates = new Set();
  const add = (d) => { if (ISO.test(String(d ?? ''))) dates.add(d); };

  for (const d of datesIn(articleRaw)) add(d);

  for (const c of report?.claims || []) {
    add(c.effectiveFrom);
    add(c.effectiveTo);
    for (const e of c.evidence || []) { add(e?.effectiveAsOf); add(e?.effectiveTo); }
    for (const d of datesIn(c.statement)) add(d);
  }

  for (const f of facts) {
    add(f?.effectiveFrom);
    add(f?.effectiveTo);
    add(f?.evidence?.effectiveTo);
  }

  return [...dates].sort();
}

/**
 * Плановая дата проверки статьи.
 *
 * @param {object} opts
 * @param {string} opts.pubDate — дата публикации, ISO.
 * @param {string} [opts.articleRaw]
 * @param {object} [opts.report]
 * @param {Array}  [opts.facts] — записи реестра, которыми статья пользуется.
 * @param {string} [opts.contentType] — ключ из TTL_MONTHS.
 * @param {string} [opts.today] — «сегодня», ISO; вынесено ради тестов.
 * @returns {{date: string, reason: string, ceiling: string, event: string|null}}
 */
export function reviewDateFor({
  pubDate, articleRaw = '', report = null, facts = [],
  contentType = 'default', today = new Date().toISOString().slice(0, 10),
} = {}) {
  const ttl = TTL_MONTHS[contentType] ?? TTL_MONTHS.default;
  const ceiling = addMonths(pubDate, ttl) ?? addMonths(today, ttl);

  /* Событие в прошлом проверять не помогает: оно уже случилось, и
   * назначать проверку задним числом бессмысленно. Берём ближайшее из
   * тех, что ещё впереди. */
  const future = eventDates({ articleRaw, report, facts }).filter((d) => d > today);
  const event = future.length ? future[0] : null;

  if (event && event < ceiling) {
    return {
      date: event,
      event,
      ceiling,
      reason: `ближайшее событие ${event} наступит раньше планового срока ${ceiling}`,
    };
  }
  return {
    date: ceiling,
    event,
    ceiling,
    reason: event
      ? `ближайшее событие ${event} позже планового срока — остаётся потолок ${ttl} мес.`
      : `будущих событий в статье нет — плановый срок ${ttl} мес. от публикации`,
  };
}

/**
 * Разошлась ли дата в frontmatter с посчитанной.
 *
 * Расхождение «позже, чем надо» — проблема: статья устареет раньше
 * плановой проверки. Расхождение «раньше» — не проблема: проверить
 * чаще, чем обязывает правило, никто не запрещает.
 */
export function reviewDateProblem(current, computed) {
  if (!ISO.test(String(current ?? ''))) {
    return `reviewDate «${current ?? 'нет'}» не в формате ГГГГ-ММ-ДД`;
  }
  if (current > computed.date) {
    return `reviewDate ${current} позже, чем нужно: ${computed.reason}`;
  }
  return null;
}
