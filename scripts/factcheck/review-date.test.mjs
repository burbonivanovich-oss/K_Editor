/**
 * J-03. Дата проверки считается по ближайшему событию.
 *
 * Проверяется главный случай корпуса: у статьи «кто обязан подключить
 * модуль до 1 октября 2026 года» плановая проверка стояла на 9 февраля
 * 2027-го — через четыре месяца после того, как срок из заголовка
 * пройдёт. Единый TTL исходит из того, что материалы стареют
 * равномерно; они стареют событиями.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewDateFor, reviewDateProblem, eventDates, datesIn, TTL_MONTHS,
} from './review-date.mjs';

const TODAY = '2026-08-21';

test('событие раньше потолка — проверка назначается на событие', () => {
  const r = reviewDateFor({
    pubDate: '2026-08-09',
    articleRaw: 'Временный токен закрывается 01.10.2026, продлений больше не будет.',
    today: TODAY,
  });
  assert.equal(r.date, '2026-10-01');
  assert.equal(r.event, '2026-10-01');
  assert.match(r.reason, /наступит раньше планового срока/);
});

test('дата словами считается наравне с цифрами', () => {
  /* «1 октября 2026 года» в статьях пишут чаще, чем «01.10.2026». */
  const r = reviewDateFor({
    pubDate: '2026-08-09',
    articleRaw: 'Подключить модуль нужно до 1 октября 2026 года.',
    today: TODAY,
  });
  assert.equal(r.date, '2026-10-01');
  assert.deepEqual(datesIn('срок — 1 октября 2026 года'), ['2026-10-01']);
});

test('событий нет — остаётся потолок по типу материала', () => {
  const r = reviewDateFor({ pubDate: '2026-08-09', articleRaw: 'Ничего не происходит.', today: TODAY });
  assert.equal(r.date, '2027-02-09');
  assert.equal(r.event, null);
  assert.match(r.reason, /будущих событий в статье нет/);
});

test('потолок считается календарными месяцами, а не днями', () => {
  /* Правило репозитория — «pubDate + 6 месяцев». Дни расходятся с ним
   * на три-четыре дня и засоряют отчёт замечаниями на пустом месте. */
  assert.equal(reviewDateFor({ pubDate: '2026-08-13', today: TODAY }).date, '2027-02-13');
  assert.equal(TTL_MONTHS.default, 6);
});

test('конец месяца не перескакивает в следующий', () => {
  assert.equal(reviewDateFor({ pubDate: '2026-08-31', today: TODAY }).date, '2027-02-28');
});

test('прошедшее событие проверку в прошлое не назначает', () => {
  const r = reviewDateFor({
    pubDate: '2026-08-09',
    articleRaw: 'Требование действует с 28.12.2025.',
    today: TODAY,
  });
  assert.equal(r.date, '2027-02-09');
  assert.equal(r.event, null);
});

test('тип материала меняет потолок', () => {
  assert.equal(reviewDateFor({ pubDate: '2026-08-09', contentType: 'instruction', today: TODAY }).date, '2027-08-09');
  assert.equal(reviewDateFor({ pubDate: '2026-08-09', contentType: 'legal', today: TODAY }).date, '2027-02-09');
});

test('даты берутся и из отчёта, и из реестра, а не только из текста', () => {
  const report = { claims: [{ effectiveFrom: '2026-09-15', evidence: [{ effectiveTo: '2026-12-31' }] }] };
  const facts = [{ effectiveFrom: '2027-01-01', effectiveTo: null }];
  const dates = eventDates({ articleRaw: '', report, facts });
  assert.ok(dates.includes('2026-09-15'));
  assert.ok(dates.includes('2026-12-31'));
  assert.ok(dates.includes('2027-01-01'));
  assert.equal(reviewDateFor({ pubDate: '2026-08-09', report, facts, today: TODAY }).date, '2026-09-15');
});

test('дата позже посчитанной — проблема, раньше — нет', () => {
  const c = reviewDateFor({ pubDate: '2026-08-09', articleRaw: 'Срок — 01.10.2026.', today: TODAY });
  assert.match(reviewDateProblem('2027-02-09', c), /позже, чем нужно/);
  assert.equal(reviewDateProblem('2026-10-01', c), null);
  assert.equal(reviewDateProblem('2026-09-01', c), null, 'проверять чаще правила никто не запрещает');
  assert.match(reviewDateProblem('когда-нибудь', c), /не в формате/);
});
