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
import { checkReport, MIN_CONFIDENCE, numbersIn, numeralWordsIn } from './check-report.mjs';

/** Доказательство с первоисточника: страницу открывали, место указано. */
const goodEvidence = (over = {}) => ({
  kind: 'primary',
  sourceRole: 'norm',
  url: 'http://publication.pravo.gov.ru/document/0001202301010001',
  locator: 'примечание к статье 170.2',
  retrievedAt: '2026-08-20',
  effectiveAsOf: '2026-08-20',
  snapshotHash: 'a'.repeat(64),
  quote: 'крупным размером признаётся стоимость, превышающая три миллиона пятьсот тысяч рублей',
  ...over,
});

/** Утверждение, собранное как надо: сформулировано, с доказательством. */
const goodClaim = (over = {}) => ({
  id: 'c1',
  type: 'MONEY',
  raw: '3 500 000 ₽',
  statement: 'крупный размер по ч. 1–2 ст. 171.1 УК РФ — свыше 3 500 000 ₽ (примечание к ст. 170.2 УК РФ)',
  subject: 'нарушитель по ст. 171.1 УК РФ',
  modality: 'statement',
  status: 'match',
  severity: 'critical',
  confidence: 0.95,
  evidence: [goodEvidence()],
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
test('«подтверждено поиском» без доказательств не является доказательством', () => {
  const c = goodClaim(); delete c.evidence;
  assert.match(problems(report([c])), /нет доказательств \(evidence\)/);
});

test('цитата без нужного числа не подтверждает это число', () => {
  const c = goodClaim({
    evidence: [goodEvidence({ quote: 'Деяния признаются совершёнными в крупном размере, если стоимость превышает 400 000 рублей' })],
  });
  assert.match(problems(report([c])), /нет значения/);
});

test('цитата с тем же числом в другом написании засчитывается', () => {
  const c = goodClaim({ evidence: [goodEvidence({ quote: 'если стоимость превышает 3500000 рублей' })] });
  assert.deepEqual(checkReport(report([c])), []);
});

/* ------------------------------- происхождение цитаты (D-02) */

/* Сниппет говорит, что строка где-то встречается. Он не говорит, что она
 * есть в этом документе и в этой редакции — а research-инструкция
 * допускала его как подтверждение. */
test('поисковый сниппет для значимого утверждения даёт только «неясно»', () => {
  const c = goodClaim({
    evidence: [{
      kind: 'snippet',
      url: 'http://publication.pravo.gov.ru/document/0001202301010001',
      quote: 'стоимость немаркированных товаров превышает 2 250 000 рублей',
    }],
  });
  assert.match(problems(report([c])), /только поисковым сниппетом/);
});

for (const field of ['locator', 'retrievedAt', 'effectiveAsOf', 'snapshotHash']) {
  test(`доказательство без ${field} невоспроизводимо`, () => {
    const e = goodEvidence(); delete e[field];
    assert.match(problems(report([goodClaim({ evidence: [e] })])), new RegExp(`нет ${field}`));
  });
}

test('первоисточником считается домен нормы, а не любая страница с цитатой', () => {
  const c = goodClaim({ evidence: [goodEvidence({ url: 'https://blog-pro-kassy.example/razbor-normy' })] });
  assert.match(problems(report([c])), /нет доказательства с первоисточника/);
});

test('числа сравниваются без пробелов и разделителей', () => {
  assert.ok(numbersIn('2 250 000 ₽').includes('2250000'));
  assert.ok(numbersIn('стоимость 2.250.000 рублей').includes('2250000'));
});

/* --------------------------------------------- первоисточник */

// Отраслевой портал пересказывает норму. Порог уголовной
// ответственности берётся из текста нормы, а не из пересказа.
test('пересказ нормы не подтверждает порог', () => {
  const c = goodClaim({ evidence: [goodEvidence({ url: 'https://blog-pro-kassy.example/razbor-normy' })] });
  assert.match(problems(report([c])), /нет доказательства с первоисточника/);
});

test('инструкция поддержки первоисточником не является', () => {
  const c = goodClaim({ evidence: [goodEvidence({ url: 'https://support.kontur.ru/market/84217-x' })] });
  assert.match(problems(report([c])), /нет доказательства с первоисточника/);
});

test('доказательств нет вовсе — говорим прямо и называем класс риска', () => {
  const c = goodClaim(); delete c.evidence;
  assert.match(problems(report([c])), /строгий режим: тип MONEY/);
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
  assert.match(found, /нет поля statement|нет доказательств/);
});

test('упоминание штрафа делает утверждение опасным', () => {
  const c = {
    id: 'c30', type: 'CLAIM', raw: 'штраф до 300 000', status: 'match', severity: 'minor', confidence: 0.9,
    expectedValue: 'штраф по ч. 2 ст. 15.12 КоАП', sources: [],
  };
  assert.match(problems(report([c])), /нет доказательств/);
});

test('обычное утверждение без чисел и норм строгих требований не получает', () => {
  const c = { id: 'c40', type: 'CLAIM', raw: 'модуль работает на Windows', status: 'match', severity: 'minor', confidence: 0.9, sources: [] };
  assert.deepEqual(checkReport(report([c])), []);
});

/* Итог отчёта (summary против claims) проверяет report-schema.mjs —
 * там он считается из утверждений целиком, а не сверяется на глаз.
 * Тесты на это: scripts/factcheck/report-schema.test.mjs. */

test('пустой список утверждений — не «нечего проверять», а вопрос', () => {
  assert.match(problems(report([])), /список утверждений пуст/);
});

test('отчёт без claims распознаётся отдельно', () => {
  assert.match(problems({ summary: {} }), /нет списка claims/);
});

/* ------------------------------------------- числительные прописью */

/* НПА пишет суммы словами: «превышающая четыреста тысяч рублей».
 * Требование найти в цитате цифры делало гейт непроходимым для
 * настоящей цитаты первоисточника — и толкало подогнать цитату под
 * проверку. Гейт, который нельзя пройти честно, хуже отсутствующего;
 * поймано при первой же пересборке отчёта по новой схеме. */
test('суммы прописью читаются как числа', () => {
  const cases = [
    ['превышающая четыреста тысяч рублей', '400000'],
    ['один миллион пятьсот тысяч рублей', '1500000'],
    ['превышающей три миллиона пятьсот тысяч рублей', '3500000'],
    ['тринадцать миллионов пятьсот тысяч рублей', '13500000'],
    ['превышающая сто тысяч рублей', '100000'],
    ['один миллион рублей', '1000000'],
  ];
  for (const [text, expected] of cases) {
    assert.ok(numeralWordsIn(text).includes(expected), `${text} → ожидалось ${expected}`);
  }
});

test('цитата с суммой прописью подтверждает число из статьи', () => {
  const c = goodClaim({
    raw: '400 000 ₽',
    statement: 'крупный размер по ч. 3–4 ст. 171.1 УК РФ для продовольственных товаров — свыше 400 000 ₽',
    evidence: [goodEvidence({ quote: 'стоимость немаркированных продовольственных товаров, превышающая четыреста тысяч рублей' })],
  });
  assert.deepEqual(checkReport(report([c])), []);
});

test('цитата прописью с ДРУГОЙ суммой по-прежнему не подтверждает', () => {
  const c = goodClaim({
    raw: '400 000 ₽',
    statement: 'крупный размер для продовольственных товаров — свыше 400 000 ₽',
    evidence: [goodEvidence({ quote: 'превышающая три миллиона пятьсот тысяч рублей' })],
  });
  assert.match(problems(report([c])), /нет значения/);
});

test('текст без числительных не выдумывает чисел', () => {
  assert.deepEqual(numeralWordsIn('порядок применения контрольно-кассовой техники'), []);
  assert.deepEqual(numeralWordsIn(''), []);
});

/* ── H-06: доказательство обязано подтверждать этот сценарий ─────────── */

test('вторичный источник строгий класс не закрывает, даже если открыт целиком', () => {
  /* Ровно случай статьи про эквайринг: отсрочку «до следующего рабочего
   * дня» подтвердили двумя разборами (klerk.ru, forus.ru). Обе страницы
   * открывали, обе цитаты настоящие — и обе про другой пункт нормы. */
  const r = report([goodClaim({ evidence: [goodEvidence({ sourceRole: 'secondary' })] })]);
  assert.match(problems(r), /вторичным источником/);
});

test('роль не проставлена — считается вторичным, а не первоисточником', () => {
  /* Умолчание должно быть строгим: незаполненное поле не может быть
   * выгоднее заполненного честно. */
  const ev = goodEvidence();
  delete ev.sourceRole;
  assert.match(problems(report([goodClaim({ evidence: [ev] })])), /вторичным источником/);
});

test('официальное разъяснение закрывает строгий класс наравне с нормой', () => {
  const r = report([goodClaim({ evidence: [goodEvidence({ sourceRole: 'officialGuidance' })] })]);
  assert.deepEqual(checkReport(r), []);
});

test('субъект доказательства, не названный в утверждении, — замечание', () => {
  /* Цитата про юрлицо не доказывает норму про ИП: суммы отличаются втрое. */
  const r = report([goodClaim({ evidence: [goodEvidence({ scope: { subject: 'юридическое лицо' } })] })]);
  assert.match(problems(r), /субъект доказательства/);
});

test('версия доказательства сверяется с утверждением', () => {
  const bad = report([goodClaim({ evidence: [goodEvidence({ scope: { version: 'ФФД 1.2' } })] })]);
  assert.match(problems(bad), /версия доказательства/);

  /* Версия, названная в утверждении, замечания не даёт. */
  const ok = report([goodClaim({
    statement: 'порядок для ФФД 1.05: обратный чек, затем верный',
    evidence: [goodEvidence({ scope: { version: 'ФФД 1.05' } })],
  })]);
  assert.ok(!/версия доказательства/.test(problems(ok)), problems(ok));
});

test('доказательство без scope область утверждения не опровергает', () => {
  assert.deepEqual(checkReport(report([goodClaim()])), []);
});

test('effectiveTo: null — норма действует бессрочно, это не ошибка формата', () => {
  const r = report([goodClaim({ evidence: [goodEvidence({ effectiveTo: null })] })]);
  assert.deepEqual(checkReport(r), []);
});
