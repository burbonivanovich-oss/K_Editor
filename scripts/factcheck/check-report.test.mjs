// Тесты гейта на доказательство факта.
//
// Каждый тест — про способ, которым факчек 13.08.2026 пропустил шесть
// реальных ошибок в статье, стоя при этом на `passed` с нулём
// критических расхождений.
//
// Обратная сторона не менее важна: честно собранный отчёт обязан
// проходить без замечаний. Гейт, который ругается на правильную работу,
// отключат — и тогда он не сработает и в настоящий раз.
//
// Запуск: node --test scripts/factcheck/check-report.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReport, MIN_CONFIDENCE, numbersIn } from './check-report.mjs';

/** Утверждение, собранное как надо: сформулировано, с цитатой и нормой. */
const goodClaim = (over = {}) => ({
  id: 'c1',
  type: 'MONEY',
  raw: '2 250 000 ₽',
  statement: 'крупный размер по ст. 171.1 УК РФ для непродовольственных товаров — свыше 2 250 000 ₽',
  status: 'match',
  severity: 'critical',
  confidence: 0.95,
  quote: 'Деяния, предусмотренные настоящей статьёй, признаются совершёнными в крупном размере, '
    + 'если стоимость немаркированных товаров превышает 2 250 000 рублей',
  sources: ['http://publication.pravo.gov.ru/document/0001202301010001'],
  ...over,
});

const report = (claims, summary = {}) => ({
  claims,
  summary: { overallStatus: 'ok', criticalIssues: 0, ...summary },
});

const problems = (r) => checkReport(r).map((p) => p.problem).join(' | ');

test('честно собранный отчёт проходит без замечаний', () => {
  assert.deepEqual(checkReport(report([goodClaim()])), []);
});

/* --------------------------------- утверждение вместо токена */

// Ровно то, что было: raw «400 000 ₽» и никакого утверждения о том,
// порог чего это и по какой норме.
test('токен без утверждения не считается проверкой', () => {
  const c = goodClaim(); delete c.statement;
  assert.match(problems(report([c])), /нет поля statement/);
});

test('утверждение не длиннее токена — это тот же токен', () => {
  assert.match(problems(report([goodClaim({ statement: '2 250 000 ₽' })])), /не длиннее токена/);
});

/* ------------------------------------------- цитата со значением */

// Главное правило: не можешь привести цитату с числом — не проверил
// число. Именно так «400 000 ₽» и прошло с уверенностью 0.85.
test('«подтверждено поиском» без цитаты доказательством не является', () => {
  const c = goodClaim(); delete c.quote;
  assert.match(problems(report([c])), /нет дословной цитаты/);
});

test('цитата без нужного числа не подтверждает это число', () => {
  const c = goodClaim({
    quote: 'Деяния признаются совершёнными в крупном размере, если стоимость превышает 400 000 рублей',
  });
  assert.match(problems(report([c])), /в цитате нет значения/);
});

test('цитата с тем же числом в другом написании засчитывается', () => {
  const c = goodClaim({ quote: 'если стоимость превышает 2250000 рублей' });
  assert.deepEqual(checkReport(report([c])), []);
});

test('числа сравниваются без пробелов и разделителей', () => {
  assert.ok(numbersIn('2 250 000 ₽').includes('2250000'));
  assert.ok(numbersIn('стоимость 2.250.000 рублей').includes('2250000'));
});

/* --------------------------------------------- первоисточник */

// Отраслевой портал пересказывает норму. Порог уголовной
// ответственности берётся из текста нормы, а не из пересказа.
test('пересказ нормы не подтверждает порог', () => {
  const c = goodClaim({ sources: ['https://markirovka.ru/community/12345'] });
  assert.match(problems(report([c])), /нет ссылки на первоисточник/);
});

test('инструкция поддержки первоисточником не является', () => {
  const c = goodClaim({ sources: ['https://support.kontur.ru/market/84217-x'] });
  assert.match(problems(report([c])), /нет ссылки на первоисточник/);
});

test('источников нет вовсе — говорим прямо', () => {
  assert.match(problems(report([goodClaim({ sources: [] })])), /нет ни одного источника/);
});

/* ------------------------------------------------ уверенность */

// «Таблица кодов ошибок» стояла match при 0.55, «модуль сверяет код до
// пробития чека» — при 0.6. Оба оказались неверны. Число рядом со
// статусом было украшением: ни одно правило его не читало.
test(`критическое утверждение ниже ${MIN_CONFIDENCE.critical} не может быть «совпало»`, () => {
  assert.match(problems(report([goodClaim({ confidence: 0.6 })])), /«совпало» при уверенности 0\.6/);
});

test('moderate ниже порога тоже не проходит', () => {
  const c = goodClaim({ severity: 'moderate', confidence: 0.55, type: 'CLAIM', raw: 'таблица кодов ошибок' });
  assert.match(problems(report([c])), /«совпало» при уверенности 0\.55/);
});

test('minor с низкой уверенностью допустим — цена ошибки другая', () => {
  const c = { id: 'c9', type: 'LINK', raw: 'https://example.com', status: 'match', severity: 'minor', confidence: 0.4, sources: [] };
  assert.deepEqual(checkReport(report([c])), []);
});

/* ------------------------- риск определяется содержанием, не самооценкой */

/* Утверждение «ФФД 1.2 нужен для тега 1162» стояло как minor и потому
 * не проверялось строго. Номер тега неверен — касса по нему работать не
 * будет. Severity ставит тот же, кто проверяет; доверять этому полю в
 * гейте нельзя. */
test('номер тега опасен независимо от объявленной важности', () => {
  const c = {
    id: 'c21', type: 'NPA_FZ', raw: '54-ФЗ', status: 'match', severity: 'minor', confidence: 0.9,
    expectedValue: 'ст. 4.7 54-ФЗ — реквизиты чека; тег 1162 «код товара» для Data Matrix',
    sources: ['https://www.consultant.ru/document/cons_doc_LAW_42359/'],
  };
  const found = problems(report([c]));
  assert.match(found, /нет поля statement|нет дословной цитаты/);
});

test('упоминание штрафа делает утверждение опасным', () => {
  const c = {
    id: 'c30', type: 'CLAIM', raw: 'штраф до 300 000', status: 'match', severity: 'minor', confidence: 0.9,
    expectedValue: 'штраф по ч. 2 ст. 15.12 КоАП', sources: [],
  };
  assert.match(problems(report([c])), /нет ни одного источника|нет дословной цитаты/);
});

test('обычное утверждение без чисел и норм строгих требований не получает', () => {
  const c = { id: 'c40', type: 'CLAIM', raw: 'модуль работает на Windows', status: 'match', severity: 'minor', confidence: 0.9, sources: [] };
  assert.deepEqual(checkReport(report([c])), []);
});

/* ----------------------------------------------------- итог отчёта */

// write-marker копирует summary как есть — значит вердикт обязан
// следовать из утверждений, а не объявляться.
test('непроверенные значимые утверждения не дают «ok» в итоге', () => {
  const bad = goodClaim({ id: 'c2', status: 'uncertain' });
  assert.match(problems(report([goodClaim(), bad], { overallStatus: 'ok' })), /не подтверждены, а overallStatus/);
});

test('счётчик критических обязан сходиться с утверждениями', () => {
  const bad = goodClaim({ id: 'c2', status: 'mismatch' });
  assert.match(
    problems(report([goodClaim(), bad], { overallStatus: 'needs-rewrite', criticalIssues: 0 })),
    /criticalIssues заявлено 0, по утверждениям выходит 1/,
  );
});

test('пустой список утверждений — не «нечего проверять», а вопрос', () => {
  assert.match(problems(report([])), /список утверждений пуст/);
});

test('отчёт без claims распознаётся отдельно', () => {
  assert.match(problems({ summary: {} }), /нет списка claims/);
});
