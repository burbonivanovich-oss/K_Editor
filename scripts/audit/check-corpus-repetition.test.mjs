// Тесты корпусной повторяемости.
//
// Проверка появилась потому, что AI-checker на всех десяти статьях
// показывал 0–2 из 10 («машинного текста нет»), а корпус при этом
// выглядел собранным по одному шаблону: FAQ у всех, промоблоков ровно
// три у девяти из десяти, финалы совпадают дословно. Все прежние
// проверки смотрели на статью поодиночке и такого увидеть не могли.
//
// Запуск: node --test scripts/audit/check-corpus-repetition.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCorpusRepetition, parseArticle } from './check-corpus-repetition.mjs';

const article = ({ h2 = ['Раздел один', 'Раздел два'], faq = [], ending = 'Обычный финал статьи.', promos = 0, extra = '' } = {}) => [
  '---', 'title: "Т"', 'draft: false', '---', '',
  ...h2.flatMap((h) => [`## ${h}`, '', 'Текст раздела с содержанием.', '']),
  ...(faq.length ? ['## Частые вопросы', '', ...faq.flatMap((q) => [`**${q}**`, 'Ответ.', ''])] : []),
  ...Array.from({ length: promos }, (_, i) => [`Подводка ${i + 1}.`, '', `[Промоблок: 85${i}0]`, ''].join('\n')),
  extra,
  '', ending, '',
].join('\n');

function withCorpus(files, fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'corpus-rep-')));
  mkdirSync(join(dir, 'src/content/blog'), { recursive: true });
  for (const [slug, content] of Object.entries(files)) {
    writeFileSync(join(dir, 'src/content/blog', `${slug}.md`), content);
  }
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const run = (files) => withCorpus(files, (dir) => checkCorpusRepetition({ root: dir }));

test('разные статьи повторов не дают', () => {
  const r = run({
    a: article({ h2: ['Кто обязан подключать кассу', 'Сроки перехода'], ending: 'Проверьте модель кассы заранее.' }),
    b: article({ h2: ['Как оформить возврат', 'Что писать в чеке'], ending: 'Возврат оформляется отдельным документом.' }),
  });
  assert.deepEqual(r.outline, []);
  assert.deepEqual(r.ending, []);
  assert.deepEqual(r.phrases, []);
});

/* Самый заметный признак шаблона: читатель дочитывает и узнаёт конец. */
test('одинаковый финал в двух статьях виден', () => {
  const ending = 'Полный разбор кластера — в опорном материале про ТС ПИоТ и его подключение.';
  const r = run({
    a: article({ h2: ['Кто обязан'], ending }),
    b: article({ h2: ['Что делать при отказе'], ending }),
  });
  assert.equal(r.ending.length, 1);
  assert.equal(r.ending[0].score, 1);
});

test('совпадающий каркас H2 виден', () => {
  const h2 = ['Что это такое', 'Кто обязан подключать', 'Какие штрафы', 'Как подготовиться'];
  const r = run({ a: article({ h2 }), b: article({ h2 }) });
  assert.equal(r.outline.length, 1);
  assert.ok(r.outline[0].score >= 0.9);
});

test('один вопрос FAQ в двух статьях — вопрос к формату, а не к теме', () => {
  const q = 'Нужно ли ИП подключать ТС ПИоТ?';
  const r = run({
    a: article({ faq: [q, 'Что будет за нарушение?'] }),
    b: article({ faq: [q, 'Сколько стоит подключение?'] }),
  });
  assert.equal(r.faq.length, 1);
  assert.equal(r.faq[0].articles.length, 2);
});

test('дословный повтор от шести слов в трёх статьях всплывает', () => {
  const phrase = 'разобраться с настройкой кассы можно самостоятельно или передать специалистам';
  const r = run({
    a: article({ extra: phrase }), b: article({ extra: phrase }), c: article({ extra: phrase }),
  });
  assert.ok(r.phrases.some((p) => p.phrase.includes('разобраться с настройкой')), JSON.stringify(r.phrases));
});

test('повтор в двух статьях порога не достигает — это ещё не шаблон', () => {
  const phrase = 'разобраться с настройкой кассы можно самостоятельно или передать специалистам';
  const r = run({ a: article({ extra: phrase }), b: article({ extra: phrase }) });
  assert.deepEqual(r.phrases, []);
});

/* Ссылка на одну и ту же норму обязана повторяться — это предметная
 * область, а не шаблон. Иначе список заполняется цитатами НПА и
 * настоящие шаблонные обороты в нём не видно. */
test('повтор ссылки на норму шаблоном не считается', () => {
  const cite = 'по ч. 2 ст. 14.5 КоАП РФ 2026';
  const r = run({ a: article({ extra: cite }), b: article({ extra: cite }), c: article({ extra: cite }) });
  assert.deepEqual(r.phrases.filter((p) => /14 5/.test(p.phrase)), []);
});

test('формальные признаки считаются числом, а не оценкой', () => {
  const r = run({
    a: article({ faq: ['Вопрос один?', 'Вопрос два?'], promos: 3 }),
    b: article({ promos: 3 }),
    c: article({ promos: 0 }),
  });
  assert.equal(r.formal.total, 3);
  assert.equal(r.formal.withFaq, 1);
  assert.equal(r.formal.promoCounts[3], 2);
  assert.equal(r.formal.promoCounts[0], 1);
});

test('разбор статьи находит финал, а не промоблок и не заголовок', () => {
  const parsed = parseArticle(article({ ending: 'Настоящий финал статьи.', promos: 2 }));
  assert.equal(parsed.ending, 'Настоящий финал статьи.');
  assert.equal(parsed.promos.length, 2);
});
