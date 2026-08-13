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
  { key: 'targetKeyword', title: 'Целевой запрос', width: 190 },
  /* Колонки «Приоритет» здесь больше нет — убрана 13.08.2026 по просьбе
   * редакции. Приоритет как понятие остался: он задаёт порядок тем в
   * батче (next-batch, P0 → P1 → P2) и живёт в состоянии цикла. Просто
   * ставит его бот при отборе темы, а редактор на него не смотрел и не
   * менял — колонка занимала ширину и добавляла ещё один столбец в
   * «мешанину». Срочность редактор задаёт решением «написать сейчас»:
   * оно сильнее любого приоритета и понятнее буквы P0. */
  { key: 'adaptation',    title: 'Адаптация',      width: 200, owner: 'editor' },
  { key: 'wordstat',      title: 'Wordstat',       width: 90  },
  { key: 'cluster',       title: 'Кластер',        width: 110 },
  { key: 'why',           title: 'Зачем сейчас',   width: 320 },
  // Дальше — то, что нужно при отборе темы и мешает при работе с ней.
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

/** Внутренний статус → надпись в колонке «Статус». Общий словарь: его
 *  пишет и drive-sync (при заливке строк), и cycle-state (при обновлении
 *  статусов). Разные написания в двух местах означали бы, что таблица
 *  показывает то «review», то «на вычитке» — в зависимости от того, кто
 *  писал последним. */
export const RU_STATUS = {
  candidate: 'кандидат',
  planned: 'в плане',
  writing: 'пишется',
  review: 'на вычитке',
  accepted: 'принято',
  released: 'выпущено',
  dropped: 'снято',
};

/** Приоритет — только из известного набора. Раньше сюда попадало что
 *  угодно: apply-decisions копирует значение ячейки в состояние цикла, и
 *  когда в «Приоритет» уехал статус, состояние приняло его как приоритет
 *  и вернуло обратно в таблицу. Своей колонки у приоритета больше нет,
 *  но проверка остаётся: значение приходит из планов и очередей. */
export const PRIORITIES = ['P0', 'P1', 'P2'];
export const isPriority = (v) => PRIORITIES.includes(String(v || '').trim().toUpperCase());

/**
 * Каналы адаптации — колонка «Адаптация».
 *
 * Отдельная колонка, а не значения в «Решении», по одной причине:
 * адаптаций у статьи бывает несколько сразу («и в Телеграм, и в Дзен»),
 * а «Решение» — это одно действие с темой. Свалить их в один список
 * значило бы заставить редактора выбирать между Телеграмом и Дзеном там,
 * где выбирать не нужно.
 *
 * Список нестрогий (`strict: false`, как у остальных): значения можно
 * перечислять через запятую, писать сокращённо («ТГ») или дописывать
 * свои. Разбор — `parseAdaptations`.
 */
export const ADAPTATION_CHANNELS = [
  { key: 'telegram', title: 'Телеграм',      aliases: ['телеграм', 'тг', 'telegram', 'tg'] },
  { key: 'dzen',     title: 'Дзен',          aliases: ['дзен', 'dzen', 'яндекс дзен'] },
  { key: 'promo',    title: 'Промостраница', aliases: ['промостраница', 'промостраницы', 'промо', 'promo'] },
  { key: 'vk',       title: 'VK',            aliases: ['vk', 'вк', 'вконтакте'] },
  { key: 'email',    title: 'Email-дайджест', aliases: ['email', 'емейл', 'почта', 'рассылка', 'дайджест'] },
];

/** Значения выпадающего списка колонки «Адаптация». */
export const ADAPTATION_VALUES = ADAPTATION_CHANNELS.map((c) => c.title);

/**
 * Ячейка «Адаптация» → ключи каналов.
 *
 * Редактор пишет «ТГ, Дзен» или «Телеграм; промостраница» — разделитель
 * и регистр не оговорены нигде, и оговаривать их значило бы завести ещё
 * одно правило, которое редакция обязана помнить.
 */
export function parseAdaptations(cell) {
  const raw = String(cell || '').toLowerCase();
  if (!raw.trim()) return [];
  const parts = raw.split(/[,;/·|]+|\s+и\s+/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const hit = ADAPTATION_CHANNELS.find((c) => c.aliases.some((a) => p === a || p.includes(a)));
    if (hit && !out.includes(hit.key)) out.push(hit.key);
  }
  return out;
}
