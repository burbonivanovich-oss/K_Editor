// Тесты разбора ячейки «Тема».
//
// Три строки из живой таблицы 13.08.2026 — на них разбор и писался.
// Если он сломается, статья снова уедет в файл с именем
// `2026-08-13-aktualizirovat-statyu-https-kontur-ru-…`, а просьба
// редактора «не менять актуальное» опять не дойдёт до пайплайна.
//
// Запуск: node --test scripts/lib/update-task.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTopicCell, marketArticleId, lookupCatalog } from './update-task.mjs';

const EGAIS = 'Актуализировать статью https://kontur.ru/market/spravka/38077-kak_rabotat_v_egais_bez_oshibok_nyuansy_i_sovety  Не менять в тексте то, что еще актуально, только предложить новые правки. Предложить места в статье, куда можно вставить промо Контур.Маркета по работе с ЕГАИС с текстовой подводкой к нему. Возможности Маркета: в инструкциях https://support.kontur.ru/market/39645-rabota_s_egais_v_markete';

const TSPIOT = 'Заголовок: Ошибки при работе с ТС ПИоТ: как их исправить и что означают коды. Использовать не только общую информацию по ошибкам, но и конкретно как это работает в Маркете, по инструкции https://support.kontur.ru/market/84217-oshibki_pri_rabote_s_ts_piot_na_kassax_windows';

const EKVAIRING = 'Актуализировать статью https://kontur.ru/market/spravka/25147-kak_rabotaet_oplata_cherez_ekvajring';

const CATALOG = [
  {
    url: 'https://kontur.ru/market/spravka/38077-kak_rabotat_v_egais_bez_oshibok_nyuansy_i_sovety',
    title: 'Как работать в ЕГАИС без ошибок Как работать в ЕГАИС без ошибок',
    viewsTotal: 41200,
  },
];

test('задача на актуализацию распознаётся, ссылка отделяется от просьбы', () => {
  const t = parseTopicCell(EGAIS);
  assert.equal(t.kind, 'update');
  assert.equal(t.sourceUrl, 'https://kontur.ru/market/spravka/38077-kak_rabotat_v_egais_bez_oshibok_nyuansy_i_sovety');
  assert.deepEqual(t.refUrls, ['https://support.kontur.ru/market/39645-rabota_s_egais_v_markete']);
});

// Именно эта фраза не дошла до пайплайна и стоила новой статьи вместо
// разбора правок. Она обязана сохраниться дословно.
test('просьба редактора сохраняется целиком, без ссылок и директивы', () => {
  const t = parseTopicCell(EGAIS);
  assert.match(t.brief, /^Не менять в тексте то, что еще актуально/);
  assert.match(t.brief, /промо Контур\.Маркета/);
  assert.ok(!/https?:/.test(t.brief), `в просьбе не должно быть ссылок:\n${t.brief}`);
  assert.ok(!/^Актуализировать/i.test(t.brief), 'директива должна быть отрезана');
});

test('заголовок берётся из каталога Маркета, а не из URL', () => {
  const t = parseTopicCell(EGAIS, { catalog: CATALOG });
  assert.equal(t.sourceTitle, 'Как работать в ЕГАИС без ошибок');
  assert.equal(t.title, 'Актуализация: Как работать в ЕГАИС без ошибок');
});

test('статьи нет в каталоге — заголовок собирается из URL, не из всей ячейки', () => {
  const t = parseTopicCell(EKVAIRING);
  assert.equal(t.kind, 'update');
  assert.ok(!/https?:/.test(t.title), `в заголовке не должно быть ссылки: ${t.title}`);
  assert.match(t.title, /^Актуализация:/);
});

test('«Заголовок: …» — заголовок отделяется от инструкции', () => {
  const t = parseTopicCell(TSPIOT);
  assert.equal(t.kind, 'new');
  assert.equal(t.title, 'Ошибки при работе с ТС ПИоТ: как их исправить и что означают коды');
  assert.match(t.brief, /^Использовать не только общую информацию/);
  assert.deepEqual(t.refUrls, ['https://support.kontur.ru/market/84217-oshibki_pri_rabote_s_ts_piot_na_kassax_windows']);
});

test('обычный заголовок остаётся собой', () => {
  const t = parseTopicCell('Что такое ТС ПИоТ и кому он нужен');
  assert.equal(t.kind, 'new');
  assert.equal(t.title, 'Что такое ТС ПИоТ и кому он нужен');
  assert.equal(t.brief, '');
});

/* Разобранный заголовок возвращается на вход снова и снова: из очереди
 * актуализации, из ячейки таблицы, из состояния цикла. Пока разбор не был
 * идемпотентным, второй проход не находил ссылку (её в заголовке уже нет)
 * и выдавал «Актуализация: статья без ссылки», теряя название. */
test('разбор идемпотентен: разобранный заголовок не портится вторым проходом', () => {
  const once = parseTopicCell(EGAIS, { catalog: CATALOG });
  const twice = parseTopicCell(once.title, { catalog: CATALOG });
  assert.equal(twice.title, once.title);
  assert.equal(twice.kind, 'update');
  assert.equal(twice.sourceTitle, 'Как работать в ЕГАИС без ошибок');
});

test('пустая ячейка не роняет разбор', () => {
  const t = parseTopicCell('');
  assert.equal(t.kind, 'new');
  assert.equal(t.title, '');
});

// Одна и та же статья приходит со слэшем, с utm-хвостом и по http.
test('id материала не зависит от формы ссылки', () => {
  const forms = [
    'https://kontur.ru/market/spravka/38077-kak_rabotat',
    'http://kontur.ru/market/spravka/38077-kak_rabotat/',
    'https://kontur.ru/market/spravka/38077-kak_rabotat?utm_source=mail',
  ];
  for (const f of forms) assert.equal(marketArticleId(f), '38077', f);
});

test('дублированный заголовок из выгрузки Метрики схлопывается', () => {
  const hit = lookupCatalog('https://kontur.ru/market/spravka/38077-x', CATALOG);
  assert.equal(hit.title, 'Как работать в ЕГАИС без ошибок');
});

// В живой выгрузке между словами стоят неразрывные пробелы, и в двух
// половинах они расставлены по-разному. Пока это не выравнивали,
// обратная ссылка не срабатывала и редактор видел двойной заголовок.
test('неразрывные пробелы не мешают схлопнуть дубль', () => {
  const half = 'При каких условиях общепит освобождают от НДС в 2026 году';
  const catalog = [{ url: 'https://kontur.ru/market/spravka/82510-nds', title: `${half} ${half}` }];
  const hit = lookupCatalog('https://kontur.ru/market/spravka/82510-nds', catalog);
  assert.equal(hit.title, 'При каких условиях общепит освобождают от НДС в 2026 году');
  assert.ok(!/ /.test(hit.title), 'неразрывные пробелы должны быть заменены обычными');
});

// Слово «обновить» без слова «статья» — это не задача на актуализацию,
// а обычная тема («Как обновить прошивку кассы»).
test('«обновить» без «статьи» не делает задачу актуализацией', () => {
  const t = parseTopicCell('Как обновить прошивку фискального накопителя');
  assert.equal(t.kind, 'new');
});
