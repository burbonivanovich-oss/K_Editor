/**
 * J-01/J-02. Реестр повторяемых фактов и сверка корпуса.
 *
 * Обе проверки существуют ради одного класса ошибок: статья, безупречная
 * сама по себе, спорит с соседней. Так порог крупного размера жил в
 * корпусе в двух значениях сразу, и обе статьи проходили факчек.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkCorpus, validateRegistry, loadRegistry, looksHistorical, FACT_KINDS,
} from './fact-registry.mjs';

const EVIDENCE = {
  kind: 'primary', sourceRole: 'norm',
  url: 'https://www.consultant.ru/document/cons_doc_LAW_10699/x/',
  locator: 'примечание к статье 170.2',
  retrievedAt: '2026-08-21', effectiveAsOf: '2026-08-21',
  quote: 'крупным размером признаётся стоимость, превышающая три миллиона пятьсот тысяч рублей',
};

const VALUE_FACT = {
  id: 'porog', kind: 'value',
  statement: 'Крупный размер по общей норме главы 22 УК РФ — свыше 3 500 000 ₽.',
  scope: 'ч. 1–2 ст. 171.1 УК РФ',
  value: '3 500 000',
  supersedes: [{ value: '2 250 000', until: '2024-04-06', by: 'ФЗ от 06.04.2024 № 79-ФЗ' }],
  effectiveFrom: '2024-04-06', effectiveTo: null, evidence: EVIDENCE,
};

const RULE_FACT = {
  id: 'gis-mt', kind: 'rule',
  statement: 'Отсутствие ответа ГИС МТ продажу не запрещает.',
  scope: 'разрешительный режим на кассе',
  effectiveFrom: '2024-04-01', effectiveTo: null, evidence: EVIDENCE,
  detect: 'ГИС\\s*МТ',
  contradicts: ['не\\s+ответил\\p{L}*\\s+вовсе[^.]{0,60}остановить\\s+продажу'],
};

function withCorpus(articles, facts, fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'facts-')));
  mkdirSync(join(root, 'src/content/blog'), { recursive: true });
  mkdirSync(join(root, 'src/data/factcheck'), { recursive: true });
  for (const [slug, body] of Object.entries(articles)) {
    writeFileSync(join(root, 'src/content/blog', `${slug}.md`),
      `---\ntitle: "${slug}"\npubDate: "2026-08-13"\n---\n\n${body}\n`);
  }
  writeFileSync(join(root, 'src/data/factcheck/facts.json'), JSON.stringify({ facts }));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('прежнее значение, поданное как действующее, — конфликт', () => {
  withCorpus({ a: 'Порог — от 2 250 000 ₽ для непродовольственных товаров.' }, [VALUE_FACT], (root) => {
    const { conflicts } = checkCorpus({ root });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].factId, 'porog');
    assert.match(conflicts[0].problem, /Актуальное — «3 500 000»/);
  });
});

test('историческое упоминание прежнего значения — не конфликт', () => {
  /* «Подняли с 2 250 000 ₽» — правильный способ объяснить изменение.
   * Запрещать его значило бы запрещать рассказывать про редакции. */
  withCorpus({
    a: 'Общий порог подняли с 2 250 000 ₽ Федеральным законом от 06.04.2024 № 79-ФЗ до 3 500 000 ₽.',
  }, [VALUE_FACT], (root) => {
    assert.deepEqual(checkCorpus({ root }).conflicts, []);
  });
});

test('две статьи с разными значениями одной нормы — конфликт находится в той, что устарела', () => {
  withCorpus({
    staraya: 'Порог — от 2 250 000 ₽.',
    svezhaya: 'Порог — свыше 3 500 000 ₽.',
  }, [VALUE_FACT], (root) => {
    const { conflicts, usage } = checkCorpus({ root });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].slug, 'staraya');
    assert.deepEqual(usage.get('porog'), ['svezhaya']);
  });
});

test('правило: статья, утверждающая обратное, — конфликт', () => {
  withCorpus({
    a: 'Если ГИС МТ не подтвердила код или не ответила вовсе, касса обязана остановить продажу.',
  }, [RULE_FACT], (root) => {
    const { conflicts } = checkCorpus({ root });
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0].problem, /противоречит реестру/);
  });
});

test('правило: статья на ту же тему без противоречия конфликта не даёт', () => {
  withCorpus({
    a: 'Если ГИС МТ не ответила, проверка переходит в офлайн-режим по локальной базе.',
  }, [RULE_FACT], (root) => {
    const { conflicts, usage } = checkCorpus({ root });
    assert.deepEqual(conflicts, []);
    assert.deepEqual(usage.get('gis-mt'), ['a'], 'статья должна числиться пользующейся записью');
  });
});

test('номер строки указывает в файл, а не в тело без frontmatter', () => {
  withCorpus({ a: 'Первая строка.\n\nПорог — от 2 250 000 ₽.' }, [VALUE_FACT], (root) => {
    const { conflicts } = checkCorpus({ root });
    /* frontmatter занимает 4 строки + пустая; «Порог» — восьмая строка файла. */
    assert.equal(conflicts[0].line, 8, `строка ${conflicts[0].line} — редактор откроет файл, а не тело`);
  });
});

test('looksHistorical различает «подняли с» и «порог —»', () => {
  const t = 'общий порог подняли с 2 250 000 ₽';
  assert.ok(looksHistorical(t, t.indexOf('2 250 000')));
  const u = 'порог — от 2 250 000 ₽';
  assert.ok(!looksHistorical(u, u.indexOf('2 250 000')));
});

/* ── форма записи ───────────────────────────────────────────────────── */

test('запись без доказательства не принимается: она управляет проверкой всего корпуса', () => {
  const f = { ...VALUE_FACT };
  delete f.evidence;
  assert.ok(validateRegistry([f]).some((p) => /нет доказательства/.test(p.problem)));
});

test('rule без contradicts ничего не проверяет — и это ошибка формы', () => {
  const f = { ...RULE_FACT, contradicts: [] };
  assert.ok(validateRegistry([f]).some((p) => /без contradicts/.test(p.problem)));
});

test('нерабочее регулярное выражение ловится при проверке формы, а не в проде', () => {
  const f = { ...RULE_FACT, detect: '(' };
  assert.ok(validateRegistry([f]).some((p) => /не разбирается/.test(p.problem)));
});

test('kind закрыт', () => {
  assert.deepEqual(FACT_KINDS, ['value', 'rule']);
  assert.ok(validateRegistry([{ ...VALUE_FACT, kind: 'выдумка' }]).some((p) => /не из списка/.test(p.problem)));
});

test('живой реестр корпуса проходит форму и не даёт конфликтов', () => {
  const { facts } = loadRegistry();
  assert.ok(facts.length, 'реестр пуст — сверять корпус не с чем');
  assert.deepEqual(validateRegistry(facts), []);
  assert.deepEqual(checkCorpus().conflicts, []);
});
