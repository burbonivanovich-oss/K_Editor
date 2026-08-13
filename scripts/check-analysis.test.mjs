// Тесты гейта на оценщика.
//
// Каждый тест — про конкретный способ, которым шкала врала 13.08.2026:
// замечание без снятого балла, бонус поверх сотни, неприменимый критерий
// в плюс, блокер, который не сработал.
//
// Запуск: node --test scripts/check-analysis.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAnalysis, isLegacy, PASS, REQUIRED_CHECKS } from './check-analysis.mjs';

const checks = (over = {}) => {
  const out = {};
  for (const k of REQUIRED_CHECKS) out[k] = { ok: true };
  return { ...out, ...over };
};

const good = (over = {}) => ({
  slug: 'x',
  checkedAt: '2026-08-13',
  checks: checks(),
  categories: {
    lead: { score: 25, issues: [] },
    structure: { score: 25, issues: [] },
    language: { score: 25, issues: [] },
    usefulness: { score: 25, issues: [] },
  },
  score: 100,
  maxScore: 100,
  blocker: false,
  ...over,
});

const problems = (a) => checkAnalysis(a).map((p) => p.problem).join(' | ');

test('честно оформленная оценка проходит', () => {
  assert.deepEqual(checkAnalysis(good()), []);
});

// Ровно то, что стояло в статье со 100 баллами: «20/20» и рядом
// записанное нарушение.
test('замечание при полном балле — нарушение простили', () => {
  const a = good();
  a.categories.language.issues = ['три абзаца подряд одной формы'];
  assert.match(problems(a), /нарушение простили/);
});

test('замечаний больше, чем снятых баллов', () => {
  const a = good();
  a.categories.lead = { score: 24, issues: ['лид без факта', 'лид длиннее 150 слов'] };
  a.score = 99;
  assert.match(problems(a), /каждое стоит хотя бы балла/);
});

test('балл снят молча — автор не узнает, что чинить', () => {
  const a = good();
  a.categories.lead = { score: 20, issues: [] };
  a.score = 95;
  assert.match(problems(a), /ни одного замечания не записано/);
});

test('замечание со снятым баллом — так и должно быть', () => {
  const a = good();
  a.categories.lead = { score: 23, issues: ['лид начинается с определения', 'нет конкретного факта'] };
  a.score = 98;
  assert.deepEqual(checkAnalysis(a), []);
});

// Пять категорий уже давали 100, бонус упирался в тот же потолок и
// прятал ровно десятку дефицита.
test('бонусные баллы больше не принимаются', () => {
  const a = good();
  a.categories.ai_citation = { score: 10, issues: [] };
  assert.match(problems(a), /след старой шкалы/);
});

test('в оценку нельзя вернуть то, что проверяет скрипт', () => {
  const a = good();
  a.categories.seo = { score: 20, issues: [] };
  assert.match(problems(a), /категория «seo» лишняя/);
});

test('score обязан сходиться с суммой категорий', () => {
  const a = good({ score: 100 });
  a.categories.lead = { score: 20, issues: ['раз', 'два', 'три', 'четыре', 'пять'] };
  assert.match(problems(a), /не равен сумме категорий 95/);
});

// Раньше отсутствие pillar нормировалось ×20/16 и давало полный балл.
// Теперь это проверка со статусом «неприменимо»: не блокирует и не
// приносит баллов.
test('неприменимая проверка законна, но требует объяснения', () => {
  const ok = good({ checks: checks({ pillar: { applicable: false, note: 'у кластера ts-piot нет опорного материала' } }) });
  assert.deepEqual(checkAnalysis(ok), []);

  const mute = good({ checks: checks({ pillar: { applicable: false } }) });
  assert.match(problems(mute), /без объяснения/);
});

test('упавшая проверка обязана поднять блокер', () => {
  const a = good({ checks: checks({ npa: { ok: false } }) });
  assert.match(problems(a), /blocker должен быть true.*npa/);
});

test('упавшая проверка с поднятым блокером проходит', () => {
  const a = good({ checks: checks({ npa: { ok: false } }), blocker: true });
  assert.deepEqual(checkAnalysis(a), []);
});

test(`балл ниже ${PASS} обязан поднять блокер`, () => {
  const a = good({ score: 84, blocker: false });
  a.categories.lead = { score: 9, issues: Array.from({ length: 16 }, (_, i) => `замечание ${i + 1}`) };
  assert.match(problems(a), new RegExp(`blocker должен быть true.*ниже ${PASS}`));
});

test('пропущенная проверка называется по имени', () => {
  const c = checks();
  delete c.factcheck;
  assert.match(problems(good({ checks: c })), /нет проверки «factcheck»/);
});

test('отсутствующая категория называется по имени', () => {
  const a = good();
  delete a.categories.usefulness;
  a.score = 75;
  assert.match(problems(a), /нет категории «Польза»/);
});

test('блокер без причины непонятен', () => {
  assert.match(problems(good({ blocker: true })), /без blockerReason/);
});

test('балл вне диапазона категории отлавливается', () => {
  const a = good();
  a.categories.lead = { score: 30, issues: [] };
  assert.match(problems(a), /вне 0–25/);
});

/* Старая шкала — не «нечестно оформлено», а «не с чем сравнивать»:
 * там пять категорий по 20, бонус и нормировка pillar в плюс. Отчёт
 * обязан говорить «переоценить», а не «почини арифметику». */
test('оценка по старой шкале распознаётся отдельно от нарушений', () => {
  const old = {
    slug: 'x', score: 100, blocker: false, checkedAt: '2026-08-13',
    categories: {
      quality: { score: 20, issues: [] },
      seo: { score: 20, issues: [] },
      eeat: { score: 20, issues: [] },
      graph: { score: 20, issues: ['ссылка станет текстом'] },
      tech: { score: 20, issues: ['промоблоки из соседнего кластера'] },
      ai_citation: { score: 10, issues: [] },
    },
  };
  assert.equal(isLegacy(old), true);
  const found = checkAnalysis(old);
  assert.equal(found.length, 1, 'старая запись — одна понятная строка, а не список придирок');
  assert.match(found[0].problem, /переоценить/);
  assert.equal(found[0].legacy, true);
});

test('новая запись старой не считается', () => {
  assert.equal(isLegacy(good()), false);
});
