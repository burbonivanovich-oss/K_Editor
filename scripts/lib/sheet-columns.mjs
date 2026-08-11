/**
 * Колонки таблицы редакции — единственный источник правды.
 *
 * Модуль общий, а не копия в каждом скрипте, по той же причине, что и
 * slugify: drive-sync.mjs рисует таблицу по этому списку, cycle-state.mjs
 * пишет в неё ячейки буквами A1-нотации. Пока порядок колонок жил в одном
 * файле, а буквы — в другом, любая перестановка колонок молча разъезжалась.
 * Так и вышло 11.08.2026: после слияния бэклога и плана в одну вкладку
 * sheet-sync продолжал писать статус в «I», а «I» стала «Приоритетом» —
 * статусы, ссылки на доки и ID уехали в три чужие колонки, и ни одна
 * проверка этого не заметила.
 *
 * Порядок колонок = порядок в таблице. Слева то, ради чего редактор её
 * открывает: тема, что с ней происходит, что он может сделать. Справа —
 * исследовательский контекст, который нужен один раз при отборе темы.
 *
 * owner: 'editor' — колонка редактора, 'bot' — заполняется автоматически
 * и защищена от правки. hidden: true — колонка скрыта (не удалена):
 * данные в ней нужны скриптам и доступны по «показать колонки», но не
 * занимают ширину экрана.
 */
export const WORK_COLS = [
  { key: 'n',             title: '#',              width: 40,  owner: 'bot' },
  { key: 'topic',         title: 'Тема',           width: 380 },
  { key: 'status',        title: 'Статус',         width: 130, owner: 'bot' },
  { key: 'decision',      title: 'Решение',        width: 150, owner: 'editor' },
  { key: 'who',           title: 'Кто пишет',      width: 110, owner: 'editor' },
  { key: 'note',          title: 'Правка',         width: 260, owner: 'editor' },
  { key: 'doc',           title: 'Документ',       width: 200, owner: 'bot' },
  { key: 'reason',        title: 'Причина отказа', width: 240, owner: 'editor' },
  { key: 'priority',      title: 'Приоритет',      width: 90  },
  { key: 'wordstat',      title: 'Wordstat',       width: 90  },
  { key: 'cluster',       title: 'Кластер',        width: 110 },
  { key: 'why',           title: 'Зачем сейчас',   width: 260 },
  // Дальше — то, что нужно при отборе темы и мешает при работе с ней.
  { key: 'targetKeyword', title: 'Целевой запрос', width: 200, hidden: true },
  { key: 'segment',       title: 'Сегмент',        width: 150, hidden: true },
  { key: 'product',       title: 'Продукт',        width: 150, hidden: true },
  { key: 'type',          title: 'Тип',            width: 90,  hidden: true },
  { key: 'normHint',      title: 'Норма/дата',     width: 200, hidden: true },
  { key: 'dedup',         title: 'Дедуп',          width: 170, hidden: true },
  { key: 'konturLink',    title: 'Ссылка Маркета', width: 220, hidden: true },
  { key: 'related',       title: 'Связки',         width: 300, hidden: true },
  { key: 'slug',          title: 'ID (не менять)', width: 160, owner: 'bot', hidden: true },
];

export const WORK_HEADER_ROW = 4;
export const WORK_FIRST_DATA_ROW = 5;
export const APPROVAL_CELL = 'B2';

/** Индекс колонки → буква A1-нотации. */
export function colLetter(i) {
  let n = i, out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}

export const workIdx = (key) => WORK_COLS.findIndex((c) => c.key === key);
/** Буква колонки по ключу: `COL.status` вместо зашитой «I». */
export const COL = Object.fromEntries(WORK_COLS.map((c, i) => [c.key, colLetter(i)]));
