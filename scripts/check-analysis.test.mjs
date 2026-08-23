// Тесты гейта на оценщика.
//
// Каждый тест — про конкретный способ, которым шкала врала 13.08.2026:
// замечание без снятого балла, бонус поверх сотни, неприменимый критерий
// в плюс, блокер, который не сработал.
//
// Запуск: node --test scripts/check-analysis.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAnalysis, isLegacy, PASS, REQUIRED_CHECKS, ANALYSIS_SCHEMA_VERSION,
  INTENT_MATRICES, INTENTS,
} from './check-analysis.mjs';

/** Матрица задачи, пройденная целиком. */
const intentChecks = (intent = 'instruction', over = {}) => ({
  ...Object.fromEntries(Object.keys(INTENT_MATRICES[intent].checks).map((k) => [k, { ok: true }])),
  ...over,
});

/** Замечание в текущей форме: вес и место, а не голая строка. */
const issue = (text, over = {}) => ({ text, severity: 'minor', ...over });

const checks = (over = {}) => {
  const out = {};
  for (const k of REQUIRED_CHECKS) out[k] = { ok: true };
  return { ...out, ...over };
};

const good = (over = {}) => ({
  slug: 'x',
  checkedAt: '2026-08-13',
  analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
  articleHash: 'a'.repeat(64),
  articleNormHash: 'b'.repeat(64),
  rubricVersion: '2026-08-13',
  intent: 'instruction',
  intentChecks: intentChecks(),
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
  a.categories.language.issues = [issue('три абзаца подряд одной формы')];
  assert.match(problems(a), /нарушение простили/);
});

test('замечаний больше, чем снятых баллов', () => {
  const a = good();
  a.categories.lead = { score: 24, issues: [issue('лид без факта'), issue('лид длиннее 150 слов')] };
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
  a.categories.lead = { score: 23, issues: [issue('лид начинается с определения'), issue('нет конкретного факта')] };
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

/* ── E-01: оценка привязана к версии текста и рубрики ──────────────── */

import { validateAnalysisBundle, ANALYSIS_SCHEMA_VERSION as V, BLOCKING_ISSUE_KINDS } from './check-analysis.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { articleHash, articleNormHash } from './factcheck/hashes.mjs';

for (const field of ['analysisSchemaVersion', 'articleHash', 'articleNormHash', 'rubricVersion']) {
  test(`оценка без ${field} не проходит контракт`, () => {
    const a = good();
    delete a[field];
    assert.match(problems(a), new RegExp(field));
  });
}

test('старую запись можно разобрать явно, без требований контракта', () => {
  const a = good();
  for (const f of ['analysisSchemaVersion', 'articleHash', 'articleNormHash', 'rubricVersion']) delete a[f];
  assert.deepEqual(checkAnalysis(a, 'оценка', { requireVersioned: false }), []);
});

/* ── E-01: замечание — не строка, а объект с весом и местом ────────── */

test('замечание строкой больше не принимается', () => {
  const a = good();
  a.categories.lead = { score: 24, issues: ['лид без факта'] };
  a.score = 99;
  assert.match(problems(a), /записано строкой/);
});

test('незнакомый вес замечания — ошибка', () => {
  const a = good();
  a.categories.lead = { score: 24, issues: [issue('лид без факта', { severity: 'ужасно' })] };
  a.score = 99;
  assert.match(problems(a), /severity «ужасно» не из списка/);
});

/* Ровно то, ради чего вес и заводился: статья, которая обещает
 * инструкцию и не даёт её, набирала 96 и уходила в выпуск. */
for (const kind of BLOCKING_ISSUE_KINDS) {
  test(`замечание «${kind}» поднимает блокер, а не стоит один балл`, () => {
    const a = good();
    a.categories.usefulness = {
      score: 24,
      issues: [issue('заголовок обещает пошаговую инструкцию, её в тексте нет', { kind, span: { line: 12 } })],
    };
    a.score = 99;
    assert.match(problems(a), /blocker должен быть true — блокирующие замечания/);

    a.blocker = true;
    assert.deepEqual(checkAnalysis(a), []);
  });
}

test('блокирующее замечание обязано указывать место в тексте', () => {
  const a = good();
  a.categories.usefulness = { score: 24, issues: [issue('статья отвечает не на тот запрос', { kind: 'intent-mismatch' })] };
  a.score = 99;
  a.blocker = true;
  assert.match(problems(a), /не указано место \(span\.line\)/);
});

/* ── E-02: нерешённый DECIDE ───────────────────────────────────────── */

const withDecide = (resolution) => {
  const a = good();
  a.checks = checks({ market: { decide: true, note: '0.62 — сузить угол', resolution } });
  return a;
};

test('нерешённый DECIDE требует блокера', () => {
  assert.match(problems(withDecide(null)), /требует решения, а решения нет/);
  assert.match(problems(withDecide(null)), /blocker должен быть true — не записано решение по: market/);
});

test('решение без автора, основания или даты решением не считается', () => {
  const full = { text: 'сузили угол', owner: 'редактор Ирина', evidence: 'https://kontur.ru/market/x', resolvedAt: '2026-08-13' };
  for (const f of ['text', 'owner', 'evidence', 'resolvedAt']) {
    const r = { ...full }; delete r[f];
    assert.match(problems(withDecide(r)), new RegExp(`нет ${f}`), `поле ${f} не проверяется`);
  }
});

test('записанное решение закрывает DECIDE', () => {
  const a = withDecide({
    text: 'угол сужен до розницы, ссылка на Маркет добавлена в лид',
    owner: 'редактор Ирина',
    evidence: 'https://kontur.ru/market/spravka/1-x',
    resolvedAt: '2026-08-13',
  });
  assert.deepEqual(checkAnalysis(a), []);
});

/* ── связка: оценка против настоящего текста ───────────────────────── */

const ARTICLE = `---\ntitle: "Т"\ndraft: true\n---\n\nПродавец не обязан применять кассу.\n`;

function withRepo(fn, { article = ARTICLE, analysis } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'analysis-bundle-')));
  mkdirSync(join(dir, 'src/content/blog'), { recursive: true });
  mkdirSync(join(dir, 'src/data/analyze'), { recursive: true });
  writeFileSync(join(dir, 'src/content/blog', 'a.md'), article);
  const rec = analysis ?? {
    ...good({ slug: 'a' }),
    checkedAt: new Date().toISOString().slice(0, 10),
    articleHash: articleHash(article),
    articleNormHash: articleNormHash(article),
  };
  writeFileSync(join(dir, 'src/data/analyze', 'a.json'), JSON.stringify(rec));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('оценка сходится с текстом — связка зелёная', () => {
  withRepo((dir) => {
    const r = validateAnalysisBundle({ root: dir, slug: 'a', articleRaw: ARTICLE });
    assert.equal(r.ok, true, JSON.stringify(r.problems));
  });
});

test('смысловая правка отменяет оценку', () => {
  withRepo((dir) => {
    const edited = ARTICLE.replace('не обязан', 'обязан');
    const r = validateAnalysisBundle({ root: dir, slug: 'a', articleRaw: edited });
    assert.ok(r.problems.some((p) => p.code === 'semantic-drift'), JSON.stringify(r.problems));
  });
});

test('снятие draft оценку не отменяет: правка косметическая', () => {
  withRepo((dir) => {
    const released = ARTICLE.replace('draft: true', 'draft: false');
    const r = validateAnalysisBundle({ root: dir, slug: 'a', articleRaw: released });
    assert.ok(!r.problems.some((p) => p.code === 'semantic-drift'), JSON.stringify(r.problems));
  });
});

test('оценки нет вовсе — отдельная причина', () => {
  withRepo((dir) => {
    rmSync(join(dir, 'src/data/analyze', 'a.json'));
    const r = validateAnalysisBundle({ root: dir, slug: 'a', articleRaw: ARTICLE });
    assert.equal(r.problems[0].code, 'no-analysis');
  });
});

/* ── F-03: матрица по задаче статьи ────────────────────────────────── */

test('каждая задача имеет матрицу, и она непустая', () => {
  assert.ok(INTENTS.length >= 4, 'матриц меньше, чем типов работы из аудита');
  for (const [intent, m] of Object.entries(INTENT_MATRICES)) {
    assert.ok(m.title, `${intent}: нет названия`);
    assert.ok(Object.keys(m.checks).length >= 3, `${intent}: матрица из ${Object.keys(m.checks).length} пунктов`);
    for (const [k, what] of Object.entries(m.checks)) {
      assert.equal(typeof what, 'string', `${intent}.${k}: пункт без формулировки`);
    }
  }
});

test('оценка без задачи статьи не принимается', () => {
  const a = good();
  delete a.intent;
  assert.match(problems(a), /intent «нет» не из списка/);
});

test('незнакомая задача — ошибка', () => {
  assert.match(problems(good({ intent: 'лонгрид' })), /не из списка/);
});

test('пункт матрицы нельзя пропустить', () => {
  const a = good();
  delete a.intentChecks.verification;
  assert.match(problems(a), /нет пункта «verification»/);
});

test('чужой пункт в матрице — ошибка', () => {
  const a = good({ intentChecks: { ...intentChecks(), 'norm-cited': { ok: true } } });
  assert.match(problems(a), /«norm-cited» не из матрицы «instruction»/);
});

/* Ровно то, ради чего матрицы и заводились: инструкция без «что делать,
 * если шаг не сработал» по числу слов и секций выглядит отлично. */
test('невыполненный пункт матрицы — блокер, а не минус балл', () => {
  const a = good({
    intentChecks: intentChecks('instruction', {
      'failure-modes': { ok: false, note: 'при отказе кассы сказано «обратитесь в поддержку», без разбора' },
    }),
  });
  assert.match(problems(a), /blocker должен быть true — задача статьи не выполнена: failure-modes/);

  a.blocker = true;
  assert.deepEqual(checkAnalysis(a), []);
});

test('невыполненный пункт обязан объяснять, что именно не так', () => {
  const a = good({
    blocker: true,
    intentChecks: intentChecks('instruction', { verification: { ok: false } }),
  });
  assert.match(problems(a), /не сказано что именно/);
});

test('матрицы разные: пункт сравнения не годится для разбора ошибок', () => {
  const a = good({ intent: 'troubleshooting', intentChecks: intentChecks('comparison') });
  const p = problems(a);
  assert.match(p, /не из матрицы «troubleshooting»/);
  assert.match(p, /нет пункта «symptom-first»/);
});
