// Тесты раскладки колонок таблицы редакции.
//
// Модуль появился после того, как одна и та же ошибка случилась трижды:
// буквы колонок были зашиты в трёх местах, в набор добавили «Сегмент» и
// «Связки», и статусы поехали в «Приоритет», ссылки на доки — в «Зачем
// сейчас», а ID — в «Норма/дата». Тесты закрепляют инварианты, на
// которые опираются cycle-state, drive-sync и verify-sheet.
//
// Запуск: node --test scripts/lib/sheet-columns.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORK_COLS, WORK_HEADER_ROW, WORK_FIRST_DATA_ROW, WORK_FROZEN_COLS, APPROVAL_CELL, COLUMN_RENAMES, colLetter, workIdx, COL, RU_STATUS, PRIORITIES, isPriority, parseAdaptations, ADAPTATION_VALUES, ARTICLE_FORMATS, planColumnSync } from './sheet-columns.mjs';

test('ключи колонок уникальны', () => {
  const keys = WORK_COLS.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, `дубли: ${keys.filter((k, i) => keys.indexOf(k) !== i)}`);
});

test('заголовки колонок уникальны — по ним идёт чтение таблицы', () => {
  const titles = WORK_COLS.map((c) => c.title.toLowerCase());
  assert.equal(new Set(titles).size, titles.length, `дубли: ${titles.filter((t, i) => titles.indexOf(t) !== i)}`);
});

test('colLetter считает буквы за пределами первой двадцатки', () => {
  assert.equal(colLetter(0), 'A');
  assert.equal(colLetter(25), 'Z');
  assert.equal(colLetter(26), 'AA');
  assert.equal(colLetter(27), 'AB');
});

test('COL и workIdx описывают одну и ту же колонку', () => {
  for (const c of WORK_COLS) {
    assert.equal(COL[c.key], colLetter(workIdx(c.key)), `${c.key} разъехался`);
  }
});

test('workIdx на неизвестном ключе возвращает -1, а не молча ноль', () => {
  assert.equal(workIdx('нет-такого'), -1);
});

// Регрессия 11.08.2026: статус писали в «Приоритет», ссылку на док — в
// «Зачем сейчас», ID — в «Норма/дата». Проверяем не буквы (они поедут при
// следующей правке набора), а то, что ключ ведёт к колонке с тем же
// смыслом.
test('ключевые колонки на своих местах по смыслу', () => {
  assert.equal(WORK_COLS[workIdx('status')].title, 'Статус');
  assert.equal(WORK_COLS[workIdx('doc')].title, 'Ссылка на докс');
  assert.equal(WORK_COLS[workIdx('slug')].title, 'ID (не менять)');
  assert.equal(WORK_COLS[workIdx('decision')].title, 'Решение');
});

test('колонки редактора помечены владельцем — их нельзя перезаписывать', () => {
  const editorKeys = WORK_COLS.filter((c) => c.owner === 'editor').map((c) => c.key);
  for (const key of ['decision', 'who', 'note', 'reason', 'format', 'theses']) {
    assert.ok(editorKeys.includes(key), `${key} должна принадлежать редактору`);
  }
});

test('ботовские колонки, которые нельзя отдавать редактору', () => {
  for (const key of ['status', 'doc', 'slug']) {
    assert.equal(WORK_COLS[workIdx(key)].owner, 'bot', `${key} должна быть ботовской`);
  }
});

test('данные начинаются строкой ниже заголовка', () => {
  assert.equal(WORK_FIRST_DATA_ROW, WORK_HEADER_ROW + 1);
  assert.match(APPROVAL_CELL, /^[A-Z]+\d+$/);
});

test('русские статусы покрывают все состояния темы', () => {
  for (const st of ['candidate', 'planned', 'writing', 'review', 'accepted', 'released', 'dropped']) {
    assert.ok(RU_STATUS[st], `нет перевода для ${st}`);
  }
  const values = Object.values(RU_STATUS);
  assert.equal(new Set(values).size, values.length, 'два статуса с одинаковой подписью не различить в таблице');
});

// Регрессия: приоритет из таблицы попадал в состояние как есть, и любая
// строка из чужой ячейки становилась «приоритетом» темы.
test('приоритет принимается только из набора', () => {
  assert.ok(isPriority('P0') && isPriority(' p2 '));
  assert.ok(!isPriority('высокий'));
  assert.ok(!isPriority(''));
  assert.ok(!isPriority(undefined));
  assert.deepEqual(PRIORITIES, ['P0', 'P1', 'P2']);
});

/* ------------------------------------------------- колонка «Адаптация» */

// Колонка появилась 13.08.2026 вместо «Приоритета». Отдельная колонка, а
// не значения «Решения», потому что адаптаций у статьи бывает несколько
// сразу — в одном списке пришлось бы выбирать между Телеграмом и Дзеном
// там, где выбирать не нужно.

test('несколько каналов через запятую разбираются все', () => {
  assert.deepEqual(parseAdaptations('Телеграм, Дзен, Промостраница'), ['telegram', 'dzen', 'promo']);
});

// Разделитель и регистр нигде не оговорены, и оговаривать их значило бы
// завести ещё одно правило, которое редакция обязана помнить.
test('разделители и регистр значения не имеют', () => {
  const expected = ['telegram', 'dzen'];
  for (const cell of ['ТГ, Дзен', 'тг; дзен', 'Телеграм / Дзен', 'ТГ и Дзен', 'ТГ|ДЗЕН']) {
    assert.deepEqual(parseAdaptations(cell), expected, cell);
  }
});

test('сокращения редакции понимаются', () => {
  assert.deepEqual(parseAdaptations('тг'), ['telegram']);
  assert.deepEqual(parseAdaptations('промо'), ['promo']);
  assert.deepEqual(parseAdaptations('вк'), ['vk']);
  assert.deepEqual(parseAdaptations('рассылка'), ['email']);
});

test('повтор канала в одной ячейке не удваивает заказ', () => {
  assert.deepEqual(parseAdaptations('Телеграм, ТГ, telegram'), ['telegram']);
});

test('порядок сохраняется — в нём редакция расставила приоритет', () => {
  assert.deepEqual(parseAdaptations('Дзен, Телеграм'), ['dzen', 'telegram']);
});

test('пустая ячейка ничего не заказывает', () => {
  for (const cell of ['', '   ', null, undefined]) assert.deepEqual(parseAdaptations(cell), []);
});

test('незнакомый канал не выдумывается', () => {
  assert.deepEqual(parseAdaptations('Одноклассники'), []);
  assert.deepEqual(parseAdaptations('Одноклассники, Дзен'), ['dzen'], 'знакомое рядом с незнакомым не теряется');
});

test('значения выпадающего списка совпадают с тем, что разбирается обратно', () => {
  for (const v of ADAPTATION_VALUES) {
    assert.equal(parseAdaptations(v).length, 1, `значение списка «${v}» должно разбираться`);
  }
});

/* Колонки «Приоритет» больше нет: редакция её не заполняла. Проверка
 * приоритета осталась — значение приходит из планов и очередей. */
test('колонки «Приоритет» в раскладке нет, а проверка значения осталась', () => {
  assert.equal(WORK_COLS.some((c) => c.key === 'priority'), false);
  assert.equal(isPriority('P0'), true);
  assert.equal(isPriority('высокий'), false);
});

test('«Адаптация» — колонка редактора, а не бота', () => {
  const col = WORK_COLS.find((c) => c.key === 'adaptation');
  assert.ok(col, 'колонка должна быть в раскладке');
  assert.equal(col.owner, 'editor');
});

/* --------------------------------- раскладка 23.08.2026: четыре слева */

/* Редакция открывает таблицу, чтобы решить по теме: о чём пишем, где
 * текст, в каком формате, о чём именно. Раньше ради ссылки на док
 * приходилось прокручивать вбок — она стояла седьмой, за «Правкой». */
test('слева стоят четыре рабочие колонки, и ровно они закреплены', () => {
  assert.deepEqual(
    WORK_COLS.slice(0, WORK_FROZEN_COLS).map((c) => c.key),
    ['topic', 'doc', 'format', 'theses'],
  );
  assert.equal(WORK_FROZEN_COLS, 4);
});

/* Закреплённая колонка, которая при этом скрыта, — закрепление впустую:
 * места на экране она не занимает, но и показать нечего. */
test('ни одна из закреплённых колонок не скрыта', () => {
  for (const c of WORK_COLS.slice(0, WORK_FROZEN_COLS)) {
    assert.ok(!c.hidden, `${c.key} закреплена и одновременно скрыта`);
  }
});

/* «Если пишем — кем, если не подходит — почему»: обе половины ответа
 * должны стоять рядом с решением, а не по разным концам таблицы. */
test('«Кто пишет» и «Причина отказа» идут сразу за «Решением»', () => {
  const d = workIdx('decision');
  const tail = WORK_COLS.slice(d, d + 4).map((c) => c.key);
  assert.ok(tail.includes('who') && tail.includes('reason'), tail.join(','));
});

/* Регрессия: скрытая колонка без данных — просто пустой столбец, а
 * скрытая ботовская колонка, которую перестали заполнять, ломает
 * apply-decisions. Нумерацию скрыли, но писать в неё не перестали. */
test('«#» скрыта, но осталась ботовской колонкой раскладки', () => {
  const n = WORK_COLS[workIdx('n')];
  assert.ok(n, 'колонка должна остаться в раскладке');
  assert.equal(n.hidden, true);
  assert.equal(n.owner, 'bot');
});

/* --------------------------------------- переименования колонок */

/* sync-columns сверяет живую вкладку с WORK_COLS по заголовкам. Без
 * карты переименований он увидел бы «Документ» как лишнюю колонку,
 * удалил её вместе со ссылками на доки и вставил пустую «Ссылка на
 * докс». Ровно так 11.08.2026 уехали статусы, доки и ID. */
test('карта переименований ведёт на живые ключи раскладки', () => {
  for (const [oldTitle, key] of COLUMN_RENAMES) {
    assert.notEqual(workIdx(key), -1, `${oldTitle} ведёт на несуществующий ключ ${key}`);
    assert.equal(oldTitle, oldTitle.toLowerCase(), 'заголовки в карте — в нижнем регистре');
  }
});

test('переименованного заголовка нет среди текущих — иначе колонка задвоится', () => {
  const titles = new Set(WORK_COLS.map((c) => c.title.toLowerCase()));
  for (const oldTitle of COLUMN_RENAMES.keys()) {
    assert.ok(!titles.has(oldTitle), `«${oldTitle}» и старое название, и текущее`);
  }
});

/* --------------------------------------- колонка «Формат статьи» */

// Появилась 23.08.2026. До неё формат писали прозой в «Правке», и дальше
// по конвейеру его никто не разбирал — content-writer видел обычное
// замечание, а не структуру будущего материала.

test('форматы статьи — непустой список без дублей', () => {
  assert.ok(ARTICLE_FORMATS.length >= 2);
  assert.equal(new Set(ARTICLE_FORMATS).size, ARTICLE_FORMATS.length);
  for (const f of ARTICLE_FORMATS) assert.equal(f, f.trim(), `«${f}» с лишними пробелами`);
});

test('колонка «Формат статьи» есть в раскладке и принадлежит редактору', () => {
  const col = WORK_COLS[workIdx('format')];
  assert.ok(col, 'колонка должна быть в раскладке');
  assert.equal(col.owner, 'editor');
  assert.ok(!col.hidden, 'формат выбирают глазами — скрывать его незачем');
});

test('«Тезисы» — колонка редактора и стоит рядом с форматом', () => {
  const col = WORK_COLS[workIdx('theses')];
  assert.ok(col);
  assert.equal(col.owner, 'editor');
  assert.equal(workIdx('theses'), workIdx('format') + 1);
});

/* ------------------------------------------- план приведения колонок */

/* Раскладка разъезжалась молча уже трижды, и каждый раз это замечали по
 * испорченным данным, а не по упавшей проверке. Здесь план проверяется
 * без Google — и не только на «сходится», а прогоном по живой строке:
 * применяем шаги к массиву значений и смотрим, что уцелело. */

const TITLES = WORK_COLS.map((c) => c.title);

/** Прогоняет план по строке значений — так же, как это делает Sheets. */
function applyPlan(plan, row) {
  const out = [...row];
  for (const p of plan) {
    if (p.kind === 'rename') continue;              // трогает только заголовок
    else if (p.kind === 'delete') out.splice(p.at, 1);
    else if (p.kind === 'insert') out.splice(p.at, 0, '');
    else out.splice(p.at, 0, out.splice(p.from, 1)[0]);
  }
  return out;
}

test('совпадающая раскладка не даёт ни одного шага', () => {
  const { plan, error } = planColumnSync(TITLES);
  assert.equal(error, null);
  assert.deepEqual(plan, []);
});

test('хвост пустых ячеек за последней колонкой — не колонки', () => {
  const { plan, error } = planColumnSync([...TITLES, '', '  ', '']);
  assert.equal(error, null);
  assert.deepEqual(plan, []);
});

test('незнакомая колонка удаляется, недостающая вставляется', () => {
  const cur = TITLES.filter((t) => t !== 'Тезисы').concat('Приоритет');
  const { plan, error } = planColumnSync(cur);
  assert.equal(error, null);
  assert.ok(plan.some((p) => p.kind === 'delete' && p.title === 'Приоритет'));
  assert.ok(plan.some((p) => p.kind === 'insert' && p.title === 'Тезисы'));
});

/* Ради этого шага всё и затевалось: 23.08.2026 «Ссылка на докс» уехала с
 * седьмого места на второе. Без перестановки план означал бы «удалить
 * колонку и вставить пустую» — то есть стереть ссылки на все доки. */
test('перестановка двигает колонку, а не пересоздаёт её', () => {
  const cur = [...TITLES];
  cur.splice(1, 0, cur.splice(6, 1)[0]);   // живая вкладка в другом порядке
  const { plan, error } = planColumnSync(cur);
  assert.equal(error, null);
  assert.ok(plan.length > 0, 'порядок отличается — план не может быть пустым');
  assert.ok(plan.every((p) => p.kind === 'move'), plan.map((p) => p.kind).join(','));
});

test('план приводит строку ровно к целевому порядку', () => {
  const cur = [...TITLES].reverse();
  const row = cur.map((t) => `знач:${t}`);
  const { plan, error } = planColumnSync(cur);
  assert.equal(error, null);
  assert.deepEqual(applyPlan(plan, row), TITLES.map((t) => `знач:${t}`));
});

/* Главное свойство: ни одна ячейка редактора не должна пропасть по
 * дороге. Проверяем не заголовки, а значения — заголовки после миграции
 * переписываются целиком и «сходятся» всегда. */
test('данные существующих колонок переживают перестановку и переименование', () => {
  const cur = ['#', 'Тема', 'Статус', 'Решение', 'Кто пишет', 'Правка', 'Документ',
    'Причина отказа', 'Целевой запрос', 'Адаптация', 'Wordstat', 'Кластер', 'Зачем сейчас'];
  const row = cur.map((t) => `знач:${t}`);
  const { plan, error } = planColumnSync(cur);
  assert.equal(error, null);
  const after = applyPlan(plan, row);

  // «Правка» стала «Комментарием», «Документ» — «Ссылкой на докс»:
  // название новое, значение прежнее.
  assert.equal(after[workIdx('note')], 'знач:Правка');
  assert.equal(after[workIdx('doc')], 'знач:Документ');
  // Всё остальное — на своих новых местах.
  assert.equal(after[workIdx('topic')], 'знач:Тема');
  assert.equal(after[workIdx('decision')], 'знач:Решение');
  assert.equal(after[workIdx('reason')], 'знач:Причина отказа');
  assert.equal(after[workIdx('n')], 'знач:#');
  // Новые колонки приходят пустыми, а не с чужим значением.
  assert.equal(after[workIdx('format')], '');
  assert.equal(after[workIdx('theses')], '');
  // Ни одно значение не потеряно и не задвоено.
  assert.deepEqual(after.filter(Boolean).sort(), row.sort());
});

/* Две колонки с одним заголовком — единственный случай, где непонятно, в
 * какой из них данные. Выбрать любую значило бы выбросить работу
 * редактора, поэтому команда обязана отказаться, а не угадывать. */
test('дубль заголовков останавливает миграцию, а не решается молча', () => {
  const { plan, error } = planColumnSync([...TITLES, 'Тема']);
  assert.match(error || '', /две колонки с одним заголовком/);
  assert.deepEqual(plan, [], 'при отказе план должен быть пуст');
});

test('пустая вкладка — это вставить все колонки и ничего не удалить', () => {
  const { plan, error } = planColumnSync([]);
  assert.equal(error, null);
  assert.equal(plan.filter((p) => p.kind === 'insert').length, WORK_COLS.length);
  assert.equal(plan.some((p) => p.kind === 'delete'), false);
});

/* moveDimension считает индекс назначения по раскладке ДО перемещения.
 * Для движения вправо его пришлось бы поправлять на единицу — поэтому
 * двигаем только влево, и это свойство плана, а не соглашение в уме. */
test('перестановки идут только справа налево', () => {
  const cur = [...TITLES].reverse();
  const { plan } = planColumnSync(cur);
  for (const p of plan.filter((s) => s.kind === 'move')) {
    assert.ok(p.at < p.from, `«${p.title}»: ${p.from} → ${p.at}`);
  }
});
