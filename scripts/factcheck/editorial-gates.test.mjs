/**
 * L-03…L-06. Редакционные проверки.
 *
 * Все они про материалы, которые фактически безупречны и при этом
 * бесполезны или опасны: финал, который нельзя выполнить; FAQ, который
 * пересказывает статью; категоричность без условий; критическое
 * утверждение, подтверждённое тем же, кто его писал.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkActionability, checkFaqNovelty, checkCategorical, finalActions, faqPairs,
} from './editorial-gates.mjs';
import { checkIndependentReview, draftContract } from './content-contract.mjs';

const art = (body) => `---\ntitle: "x"\ndraft: true\n---\n\n${body}\n`;

/* ── L-03 ───────────────────────────────────────────────────────────── */

test('пункт без ответственного, срока и результата — не задача', () => {
  const raw = art('## Что делать дальше\n\n- Проверьте версию ФФД.');
  const [a] = checkActionability(raw);
  assert.ok(a);
  assert.deepEqual(a.missing, ['ответственный', 'срок или триггер', 'проверяемый результат']);
});

test('полный пункт замечаний не даёт', () => {
  const raw = art('## Что делать дальше\n\n'
    + '- Администратор до 01.10.2026 проверяет версию ФФД в личном кабинете ОФД; убедитесь, что стоит 1.2.');
  assert.deepEqual(checkActionability(raw), []);
});

test('берутся пункты финального раздела, а не любого списка', () => {
  const raw = art('## Порядок\n\n- Первый шаг.\n\n## Что делать дальше\n\n- Финальный пункт.');
  assert.deepEqual(finalActions(raw).map((a) => a.text), ['Финальный пункт.']);
});

/* ── L-04 ───────────────────────────────────────────────────────────── */

test('ответ, целиком пересказывающий статью, помечается', () => {
  const raw = art(
    'Подключить модуль обязаны продавцы маркированных товаров через онлайн-кассу с декабря.\n\n'
    + '## Частые вопросы\n\n'
    + '### Кто обязан подключить модуль\n\n'
    + 'Подключить модуль обязаны продавцы маркированных товаров через онлайн-кассу с декабря.',
  );
  const [f] = checkFaqNovelty(raw);
  assert.ok(f, 'пересказ не пойман');
  assert.ok(f.overlap >= 0.8);
});

test('ответ, добавляющий новое, не помечается', () => {
  const raw = art(
    'Подключить модуль обязаны продавцы маркированных товаров.\n\n'
    + '## Частые вопросы\n\n'
    + '### Что делать при аварии оператора\n\n'
    + 'Зафиксируйте инцидент в учётной системе; следующие семьдесят два часа проверка не требуется.',
  );
  assert.deepEqual(checkFaqNovelty(raw), []);
});

test('вопросы читаются и заголовком, и жирной строкой', () => {
  const raw = art('## Частые вопросы\n\n### Первый вопрос?\n\nОтвет один.\n\n**Второй вопрос?**\nОтвет два.');
  assert.deepEqual(faqPairs(raw).map((p) => p.question), ['Первый вопрос?', 'Второй вопрос?']);
});

/* ── L-05 ───────────────────────────────────────────────────────────── */

test('категоричность без условий помечается, с условиями — нет', () => {
  assert.equal(checkCategorical(art('Продавец обязан пробить чек.')).length, 1);
  assert.equal(checkCategorical(art('Если товар маркированный, продавец обязан пробить чек.')).length, 0);
  assert.equal(checkCategorical(art('По ст. 1.2 закона продавец обязан пробить чек.')).length, 0);
});

test('«обязанность» — существительное, а не требование к читателю', () => {
  assert.deepEqual(checkCategorical(art('Обязанность применять ККТ появилась давно.')), []);
});

test('заголовок соседней статьи в ссылке не считается утверждением', () => {
  /* «[ТС ПИоТ: кто обязан, сроки и штрафы]» — название материала. */
  assert.deepEqual(checkCategorical(art('Разбор — в статье [ТС ПИоТ: кто обязан и сроки](/blog/x/).')), []);
});

test('сокращение не рвёт предложение и не прячет условие', () => {
  /* Просто `.` резал фразу на «ст.», и условие за сокращением в
   * предложение не попадало — замечание появлялось там, где область как
   * раз названа. */
  assert.deepEqual(checkCategorical(art('Согласно ч. 2 ст. 14.5 КоАП РФ юрлицо обязано уплатить штраф.')), []);
});

/* ── L-06 ───────────────────────────────────────────────────────────── */

const high = () => {
  const c = draftContract('проба', 'troubleshooting');   // riskTier high
  c.intent = 'x'; c.audience = ['кассир'];
  return c;
};
const report = (over = {}) => ({ claims: [{ id: 'r1', severity: 'critical' }], ...over });
const said = (ps) => ps.map((p) => p.problem).join(' | ');

test('high-risk: критическое утверждение требует второго проверяющего', () => {
  assert.match(said(checkIndependentReview(high(), report({ checkedBy: 'автор' }))), /нужен второй проверяющий/);
});

test('high-risk: автор не подтверждает сам себя', () => {
  const ps = checkIndependentReview(high(), report({ checkedBy: 'Ирина', reviewedBy: 'ирина' }));
  assert.match(said(ps), /совпадают/);
});

test('high-risk: разные роли — замечаний нет', () => {
  assert.deepEqual(checkIndependentReview(high(), report({ checkedBy: 'Ирина', reviewedBy: 'Пётр' })), []);
});

test('средний риск вторым проходом не обременяется', () => {
  const c = draftContract('проба', 'instruction');       // riskTier medium
  c.intent = 'x'; c.audience = ['кассир'];
  assert.deepEqual(checkIndependentReview(c, report({ checkedBy: 'Ирина' })), []);
});

test('нет критических утверждений — нет и требования', () => {
  const r = { claims: [{ id: 'r1', severity: 'minor' }], checkedBy: 'Ирина' };
  assert.deepEqual(checkIndependentReview(high(), r), []);
});
