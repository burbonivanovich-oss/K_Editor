/**
 * K-01. Контракт материала: обещание проверяется, а не подразумевается.
 *
 * Все прочие проверки отвечают «нет ли здесь ошибки». Эта — «сделано ли
 * то, ради чего материал писался». Живой пример: таблица кодов ошибок
 * ТС ПИоТ фактически верна и при этом не выполняет обещание разбора —
 * не называет поставщика и версию, и читатель действует по чужой
 * таблице.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  draftContract, validateContract, checkContract,
  PROFILES, CONTENT_TYPES, loadContract,
} from './content-contract.mjs';

const ok = (type = 'instruction') => {
  const c = draftContract('проба', type);
  c.intent = 'помочь читателю сделать шаг';
  c.audience = ['кассир'];
  if (PROFILES[type].needsScope) c.scope.products = ['конкретная кассовая программа'];
  return c;
};

const said = (ps) => ps.map((p) => p.problem).join(' | ');

test('заполненная заготовка по типу проходит форму', () => {
  for (const t of CONTENT_TYPES) {
    const c = ok(t);
    assert.deepEqual(validateContract(c), [], `${t}: ${said(validateContract(c))}`);
  }
});

/* Заготовка нарочно неполна.
 *
 * Она несёт минимум профиля и ровно те поля, которые обязан заполнить
 * автор: чему статья помогает, кто её читает и — для инструкции и
 * разбора ошибок — про какой продукт речь. Раньше пустая заготовка
 * проходила форму, и девять контрактов корпуса так и остались
 * заготовками: intent из шаблона, scope пустой. Пусть недостача видна
 * в момент заведения контракта, а не на гейте перед выпуском. */
test('пустая заготовка форму не проходит — её надо заполнить', () => {
  for (const t of CONTENT_TYPES) {
    const bare = draftContract('проба', t);
    const ps = said(validateContract(bare));
    assert.match(ps, /intent/, `${t}: заготовка обязана требовать intent`);
    assert.match(ps, /audience/, `${t}: заготовка обязана требовать audience`);
    if (PROFILES[t].needsScope) {
      assert.match(ps, /scope\.products/, `${t}: профилю нужен предметный scope`);
    }
  }
});

test('контракт слабее профиля не принимается', () => {
  /* Материал, который называется инструкцией, обязан дать порядок
   * действий. Разрешить контракту убрать пункт значит разрешить назвать
   * инструкцией что угодно. */
  const c = ok('instruction');
  c.mustCover = c.mustCover.filter((x) => x.id !== 'rollback');
  assert.match(said(validateContract(c)), /слабее профиля/);
});

test('пункт без выражения — пожелание, а не требование', () => {
  const c = ok('instruction');
  c.mustCover.push({ id: 'вдохновение', what: 'читатель должен вдохновиться' });
  assert.match(said(validateContract(c)), /не требование, а пожелание/);
});

test('нерабочее выражение ловится формой, а не в проде', () => {
  const c = ok('instruction');
  c.mustCover[0].detect = '(';
  assert.match(said(validateContract(c)), /не разбирается/);
});

test('невыполненное обещание названо словами читателя, а не id', () => {
  const c = ok('instruction');
  const ps = checkContract(c, 'Пустой текст без единого обещания.');
  assert.ok(ps.length >= 4);
  assert.match(said(ps), /что нужно иметь до начала/);
});

test('выполненные обещания замечаний не дают', () => {
  const c = ok('instruction');
  const text = 'До начала понадобится доступ. Кассир выполняет действие. '
    + 'Убедитесь, что чек появился. Не помогло — обратитесь в поддержку поставщика.';
  assert.deepEqual(checkContract(c, text), []);
});

test('mustNotClaim ловит запрещённое утверждение и цитирует его', () => {
  const c = ok('troubleshooting');
  const text = 'Ошибка 401. ФФД 1.2, поставщик такой-то. Причина в токене. '
    + 'Продавать нельзя. Обратитесь к поставщику. '
    + 'Эта таблица — универсальный справочник кодов.';
  const ps = checkContract(c, text);
  assert.match(said(ps), /запрещённое утверждение/);
  assert.match(said(ps), /универсальн/);
});

test('роли источников сверяются с отчётом', () => {
  const c = ok('troubleshooting');   // riskTier high → нужны norm и officialGuidance
  const full = 'Ошибка 401. ФФД 1.2, поставщик. Причина. Продавать нельзя. Обратитесь к поставщику.';

  /* Отчёт на одних вторичных источниках не закрывает ни одного
   * требования: ровно та подмена, ради которой роли и заведены. */
  const weak = { claims: [{ evidence: [{ sourceRole: 'secondary' }] }] };
  assert.match(said(checkContract(c, full, weak)), /роли «norm»/);

  /* Норма закрывает и себя, и требование разъяснения: она старше. */
  const report = { claims: [{ evidence: [{ sourceRole: 'norm' }] }] };
  assert.deepEqual(checkContract(c, full, report), []);
});

test('нет контракта — не «неприменимо», а «проверять нечего»', () => {
  assert.match(said(checkContract(null, 'любой текст')), /нет контракта/);
});

test('у каждого профиля есть уровень риска и непустой mustCover', () => {
  for (const [type, p] of Object.entries(PROFILES)) {
    assert.ok(p.mustCover?.length, `${type}: пустой mustCover`);
    assert.ok(p.riskTier, `${type}: нет riskTier`);
    for (const item of p.mustCover) assert.ok(item.detect, `${type}/${item.id}: нет detect`);
  }
});

test('контракты корпуса лежат на месте и проходят форму', () => {
  const blog = 'src/content/blog';
  const slugs = readdirSync(blog).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  for (const slug of slugs) {
    const c = loadContract(slug);
    assert.ok(c, `нет контракта для ${slug}`);
    assert.deepEqual(validateContract(c), [], `${slug}: ${said(validateContract(c))}`);
  }
});

/* Иерархия ролей: сильное закрывает требование слабого, но не наоборот.
 *
 * Первая половина теста — про удобство: норма старше своего разъяснения,
 * и требовать письмо ФНС при наличии статьи закона значит требовать
 * ослабить доказательство. Вторая — про то, ради чего роли заведены:
 * документация вендора норму не заменяет никогда, иначе разъяснение
 * оператора начинает сходить за закон. */
test('норма закрывает требование officialGuidance, vendorDoc не закрывает norm', () => {
  const c = draftContract('s', 'instruction');
  c.requiredSources = ['officialGuidance'];
  const full = 'до начала понадобится доступ; кассир проверьте результат; '
    + 'если не получилось — обратитесь в поддержку поставщика';

  const byNorm = { claims: [{ evidence: [{ sourceRole: 'norm' }] }] };
  assert.deepEqual(checkContract(c, full, byNorm), [],
    'норма обязана закрывать требование разъяснения');

  const byVendor = { claims: [{ evidence: [{ sourceRole: 'vendorDoc' }] }] };
  assert.match(said(checkContract(c, full, byVendor)), /officialGuidance/,
    'документация вендора разъяснением ведомства не считается');

  c.requiredSources = ['norm'];
  assert.match(said(checkContract(c, full, byVendor)), /«norm»/,
    'vendorDoc не закрывает требование нормы');
  const byGuidance = { claims: [{ evidence: [{ sourceRole: 'officialGuidance' }] }] };
  assert.match(said(checkContract(c, full, byGuidance)), /«norm»/,
    'разъяснение не заменяет норму — иерархия работает в одну сторону');
});

/* Один intent на десять статей описывает ноль статей.
 *
 * Форму контракта проверяет `validateContract`, но она видит контракт
 * поодиночке и повтор заметить не может. Между тем девять контрактов
 * корпуса несли одну и ту же строчку «закрыть вопрос читателя по теме
 * статьи»: формально intent есть, по существу — заглушка, оставшаяся от
 * заготовки. Дубликат ловится только по корпусу целиком. */
test('intent у каждого контракта свой — заглушки из заготовки не остались', () => {
  const dir = 'src/data/contracts';
  const seen = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const key = String(c.intent || '').trim().toLowerCase();
    assert.ok(key.length >= 40, `${f}: intent слишком короткий, чтобы что-то обещать: «${c.intent}»`);
    const prev = seen.get(key);
    assert.ok(!prev, `${f} и ${prev}: одинаковый intent — он описывает обе статьи, значит ни одной`);
    seen.set(key, f);
  }
});

/* Уровень риска задаёт силу проверок, а не тон документа. */
test('понижение riskTier требует объяснения, повышение — нет', () => {
  const c = draftContract('s', 'troubleshooting');   // профильный high
  c.intent = 'разобрать ошибки конкретного модуля и довести кассира до устранения';
  c.audience = ['кассир'];
  c.scope.products = ['модуль ТС ПИоТ'];
  assert.deepEqual(validateContract(c), [], 'профильный уровень вопросов не вызывает');

  c.riskTier = 'low';
  assert.match(said(validateContract(c)), /riskTierReason/,
    'понижение обязано быть объяснено в самом контракте');

  c.riskTierReason = 'материал справочный, решений по деньгам не даёт';
  assert.deepEqual(validateContract(c), [], 'объяснённое понижение проходит');

  const up = draftContract('s2', 'instruction');     // профильный medium
  up.intent = 'провести читателя по настройке конкретной кассовой программы до рабочего чека';
  up.audience = ['администратор'];
  up.scope.products = ['кассовая программа'];
  up.riskTier = 'high';
  assert.deepEqual(validateContract(up), [], 'ужесточение в объяснении не нуждается');
});
