#!/usr/bin/env node
/**
 * Проверка самой оценки — гейт на оценщика, а не на статью.
 *
 * 13.08.2026 четыре статьи подряд получили 99–100 из 100. Разбор показал,
 * что дело не в качестве текстов:
 *
 *   • «graph: 20/20» и рядом, в том же объекте, записанное замечание.
 *     Нарушение фиксировали и тут же прощали;
 *   • пять категорий по 20 дают 100, сверху шёл бонус до +10 с потолком
 *     100 — статья с реальными 90 показывала 100;
 *   • критерий «pillar ссылается на статью» при отсутствии опорного
 *     материала нормировался ×20/16, то есть «мы это не проверяем»
 *     превращалось в «проверено, полный балл». Pillar есть у 5 кластеров
 *     из 25 — значит для 80 % статей балл раздувался;
 *   • блокер стоял на < 70 при реальном разбросе 84–100 и не сработал ни
 *     разу.
 *
 * Общая причина у всех четырёх: оценку выставляла та же сессия, которая
 * писала статью, по рубрике, лежавшей у неё перед глазами во время
 * письма. Рубрика работала как ТЗ, а не как проверка.
 *
 * Отсюда устройство: то, что проверяется скриптом, баллов не приносит
 * вообще — это pass/fail в `checks`. Баллы остаются только там, где
 * скрипт бессилен: лид, структура, язык, польза. А арифметику оценки
 * проверяет этот скрипт, потому что «замечание стоит балла» в виде
 * строчки инструкции — это то же самое обещание, которое уже нарушили.
 *
 * Главный инвариант: **баллы и замечания — одно и то же, записанное
 * двумя способами.** Есть замечания — балл ниже максимума. Балл ниже
 * максимума — есть замечания. Иначе либо нарушение простили, либо балл
 * сняли молча, и автор не знает, что чинить.
 *
 * Запуск:
 *   node scripts/check-analysis.mjs <slug>
 *   node scripts/check-analysis.mjs --all
 *
 * Коды: 0 — оценка оформлена честно, 1 — нарушения, 2 — файла нет.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isMain } from './lib/is-main.mjs';
import { articleNormHash } from './factcheck/hashes.mjs';

const ROOT = process.env.ANALYZE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'src/data/analyze');

/** Категории, за которые ставятся баллы. Только то, что не берёт скрипт. */
export const SOFT_CATEGORIES = {
  lead: { title: 'Лид', max: 25 },
  structure: { title: 'Структура', max: 25 },
  language: { title: 'Язык', max: 25 },
  usefulness: { title: 'Польза', max: 25 },
};

/** Обязательные детерминированные проверки. Баллов не приносят.
 *  Ровно то, что отдаёт `gates.mjs --json`: список один, копий нет. */
export const REQUIRED_CHECKS = [
  'frontmatter', 'words', 'internalLinks',
  'seo', 'ai', 'links', 'npa', 'factcheck', 'duplication', 'market', 'graph', 'pillar',
  /* Второй проход аудита (J-02, J-03): согласованность статьи с корпусом
   * и плановая дата проверки. Обе смотрят наружу — на другие статьи и на
   * календарь событий, — и поэтому не выводятся из текста самой статьи. */
  'corpus', 'freshness', 'contract', 'editorial',
];

/** Порог допуска. 70 не отсекал ничего при разбросе 84–100. */
export const PASS = 85;

/** Версия контракта записи оценки. */
export const ANALYSIS_SCHEMA_VERSION = 2;

/**
 * Вес замечания. Раньше веса не было вовсе: невыполненное обещание
 * заголовка и лишняя оговорка стоили одинаково — по баллу. Статья,
 * которая обещает инструкцию и её не даёт, набирала 96 и уходила в
 * выпуск.
 */
export const ISSUE_SEVERITIES = ['blocker', 'major', 'minor'];

/**
 * Замечания, которые не бывают «минус балл».
 *
 * `title-promise` — заголовок обещает то, чего в тексте нет;
 * `unproven-instruction` — инструкция без основания: шаги есть, а
 *   откуда они взялись, не сказано;
 * `intent-mismatch` — статья отвечает не на тот запрос, ради которого
 *   её ставили в план.
 *
 * Каждое означает, что читатель не получит обещанного. Балл тут не
 * шкала, а способ не называть вещи своими именами.
 */
export const BLOCKING_ISSUE_KINDS = ['title-promise', 'unproven-instruction', 'intent-mismatch'];

/**
 * Матрицы по задаче статьи (F-03).
 *
 * Одна рубрика на всё оценивала форму: объём, число секций, наличие FAQ.
 * Форма у инструкции, правового обзора, сравнения и разбора ошибок
 * одинаковая, а работа — разная: инструкция без «что делать, если шаг не
 * сработал» бесполезна ровно так же, как сравнение без критериев, — но
 * по числу слов и секций обе выглядят отлично.
 *
 * Матрица — это не баллы, а вопросы, на которые обязан быть ответ у
 * статьи именно этой задачи. Невыполненный пункт — блокер класса
 * «несоответствие задаче», а не минус балл: читатель не получил того,
 * зачем пришёл.
 *
 * Список закрытый: непонятно, какая это задача, — значит непонятно, что
 * от статьи требовалось.
 */
export const INTENT_MATRICES = {
  instruction: {
    title: 'Инструкция',
    checks: {
      'steps-ordered': 'шаги идут в порядке действий читателя, а не в логике предмета',
      preconditions: 'сказано, что нужно иметь до начала',
      'failure-modes': 'для шагов, которые срываются, сказано что делать',
      verification: 'понятно, как убедиться, что получилось',
    },
  },
  'legal-review': {
    title: 'Правовой обзор',
    checks: {
      'norm-cited': 'у каждого требования названа норма',
      'effective-dates': 'сказано, с какой даты требование действует',
      'who-applies': 'сказано, на кого распространяется, а на кого нет',
      consequences: 'названо, что бывает за нарушение',
    },
  },
  comparison: {
    title: 'Сравнение',
    checks: {
      'criteria-stated': 'критерии сравнения названы до сравнения',
      'same-basis': 'все варианты разобраны по одним и тем же критериям',
      'verdict-conditional': 'вывод в форме «кому что подходит», а не «лучший вариант»',
      'no-hidden-winner': 'нет варианта, который выигрывает за счёт умолчаний',
    },
  },
  troubleshooting: {
    title: 'Разбор ошибок',
    checks: {
      'symptom-first': 'вход по симптому, который читатель видит, а не по устройству системы',
      'cause-per-symptom': 'у каждого симптома названа причина',
      'fix-verifiable': 'после исправления понятно, что именно помогло',
      escalation: 'сказано, что делать, если не помогло',
    },
  },
  explainer: {
    title: 'Объяснение',
    checks: {
      'definition-first': 'определение в первых абзацах, а не после подводки',
      boundaries: 'сказано, чем предмет не является и где границы',
      'why-now': 'сказано, почему это важно читателю сейчас',
      'next-step': 'сказано, что делать дальше',
    },
  },
};

export const INTENTS = Object.keys(INTENT_MATRICES);

/** Поля замечания. Закрытый список — по той же причине, что и в отчёте факчека. */
const ISSUE_FIELDS = new Set(['text', 'kind', 'severity', 'span']);

/** Поля решения по DECIDE-проверке. */
const RESOLUTION_FIELDS = new Set(['text', 'owner', 'evidence', 'resolvedAt']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Замечание в разобранном виде: строка — это устаревшая форма. */
export function normalizeIssue(raw) {
  if (typeof raw === 'string') return { text: raw, severity: 'minor', legacy: true };
  if (raw && typeof raw === 'object') return { severity: 'minor', ...raw };
  return null;
}

/** Замечание, которое обязано поднимать блокер. */
export const isBlockingIssue = (i) =>
  i?.severity === 'blocker' || BLOCKING_ISSUE_KINDS.includes(i?.kind);

/**
 * Решение по проверке со статусом «требует решения» — записанное, а не
 * подразумеваемое: что решили, кто, на каком основании и когда.
 */
export function resolutionProblems(key, r) {
  if (!r || typeof r !== 'object') return [`проверка «${key}»: требует решения, а решения нет — release такое не выпускает`];
  const out = [];
  for (const f of Object.keys(r)) {
    if (!RESOLUTION_FIELDS.has(f)) out.push(`решение по «${key}»: неизвестное поле «${f}»`);
  }
  for (const [f, why] of [
    ['text', 'что решили'],
    ['owner', 'кто решил — решение без автора это не решение'],
    ['evidence', 'на каком основании'],
    ['resolvedAt', 'когда'],
  ]) {
    if (!String(r[f] ?? '').trim()) out.push(`решение по «${key}»: нет ${f} — ${why}`);
  }
  if (r.resolvedAt && !ISO_DATE.test(String(r.resolvedAt))) {
    out.push(`решение по «${key}»: resolvedAt не в формате ГГГГ-ММ-ДД`);
  }
  return out;
}

/** Значения, которых в записи быть не должно: следы старой шкалы. */
const FORBIDDEN_KEYS = ['ai_citation', 'bonus'];

/**
 * Оценка по старой шкале — до переделки 13.08.2026.
 *
 * Такие записи не «нечестно оформлены», их просто не с чем сравнивать:
 * там пять категорий по 20 плюс бонус, потолок 100 и нормировка
 * отсутствующего pillar в плюс. Балл 100 в старой записи и 100 в новой —
 * разные числа. Отличаем явно, чтобы отчёт говорил «переоценить», а не
 * «почини арифметику»: чинить там нечего, шкала другая.
 */
export function isLegacy(a) {
  const cats = a?.categories || {};
  const oldKeys = ['quality', 'seo', 'eeat', 'graph', 'tech', 'ai_citation'];
  const hasOld = oldKeys.some((k) => k in cats);
  const hasNew = Object.keys(SOFT_CATEGORIES).some((k) => k in cats);
  return hasOld && !hasNew;
}

/**
 * @param {object} a — запись оценки.
 * @param {string} name
 * @param {{requireVersioned?: boolean}} [opts] — требовать поля контракта
 *   (версия схемы, версия рубрики, привязка к тексту статьи). Выключается
 *   только там, где заведомо разбирается запись прежнего образца.
 */
export function checkAnalysis(a, name = 'оценка', { requireVersioned = true } = {}) {
  const problems = [];
  const add = (p) => problems.push({ name, problem: p });
  const blockingIssues = [];
  const intentFailed = [];
  const versioned = requireVersioned;

  if (!a || typeof a !== 'object') return [{ name, problem: 'запись не разбирается как объект' }];

  if (isLegacy(a)) {
    return [{
      name,
      legacy: true,
      problem: `оценка по старой шкале (балл ${a.score}) — переоценить: /analyze-article ${a.slug || ''}`.trim(),
    }];
  }

  /* Контракт записи (E-01). Оценка без привязки к версии текста и
   * рубрики переживает изменение статьи: балл остаётся, а относится он
   * к другому тексту. Раньше проверялась только арифметика. */
  if (versioned) {
    if (a.analysisSchemaVersion !== ANALYSIS_SCHEMA_VERSION) {
      add(`analysisSchemaVersion ${a.analysisSchemaVersion ?? 'нет'} — контракт ${ANALYSIS_SCHEMA_VERSION}, оценку нужно пересобрать`);
    }
    for (const [f, why] of [
      ['articleHash', 'к какой версии текста относится балл'],
      ['articleNormHash', 'смысловой отпечаток текста: косметическая правка оценку не отменяет, смысловая — отменяет'],
      ['rubricVersion', 'по какой версии рубрики оценивали'],
    ]) {
      if (!a[f]) add(`нет поля ${f} — ${why}`);
    }
  }

  /* Задача статьи и её матрица (F-03). */
  if (versioned) {
    if (!INTENTS.includes(a.intent)) {
      add(`intent «${a.intent ?? 'нет'}» не из списка: ${INTENTS.join(', ')} — непонятно, что от статьи требовалось`);
    } else {
      const need = INTENT_MATRICES[a.intent].checks;
      const got = a.intentChecks || {};
      for (const k of Object.keys(got)) {
        if (!(k in need)) add(`intentChecks: «${k}» не из матрицы «${a.intent}»`);
      }
      for (const [k, what] of Object.entries(need)) {
        const c = got[k];
        if (!c || typeof c !== 'object') { add(`intentChecks: нет пункта «${k}» (${what})`); continue; }
        if (typeof c.ok !== 'boolean') { add(`intentChecks «${k}»: ok должен быть true/false`); continue; }
        if (!c.ok) {
          if (!String(c.note ?? '').trim()) add(`intentChecks «${k}»: не выполнено, но не сказано что именно`);
          intentFailed.push(k);
        }
      }
    }
  }

  /* Бонус убран. Он был не наградой, а способом спрятать десятку
   * дефицита: пять категорий уже давали 100, а бонус упирался в тот же
   * потолок. Если он снова появится — это возврат к сломанной шкале. */
  for (const k of FORBIDDEN_KEYS) {
    if (k in (a.categories || {}) || k in a) add(`«${k}» — след старой шкалы, бонусных баллов больше нет`);
  }

  const cats = a.categories || {};
  for (const [key, def] of Object.entries(SOFT_CATEGORIES)) {
    const c = cats[key];
    if (!c) { add(`нет категории «${def.title}» (${key})`); continue; }
    const score = Number(c.score);
    const issues = Array.isArray(c.issues) ? c.issues : null;
    if (!Number.isInteger(score) || score < 0 || score > def.max) {
      add(`${def.title}: балл «${c.score}» вне 0–${def.max}`);
      continue;
    }
    if (!issues) { add(`${def.title}: нет списка issues`); continue; }

    /* Форма замечания. Строка — устаревший вид: по ней не видно ни
     * веса, ни места в тексте, и «заголовок обещает инструкцию, а её
     * нет» выглядит так же, как «лишняя оговорка». */
    for (const [i, rawIssue] of issues.entries()) {
      const issue = normalizeIssue(rawIssue);
      const where = `${def.title}, замечание ${i + 1}`;
      if (!issue) { add(`${where}: не разбирается`); continue; }
      if (issue.legacy) {
        if (versioned) add(`${where}: записано строкой — нужен объект {text, severity, kind?, span?}`);
        continue;
      }
      for (const f of Object.keys(issue)) {
        if (!ISSUE_FIELDS.has(f)) add(`${where}: неизвестное поле «${f}»`);
      }
      if (!String(issue.text ?? '').trim()) add(`${where}: нет text`);
      if (!ISSUE_SEVERITIES.includes(issue.severity)) {
        add(`${where}: severity «${issue.severity ?? 'нет'}» не из списка: ${ISSUE_SEVERITIES.join(', ')}`);
      }
      if (issue.kind !== undefined && !BLOCKING_ISSUE_KINDS.includes(issue.kind)) {
        add(`${where}: kind «${issue.kind}» не из списка: ${BLOCKING_ISSUE_KINDS.join(', ')}`);
      }
      /* Блокирующее замечание обязано указывать на место: «статья не
       * отвечает на запрос» без строки — это спор, а не правка. */
      if (isBlockingIssue(issue)) {
        blockingIssues.push(`${where}: ${issue.kind ?? issue.severity}`);
        const span = issue.span;
        if (!span || typeof span !== 'object' || !Number.isFinite(Number(span.line))) {
          add(`${where}: замечание блокирующее, но не указано место (span.line)`);
        }
      }
    }

    // Инвариант в обе стороны — см. шапку файла.
    if (issues.length && score === def.max) {
      add(`${def.title}: ${def.max}/${def.max}, но записано замечаний ${issues.length} — нарушение простили`);
    }
    if (issues.length && score > def.max - issues.length) {
      add(`${def.title}: ${issues.length} замечаний, но снято только ${def.max - score} — каждое стоит хотя бы балла`);
    }
    if (!issues.length && score < def.max) {
      add(`${def.title}: снято ${def.max - score}, но ни одного замечания не записано — автор не узнает, что чинить`);
    }
  }

  // Лишние категории: значит, в оценку вернули то, что должно быть проверкой.
  for (const key of Object.keys(cats)) {
    if (!SOFT_CATEGORIES[key] && !FORBIDDEN_KEYS.includes(key)) {
      add(`категория «${key}» лишняя — баллы ставятся только за ${Object.keys(SOFT_CATEGORIES).join(', ')}`);
    }
  }

  const maxScore = Object.values(SOFT_CATEGORIES).reduce((s, d) => s + d.max, 0);
  const sum = Object.keys(SOFT_CATEGORIES).reduce((s, k) => s + (Number(cats[k]?.score) || 0), 0);
  if (Number(a.score) !== sum) add(`score ${a.score} не равен сумме категорий ${sum}`);
  if ('maxScore' in a && Number(a.maxScore) !== maxScore) add(`maxScore ${a.maxScore}, ожидается ${maxScore}`);

  /* Проверки. Неприменимая проверка — законное состояние (у кластера нет
   * опорного материала), но она не приносит баллов и не прощает провал:
   * раньше именно этот случай нормировался в плюс. */
  const checks = a.checks || {};
  let failed = [];
  const unresolved = [];
  for (const key of REQUIRED_CHECKS) {
    const c = checks[key];
    if (!c) { add(`нет проверки «${key}»`); continue; }
    if (c.applicable === false) {
      if (!c.note) add(`проверка «${key}» помечена неприменимой без объяснения`);
      continue;
    }
    /* «Требует решения» — не зелёное и не красное, а третье состояние
     * (E-02). Раньше оно приезжало в оценку как ok: true, и «сузить
     * угол и добавить источник» числилось пройденной проверкой. */
    if (c.decide === true) {
      const rp = resolutionProblems(key, c.resolution);
      if (rp.length) { rp.forEach(add); unresolved.push(key); }
      continue;
    }
    if (typeof c.ok !== 'boolean') add(`проверка «${key}»: ok должен быть true/false`);
    else if (!c.ok) failed.push(key);
  }

  const belowPass = Number.isFinite(Number(a.score)) && Number(a.score) < PASS;
  /* Невыполненный пункт матрицы — это «несоответствие задаче»: статья
   * не сделала того, зачем её ставили в план. Балл тут не шкала. */
  const mustBlock = failed.length > 0 || belowPass || unresolved.length > 0
    || blockingIssues.length > 0 || intentFailed.length > 0;
  if (mustBlock && a.blocker !== true) {
    const why = failed.length ? `упали проверки: ${failed.join(', ')}`
      : unresolved.length ? `не записано решение по: ${unresolved.join(', ')}`
      : blockingIssues.length ? `блокирующие замечания: ${blockingIssues.join('; ')}`
      : intentFailed.length ? `задача статьи не выполнена: ${intentFailed.join(', ')}`
      : `балл ${a.score} ниже ${PASS}`;
    add(`blocker должен быть true — ${why}`);
  }
  if (!mustBlock && a.blocker === true && !a.blockerReason) {
    add('blocker: true без blockerReason — непонятно, что чинить');
  }

  if (!a.checkedAt) add('нет checkedAt');

  return problems;
}

/**
 * Оценка как связка «запись + версия текста + версия рубрики».
 *
 * Тот же приём, что и с факчеком: доверять можно не утверждению о
 * проверке, а тому, что перепроверяется на месте. Раньше release эту
 * функцию не звал вовсе, и старая оценка спокойно переживала изменение
 * текста — балл оставался, а относился он к другой статье.
 *
 * @param {{root: string, slug: string, articleRaw: string, staleDays?: number|null}} opts
 * @returns {{ok: boolean, analysis: object|null, problems: Array<{code, message}>}}
 */
export function validateAnalysisBundle({ root, slug, articleRaw, staleDays = 30 }) {
  const problems = [];
  const add = (code, message) => problems.push({ code, message });
  const path = join(root, 'src/data/analyze', `${slug}.json`);

  if (!existsSync(path)) {
    add('no-analysis', `нет src/data/analyze/${slug}.json — запустить /analyze-article ${slug}`);
    return { ok: false, analysis: null, problems };
  }

  let a;
  try { a = JSON.parse(readFileSync(path, 'utf8')); } catch {
    add('broken', `src/data/analyze/${slug}.json повреждён`);
    return { ok: false, analysis: null, problems };
  }

  const out = () => ({ ok: problems.length === 0, analysis: a, problems });

  if (isLegacy(a)) {
    /* Балл по старой шкале выглядит проходным (там 100 набиралось с
     * бонусом и нормировкой), но означает не то же самое. */
    add('legacy', `оценка по старой шкале (${a.score}) — переоценить: /analyze-article ${slug}`);
    return out();
  }

  const age = ageDays(a.checkedAt);
  if (staleDays !== null && (age === null || age > staleDays)) {
    add('stale', `оценка устарела (${age ?? '?'} дн.) — перезапустить /analyze-article ${slug}`);
  }

  /* Привязка к тексту. Точный хеш ловит любую правку, включая снятие
   * draft самим релизом; смысловой — только ту, после которой оценка
   * относится к другому тексту. */
  if (!a.articleNormHash) {
    add('no-article-hash', 'оценка не привязана к версии текста (нет articleNormHash) — сделана по старому контракту');
  } else if (a.articleNormHash !== articleNormHash(articleRaw)) {
    add('semantic-drift', 'статья менялась по существу после оценки — балл относится к другой версии текста');
  }

  const rubric = currentRubricVersion(root);
  if (rubric && a.rubricVersion && a.rubricVersion < rubric) {
    add('rubric-changed', `оценка по рубрике от ${a.rubricVersion}, текущая — ${rubric}: переоценить`);
  }

  for (const p of checkAnalysis(a, `analyze/${slug}.json`)) {
    add(p.legacy ? 'legacy' : 'malformed', p.problem);
  }

  if (a.blocker === true) {
    add('blocker', `оценка с блокером: ${a.blockerReason || 'причина не записана'}`);
  }
  const score = Number(a.score);
  if (Number.isFinite(score) && score < PASS) {
    add('below-pass', `${score}/100 при пороге ${PASS}`);
  }

  return out();
}

const ageDays = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
};

/** Версия рубрики — дата последнего изменения инструкции по git. */
export function currentRubricVersion(root) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%as', '--', RUBRIC_PATH], { encoding: 'utf8', cwd: root }).trim() || null;
  } catch {
    return null;
  }
}

export const RUBRIC_PATH = '.claude/commands/analyze-article.md';

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  let files;
  if (args.includes('--all')) {
    files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => join(DIR, f)) : [];
    if (!files.length) { console.log('Оценок нет — проверять нечего.'); process.exit(0); }
  } else {
    const slug = args.find((x) => !x.startsWith('--'));
    if (!slug) { console.error('Использование: check-analysis.mjs <slug> | --all'); process.exit(2); }
    const p = slug.endsWith('.json') ? slug : join(DIR, `${slug}.json`);
    if (!existsSync(p)) { console.error(`✖ Нет ${p}`); process.exit(2); }
    files = [p];
  }

  let total = 0;
  for (const f of files) {
    let data;
    try { data = JSON.parse(readFileSync(f, 'utf8')); } catch (e) {
      console.log(`✖ ${basename(f)} — не разбирается: ${e.message}`);
      total++;
      continue;
    }
    const problems = checkAnalysis(data, basename(f));
    if (!problems.length) {
      console.log(`✓ ${basename(f)} — ${data.score}/100${data.blocker ? ' (блокер)' : ''}`);
      continue;
    }
    total += problems.length;
    const legacy = problems.some((p) => p.legacy);
    console.log(`${legacy ? '⟳' : '✖'} ${basename(f)}${legacy ? '' : ` — ${problems.length}:`}`);
    for (const p of problems) console.log(`    ${p.problem}`);
  }
  process.exit(total ? 1 : 0);
}
