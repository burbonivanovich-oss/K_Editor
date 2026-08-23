/**
 * K-02. Классификация единиц текста: ни одного неразобранного предложения.
 *
 * Зачем ещё один слой поверх покрытия. Покрытие отвечает на вопрос «все
 * ли значения статьи разобраны» — и отвечает честно, но вопрос узкий:
 * значение это число, дата или номер нормы. Утверждение без числа
 * покрытию невидимо. «Накопитель на 36 месяцев блокируется досрочно,
 * если через кассу проходят услуги» держится на слове «блокируется», а
 * не на числе; «единого справочника кодов нет» вообще не содержит
 * значений. Оба — операционные факты, оба были неверны, и оба прошли.
 *
 * Разрыв виден в цифрах: 420 извлечённых утверждений против 303 в
 * отчётах. Но и 420 — не полнота: regex ищет значения, а не утверждения,
 * и сколько предложений не попало в извлечение вовсе, по этим числам не
 * узнать. Отсутствующее не оставляет следа — ровно поэтому его и не
 * видно.
 *
 * Отсюда обратный ход: не «найти всё, что стоит проверить», а «разобрать
 * весь текст и объяснить про каждую единицу, почему её не проверяют».
 * Классов три:
 *
 *   factual     — проверяемый факт: должен быть связан с утверждением;
 *   actionable  — указание к действию: тоже должен;
 *   non_factual — переход, мнение, оформление. Требует причины: «почему
 *                 не факт» — это решение, а не умолчание.
 *
 * Устройство id такое же, как у извлечения (H-01): из текста и номера
 * повторения, а не из позиции. Дописали абзац — решения по остальным
 * единицам остались в силе. Иначе классификация протухала бы от любой
 * правки, и её перестали бы делать.
 */
import { createHash } from 'node:crypto';

export const UNIT_CLASSES = ['factual', 'actionable', 'non_factual'];

/* Нормализация та же, что у смыслового отпечатка статьи.
 *
 * Иначе классификация протухает от косметики: экспорт из Google Docs
 * добавляет экранирование и неразрывные пробелы, текст единицы меняется,
 * меняется её id — и решения по всему тексту оказываются «про единицы,
 * которых в статье нет». Косметическая правка обязана сохранять и
 * доказательства, и классификацию: это одно и то же обещание. */
const norm = (s) => String(s ?? '')
  .replace(/\\([[\]().\-*_#])/g, '$1')          // экранирование из Docs
  .replace(/[   ]/g, ' ')       // неразрывные пробелы
  .replace(/[‐-―−]/g, '-')      // тире всех видов
  .replace(/[«»“”„‟"']/g, '"')                 // кавычки всех видов
  .replace(/[…]/g, '...')
  .replace(/\s+/g, ' ')
  .trim();

/* Хвостовые пробелы после `---` бывают в экспорте из Google Docs.
 * Без терпимости к ним frontmatter не находится вовсе, и служебные
 * поля попадают в текст как обычные единицы — «не классифицировано:
 * строка 2: title». Та же терпимость, что у normalizeArticle. */
/** Тело без frontmatter. */
export const body = (src) => {
  const m = String(src).match(/^---[ \t]*\n[\s\S]*?\n---[ \t]*\n?/);
  return m ? src.slice(m[0].length) : src;
};

const unitId = (kind, text, occurrence) => {
  const h = createHash('sha1').update(`${kind}|${norm(text).toLowerCase()}|${occurrence}`).digest('hex');
  return `u${h.slice(0, 8)}`;
};

/* Служебные строки разметки: их классифицировать не за что. Промоблок и
 * врезка — маркеры для вёрстки, разделитель таблицы — синтаксис. */
const SERVICE = /^\s*(\[(?:Промоблок|Врезка)[^\]]*\]|\|[\s|:-]+\||-{3,}|\s*)\s*$/i;

/**
 * Единицы текста статьи.
 *
 * Предложение, строка таблицы, пункт списка, заголовок и подпись — всё,
 * что читатель воспринимает как отдельное утверждение. Границы
 * предложений — по точке с пробелом; сокращения вроде «ст.» и «п.»
 * исключены явно, иначе каждая ссылка на норму рвала бы предложение
 * пополам и классифицировать пришлось бы обрывки.
 */
export function textUnits(raw) {
  const text = body(String(raw ?? ''));
  const units = [];
  const seen = new Map();
  const push = (kind, t, line) => {
    const clean = norm(t);
    if (!clean || SERVICE.test(clean)) return;
    const key = `${kind}|${clean.toLowerCase()}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    units.push({ id: unitId(kind, clean, n), kind, text: clean, line });
  };

  let line = 0;
  for (const rawLine of text.split('\n')) {
    line += 1;
    const t = rawLine.trim();
    if (!t) continue;

    if (/^#{1,6}\s+/.test(t)) { push('heading', t.replace(/^#{1,6}\s+/, ''), line); continue; }
    if (/^\s*\|/.test(t)) { push('table-row', t, line); continue; }

    const listItem = t.match(/^(?:[-*]|\d+[.)])\s+(.*)$/);
    /* Нормализуем до разбиения, а не после.
     *
     * Экспорт из Docs экранирует точки: «ч\. 2 ст\. 14.5». Список
     * сокращений в `splitSentences` про обратный слеш не знает, фраза
     * рвалась на «Штраф по ч\.» и «2 ст\. 14.5», и косметическая правка
     * меняла разбиение всего абзаца. */
    const content = norm(listItem ? listItem[1] : t);
    const kind = listItem ? 'list-item' : 'sentence';

    for (const s of splitSentences(content)) push(kind, s, line);
  }
  return units;
}

/**
 * Разбиение на предложения.
 *
 * Точка после «ст», «п», «пп», «ч», «г», «руб», «тыс», «млн» и после
 * одиночной цифры — не конец предложения. Без этих исключений «ч. 2
 * ст. 14.5 КоАП РФ» распадается на четыре обрывка, и классифицировать
 * становится нечего.
 */
export function splitSentences(text) {
  const ABBR = /(?:^|\s)(?:ст|п|пп|ч|абз|г|гг|руб|тыс|млн|млрд|им|см|стр|рис|табл|№)$/i;
  const out = [];
  let start = 0;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    if (!'.!?'.includes(s[i])) continue;
    const next = s[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    const head = s.slice(start, i);
    if (ABBR.test(head)) continue;
    if (/\d$/.test(head) && /^\s*\d/.test(s.slice(i + 1))) continue;  // «14.5»
    out.push(s.slice(start, i + 1));
    start = i + 1;
  }
  const tail = s.slice(start);
  if (norm(tail)) out.push(tail);
  return out.map(norm).filter(Boolean);
}

/**
 * Замкнутость классификации.
 *
 * @param {string} raw — текст статьи целиком.
 * @param {object} report — отчёт факчека; классы лежат в `report.units`.
 * @returns {Array<{id, problem}>}
 */
export function checkClassification(raw, report) {
  const problems = [];
  const add = (id, problem) => problems.push({ id, problem });

  const units = textUnits(raw);
  const byId = new Map(units.map((u) => [u.id, u]));
  const table = report?.units && typeof report.units === 'object' ? report.units : {};
  const claimed = new Set(
    (report?.claims || []).flatMap((c) => (Array.isArray(c.span) ? c.span : [c.span]))
      .filter(Boolean).map(String),
  );

  for (const [id, decision] of Object.entries(table)) {
    if (!byId.has(id)) add(id, 'решение по единице текста, которой в статье нет — текст правили после классификации');
  }

  const unclassified = [];
  for (const u of units) {
    const d = table[u.id];
    if (d === undefined) { unclassified.push(u); continue; }

    const cls = typeof d === 'string' ? d : d?.class;
    if (!UNIT_CLASSES.includes(cls)) {
      add(u.id, `класс «${cls ?? 'нет'}» не из списка: ${UNIT_CLASSES.join(', ')} (строка ${u.line})`);
      continue;
    }
    if (cls === 'non_factual' && !String(d?.reason || '').trim()) {
      add(u.id, `non_factual без причины (строка ${u.line}) — «почему это не факт» решение, а не умолчание`);
      continue;
    }
    if ((cls === 'factual' || cls === 'actionable') && !claimed.has(u.id)) {
      add(u.id, `${cls} без утверждения в отчёте (строка ${u.line}): «${u.text.slice(0, 50)}»`);
    }
  }

  if (unclassified.length) {
    const list = unclassified.slice(0, 5).map((u) => `строка ${u.line}: «${u.text.slice(0, 34)}»`).join('; ');
    add('классификация',
      `не классифицировано единиц текста: ${unclassified.length} — ${list}`
      + `${unclassified.length > 5 ? ` и ещё ${unclassified.length - 5}` : ''}`);
  }

  return problems;
}

/** Сводка для метрик: сколько единиц и сколько из них разобрано. */
export function classificationStats(raw, report) {
  const units = textUnits(raw);
  const table = report?.units && typeof report.units === 'object' ? report.units : {};
  const known = units.filter((u) => table[u.id] !== undefined);
  const cls = (u) => (typeof table[u.id] === 'string' ? table[u.id] : table[u.id]?.class);
  return {
    units: units.length,
    classified: known.length,
    unclassified: units.length - known.length,
    factual: known.filter((u) => cls(u) === 'factual').length,
    actionable: known.filter((u) => cls(u) === 'actionable').length,
    nonFactual: known.filter((u) => cls(u) === 'non_factual').length,
  };
}
