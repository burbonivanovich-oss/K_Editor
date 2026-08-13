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
];

/** Порог допуска. 70 не отсекал ничего при разбросе 84–100. */
export const PASS = 85;

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

export function checkAnalysis(a, name = 'оценка') {
  const problems = [];
  const add = (p) => problems.push({ name, problem: p });

  if (!a || typeof a !== 'object') return [{ name, problem: 'запись не разбирается как объект' }];

  if (isLegacy(a)) {
    return [{
      name,
      legacy: true,
      problem: `оценка по старой шкале (балл ${a.score}) — переоценить: /analyze-article ${a.slug || ''}`.trim(),
    }];
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
  for (const key of REQUIRED_CHECKS) {
    const c = checks[key];
    if (!c) { add(`нет проверки «${key}»`); continue; }
    if (c.applicable === false) {
      if (!c.note) add(`проверка «${key}» помечена неприменимой без объяснения`);
      continue;
    }
    if (typeof c.ok !== 'boolean') add(`проверка «${key}»: ok должен быть true/false`);
    else if (!c.ok) failed.push(key);
  }

  const belowPass = Number.isFinite(Number(a.score)) && Number(a.score) < PASS;
  const mustBlock = failed.length > 0 || belowPass;
  if (mustBlock && a.blocker !== true) {
    const why = failed.length ? `упали проверки: ${failed.join(', ')}` : `балл ${a.score} ниже ${PASS}`;
    add(`blocker должен быть true — ${why}`);
  }
  if (!mustBlock && a.blocker === true && !a.blockerReason) {
    add('blocker: true без blockerReason — непонятно, что чинить');
  }

  if (!a.checkedAt) add('нет checkedAt');

  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
