#!/usr/bin/env node
// Финальный шлюз перед снятием draft — детерминированная реализация
// /release-article. Раньше это был Markdown-протокол для агента: пять
// проверок, которые легко воспроизвести чуть иначе от прогона к прогону
// или пропустить один шаг под спешку. Здесь — одна команда, один и тот
// же порядок проверок, и снятие draft происходит только если реально
// прошли все.
//
// Не подменяет решения, которые требуют суждения: если /analyze-article
// не прогонялся или устарел, скрипт не запускает его сам — это шаг
// агента, здесь только блокер с понятной причиной.
//
// Использование:
//   node scripts/release-article.mjs <slug>
//   node scripts/release-article.mjs <slug> --json
//   node scripts/release-article.mjs <slug> --dry-run       # только отчёт, файл не трогать
//   node scripts/release-article.mjs <slug> --confirm-no-cycle "<причина>"
//     # темы нет в editorial-cycle.json (написана вне цикла) — явное
//     # подтверждение, что вычитка человеком всё равно была; причина
//     # записывается в src/data/analyze/<slug>.json.cycleReleaseOverride
//   node scripts/release-article.mjs <slug> --override-score "<причина>"
//     # редактор принимает статью с баллом /analyze-article ниже порога —
//     # решение записывается в src/data/analyze/<slug>.json.releaseOverride,
//     # остальные гейты (НПА, ссылки, SEO P0, AI-маркеры, факчек-хеш)
//     # override не снимает — это единственный канонический путь
//     # снять draft, включая случай осознанного отступления от балла
//
// Выход: 0 — выпущена (или уже была draft: false), 1 — заблокирована.

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
/* Порог допуска берём из check-analysis.mjs, а не зашиваем вторым числом:
 * два места с одним порогом расходятся ровно тогда, когда порог меняют.
 * 70 не отсекал ничего при реальном разбросе 84–100 — шлюза не было
 * вовсе; подняли до 85 вместе с переделкой шкалы 13.08.2026. */
import { validateAnalysisBundle } from './check-analysis.mjs';
import { validateFactcheckBundle } from './factcheck/validate-bundle.mjs';
import { reviewDateFor } from './factcheck/review-date.mjs';
import { GATE_CHECKS, FAIL as GATE_FAIL, DECIDE as GATE_DECIDE } from './gates.mjs';

// Гейт-скрипты (audit-npa-references.mjs и т. п.) — реальные, всегда из
// настоящего репозитория, не из тестовой фикстуры: у них своих оверрайдов
// путей нет. DATA_ROOT — где лежит статья/маркер/анализ/состояние цикла,
// подменяется в тестах.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_ROOT = process.env.RELEASE_DATA_ROOT || REPO_ROOT;
const BLOG_DIR = join(DATA_ROOT, 'src/content/blog');
const MARKERS_DIR = join(DATA_ROOT, '.claude/factchecked');
const ANALYZE_DIR = join(DATA_ROOT, 'src/data/analyze');
const CYCLE_STATE_PATH = process.env.CYCLE_STATE_PATH || join(DATA_ROOT, 'src/data/editorial-cycle.json');

const ANALYZE_STALE_DAYS = 30;
const FACTCHECK_STALE_DAYS = 180;

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const AS_JSON = args.includes('--json');
const DRY_RUN = args.includes('--dry-run');
const CONFIRM_NO_CYCLE_IDX = args.indexOf('--confirm-no-cycle');
const CONFIRM_NO_CYCLE = CONFIRM_NO_CYCLE_IDX !== -1;
// Причина обязательна по той же логике, что у --override-score: это
// исключение из канонического пути (тема не была в редакторском
// цикле), и health-check (F-05) должен уметь отличить записанное
// исключение от статьи, которую кто-то выпустил в обход скрипта
// вообще — а для этого исключение обязано где-то остаться, не только
// мелькнуть в консоли текущего запуска.
const CONFIRM_NO_CYCLE_REASON = CONFIRM_NO_CYCLE ? args[CONFIRM_NO_CYCLE_IDX + 1] : null;
if (CONFIRM_NO_CYCLE && (!CONFIRM_NO_CYCLE_REASON || CONFIRM_NO_CYCLE_REASON.startsWith('--'))) {
  console.error('--confirm-no-cycle требует причину: --confirm-no-cycle "<почему тема вне цикла, но вычитка была>"');
  process.exit(2);
}

// Редактор может принять статью с баллом ниже 70 — это решение
// человека, не техническая ошибка (docs/tools.md: «/analyze-article —
// не публиковать статью с баллом ниже порога без явного решения»,
// не «никогда»). Раньше единственный способ был обойти весь release-
// article.mjs целиком (см. cycle-listen.md, шаг 5 — прямая правка
// draft:false в обход этого скрипта: то самое расхождение путей
// выпуска из внешнего ревью). Здесь — то же самое решение, но через
// тот же CLI и с обязательной причиной, записанной в audit-trail
// (src/data/analyze/<slug>.json), а не молча.
const OVERRIDE_SCORE_IDX = args.indexOf('--override-score');
const OVERRIDE_SCORE_REASON = OVERRIDE_SCORE_IDX !== -1 ? args[OVERRIDE_SCORE_IDX + 1] : null;
if (OVERRIDE_SCORE_IDX !== -1 && (!OVERRIDE_SCORE_REASON || OVERRIDE_SCORE_REASON.startsWith('--'))) {
  console.error('--override-score требует причину: --override-score "<почему редактор принял балл ниже порога>"');
  process.exit(2);
}

if (!slug) {
  console.error(
    'Использование: node scripts/release-article.mjs <slug> [--json] [--dry-run] ' +
      '[--confirm-no-cycle "<причина>"] [--override-score "<причина>"]',
  );
  process.exit(2);
}

const ageDays = (iso, now = new Date()) => (iso ? Math.floor((now - new Date(iso)) / 86400000) : null);
const addMonths = (iso, n) => {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

function findArticlePath() {
  for (const ext of ['.md', '.mdx']) {
    const p = join(BLOG_DIR, `${slug}${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Читает значение простого ключа `key: value` из блока frontmatter. */
function getField(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*"?([^"#\\n]*)"?\\s*$`, 'm'));
  return m ? m[1].trim() : null;
}

/**
 * Заменяет значение ключа, если он есть, иначе вставляет новую строку
 * перед закрывающим ---. Булевы значения — без кавычек (draft: false,
 * не draft: "false"), остальное — в кавычках, как даты в шаблоне
 * docs/content-rules.md.
 */
function setField(fm, key, value) {
  const literal = value === 'true' || value === 'false' ? value : `"${value}"`;
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(fm)) return fm.replace(re, `${key}: ${literal}`);
  return `${fm.trimEnd()}\n${key}: ${literal}\n`;
}

/* Выпуск — четыре записи, и они не независимы.
 *
 * Снятый `draft` меняет хеш статьи, из-за чего маркер обязан быть
 * переписан; контент-план обязан узнать, что тема закрыта. Записи шли
 * подряд, и сбой на любой из них — нет места на диске, права, падение
 * дочернего процесса — оставлял корпус в состоянии, которого не бывает
 * при нормальной работе: статья выпущена, а маркер относится к прежнему
 * тексту, и следующий же прогон объявляет её сломанной. Хуже того,
 * править это приходится руками, зная, какие именно шаги успели пройти.
 *
 * Поэтому все записи выпуска идут через `tx`: он запоминает прежнее
 * содержимое каждого файла (или его отсутствие) и при первой же ошибке
 * возвращает всё как было. Частичного выпуска не остаётся — остаётся
 * невыпущенная статья и понятная ошибка.
 *
 * Атомарности файловой системы это не даёт и не претендует: между
 * записями возможен `kill -9`, и тогда откат не отработает. Защита от
 * ошибки в шаге, а не от выдёргивания питания. */
const tx = {
  saved: new Map(),
  write(path, content) {
    if (!this.saved.has(path)) {
      this.saved.set(path, existsSync(path) ? readFileSync(path, 'utf8') : null);
    }
    writeFileSync(path, content);
  },
  rollback() {
    const failed = [];
    for (const [path, before] of [...this.saved].reverse()) {
      try {
        if (before === null) rmSync(path, { force: true });
        else writeFileSync(path, before);
      } catch (e) { failed.push(`${path}: ${e.message}`); }
    }
    this.saved.clear();
    return failed;
  },
};

/**
 * F-02 (git-локальная синхронизация статуса). Если тема была в
 * контент-плане — переводит её строку в done. Не про Google Sheets:
 * тот путь остаётся за drive-sync.mjs/cycle-state.mjs, здесь нет
 * credentials и не должно быть. Возвращает null, если темы в плане
 * нет или она уже done — писать нечего.
 */
function syncContentPlanStatus(dataRoot, articleSlug) {
  const planPath = join(dataRoot, 'src/content/wiki/content-plan-2026.md');
  if (!existsSync(planPath)) return null;
  const shortSlug = articleSlug.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const escaped = shortSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rowRe = new RegExp(
    `^(\\|\\s*${escaped}\\s*\\|[^|]*\\|[^|]*\\|[^|]*\\|\\s*)(done|draft|planned|deprioritized)(\\s*\\|.*)$`,
    'm',
  );
  const text = readFileSync(planPath, 'utf8');
  const m = text.match(rowRe);
  if (!m || m[2] === 'done') return null;
  tx.write(planPath, text.replace(rowRe, '$1done$3'));

  // editorial-plan.json — производный артефакт. Регенерируем только в
  // реальном репозитории: generate-editorial-plan.mjs не умеет
  // override-путей и в тестовой фикстуре писал бы поверх настоящего
  // репозитория, а не DATA_ROOT теста.
  if (dataRoot === REPO_ROOT) {
    try {
      execFileSync('node', ['scripts/generate-editorial-plan.mjs'], { cwd: REPO_ROOT });
      return `${shortSlug}: planned/draft → done, editorial-plan.json перегенерирован`;
    } catch {
      return `${shortSlug}: planned/draft → done, editorial-plan.json перегенерировать не удалось — прогнать вручную`;
    }
  }
  return `${shortSlug}: planned/draft → done`;
}

// cwd по умолчанию REPO_ROOT (гейт-скрипты сами по себе, без RELEASE_
// DATA_ROOT, всегда смотрят в настоящий репозиторий) — но npa-audit и
// check-blog-links читают src/content/blog/ и src/data/factcheck/
// **относительно cwd**, у них своих оверрайдов путей нет (T-01: раньше
// это делало их нетестируемыми — тесты этого файла молча гоняли их по
// реальному репозиторию, а не по DATA_ROOT фикстуры). Абсолютный путь
// к скрипту — иначе смена cwd на DATA_ROOT сломает поиск самого файла.
function runGate(cmd, cmdArgs, cwd = REPO_ROOT, env = {}) {
  const absArgs = cmdArgs.map((a) => (a.startsWith('scripts/') ? join(REPO_ROOT, a) : a));
  try {
    const out = execFileSync(cmd, absArgs, { encoding: 'utf8', cwd, env: { ...process.env, ...env } });
    /* Пустой вывод при нулевом коде — отказ, а не успех. Гейт, который
     * не запустился, обязан выглядеть как упавший: девять чекеров с
     * битым main-guard именно так и проходили релиз — молча. */
    if (!String(out).trim()) {
      return { ok: false, silent: true, output: `✖ ${absArgs.join(' ')} завершился успехом, не напечатав ничего` };
    }
    return { ok: true, silent: false, output: out };
  } catch (e) {
    return { ok: false, silent: false, output: (e.stdout || '') + (e.stderr || '') };
  }
}

/* Причина блокировки. Молчащий гейт нельзя объяснять содержанием
 * статьи: причина не в тексте, а в том, что проверка не выполнялась. */
const gateReason = (r, reason) => (r.silent ? 'проверка не состоялась: скрипт ничего не вывел' : reason);

function lastGitModified(path) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%aI', '--', path], { encoding: 'utf8', cwd: DATA_ROOT }).trim();
    return out || null;
  } catch {
    return null;
  }
}

const findings = [];
const blockers = [];
let scoreOverride = null;
let cycleOverride = null;
function pass(name, detail = '') { findings.push({ status: 'ok', name, detail }); }
function block(name, detail) { findings.push({ status: 'fail', name, detail }); blockers.push(`${name}: ${detail}`); }
function note(name, detail = '') { findings.push({ status: 'info', name, detail }); }

// ── Шаг 1 — статья существует и ещё черновик ────────────────────────────

const articlePath = findArticlePath();
if (!articlePath) {
  report({ status: 'ERROR', reason: `нет статьи src/content/blog/${slug}.md` });
  process.exit(2);
}

const rawBefore = readFileSync(articlePath, 'utf8');
const fmMatch = rawBefore.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
if (!fmMatch) {
  report({ status: 'ERROR', reason: 'нет frontmatter' });
  process.exit(2);
}
const [, fmBlock, body] = fmMatch;

/* Уже опубликованная статья проходит те же гейты, а не возвращает
 * успех по факту снятого draft.
 *
 * Раньше здесь был выход с кодом 0 до единой проверки, и это делало
 * штатный выпуск через Google Docs дырой в гейте: инструкция рутины B
 * сама просила поставить draft: false при переносе тела из дока, после
 * чего release видел снятый флаг и отвечал ALREADY_RELEASED — не
 * проверив ни приёмку, ни НПА, ни ссылки, ни SEO, ни AI, ни оценку, ни
 * факчек. Порядок в инструкции исправлен (draft снимает только этот
 * скрипт), но полагаться на порядок нельзя: команда обязана отвечать
 * правду о статье, в каком бы состоянии её ни застали.
 *
 * Поэтому дальше идёт полный аудит. Разница только в конце: менять
 * файл нечего, снимать нечего — ответ либо ALREADY_RELEASED (всё
 * зелено), либо BLOCKED с перечнем того, что в опубликованной статье
 * не соответствует контракту. */
const ALREADY_PUBLISHED = getField(fmBlock, 'draft') === 'false';
if (ALREADY_PUBLISHED) note('Статус', 'статья уже опубликована — идёт полная проверка, а не выпуск');

// ── Шаг 2 — редактор принял статью ──────────────────────────────────────

let cycleTopic = null;
if (existsSync(CYCLE_STATE_PATH)) {
  try {
    const cycle = JSON.parse(readFileSync(CYCLE_STATE_PATH, 'utf8'));
    // Имя файла статьи — YYYY-MM-DD-<slug>, а cycle-state.mjs хранит тему
    // под голым slug без даты (он собирается транслитерацией заголовка ещё
    // до того, как известна дата публикации). Сравнение «в лоб» поэтому не
    // находило ни одну тему цикла, и гейт приёмки требовал
    // --confirm-no-cycle даже для статьи, которую редактор только что
    // принял в таблице. Сравниваем и с датой, и без неё.
    const bare = slug.replace(/^\d{4}-\d{2}-\d{2}-/, '');
    cycleTopic =
      (cycle.plan || []).find((t) => t.slug === slug || t.slug === bare) || null;
  } catch {
    /* повреждённый cycle-state — ниже трактуем как «темы нет в цикле» */
  }
}

if (cycleTopic) {
  /* У выпущенной темы статус released — его ставит `cycle-state release`
   * после успешного выпуска. Для проверки уже опубликованной статьи это
   * такой же признак пройденной приёмки, как accepted для черновика. */
  const accepted = cycleTopic.status === 'accepted'
    || (ALREADY_PUBLISHED && cycleTopic.status === 'released');
  if (accepted) {
    pass('Приёмка редактором', cycleTopic.status);
  } else {
    block('Приёмка редактором', `тема в статусе ${cycleTopic.status}, ожидался accepted`);
  }
} else if (CONFIRM_NO_CYCLE) {
  note('Приёмка редактором', `темы нет в цикле — подтверждено: ${CONFIRM_NO_CYCLE_REASON}`);
  cycleOverride = { reason: CONFIRM_NO_CYCLE_REASON, at: today() };
} else {
  block(
    'Приёмка редактором',
    'темы нет в editorial-cycle.json (написана вне цикла) — нужно явное подтверждение: --confirm-no-cycle "<причина>"',
  );
}

// ── Шаг 3 — гейты ────────────────────────────────────────────────────────

/* Гейты — тем же прогоном, что и везде, а не своим списком.
 *
 * Здесь стоял свой набор из четырёх проверок: НПА, ссылки, SEO,
 * AI-маркеры. Набор отставал от гейта и отставал молча: пока в
 * `gates.mjs` добавлялись согласованность корпуса, срок проверки,
 * контракт материала и редакционная проверка, релиз про них не знал и
 * выпускал статью, которую гейт краснил. Разъехаться двум спискам —
 * вопрос времени, и это уже произошло дважды.
 *
 * Теперь один вызов. Красное — блокер, независимо от того, какая
 * проверка покраснела: решать, какие из них «не считаются», значит
 * заводить тот же расходящийся список заново. */
/* Подпроцессом, а не вызовом в этом же процессе: `gates.mjs` берёт
 * корень из `GATES_ROOT` при загрузке модуля, и в чужом корне (тесты,
 * фикстуры, проверка другой копии) прямой вызов смотрел бы не туда.
 * Заодно работает общее правило: молчащий гейт — отказ. */
/* Корень передаём явно: `gates.mjs` читает `GATES_ROOT` при загрузке
 * модуля, и без него подпроцесс смотрел бы в живой репозиторий, а не
 * в тот, который проверяем. */
const gateRaw = runGate('node', ['scripts/gates.mjs', slug, '--json'], DATA_ROOT, { GATES_ROOT: DATA_ROOT });
let gateRun = null;
try { gateRun = JSON.parse(gateRaw.output); } catch { gateRun = null; }

if (!gateRun?.checks) {
  block('Гейты', gateRaw.silent
    ? 'проверка не состоялась: gates.mjs ничего не вывел'
    : `gates.mjs не дал разбора по ${slug}: ${String(gateRaw.output).slice(0, 160)}`);
} else {
  for (const [key, res] of Object.entries(gateRun.checks)) {
    const name = GATE_CHECKS[key] ?? key;
    if (res.ok === false) block(name, res.note || 'красное');
    else if (res.decide) note(name, res.note || 'требует решения редактора');
    else if (res.applicable !== false) pass(name, res.note || '');
  }
}

// ── Шаг 4 — оценка свежая и проходная ───────────────────────────────────

const analyzePath = join(ANALYZE_DIR, `${slug}.json`);

/* Раньше здесь читались четыре поля записи: возраст, старая шкала,
 * blocker и балл. Саму запись release не проверял — `check-analysis.mjs`
 * он не звал вообще, и оценка могла быть оформлена как угодно: замечание
 * без снятого балла, нерешённый DECIDE в виде пройденной проверки,
 * отсутствие привязки к версии текста. Теперь тот же валидатор, что и у
 * гейта на оценщика, плюс привязка к тексту и к версии рубрики (E-01) и
 * блокирующий нерешённый DECIDE (E-02). */
const analysisCheck = validateAnalysisBundle({
  root: DATA_ROOT, slug, articleRaw: rawBefore, staleDays: ANALYZE_STALE_DAYS,
});
const analysis = analysisCheck.analysis;

if (analysisCheck.ok) {
  pass('Оценка /analyze-article', `${analysis.score}/100 (проверена ${analysis.checkedAt})`);
} else {
  /* Балл и блокер — то, что редактор вправе переопределить своим
   * решением. Всё остальное — оформление оценки и её привязка к тексту
   * — не переопределяется: там нечего решать, там надо переоценить. */
  const overridable = new Set(['blocker', 'below-pass']);
  const hard = analysisCheck.problems.filter((p) => !overridable.has(p.code));
  const soft = analysisCheck.problems.filter((p) => overridable.has(p.code));

  for (const { message } of hard) block('Оценка /analyze-article', message);

  if (soft.length) {
    if (OVERRIDE_SCORE_REASON) {
      note('Оценка /analyze-article',
        `${soft.map((p) => p.message).join('; ')} — переопределено редактором: ${OVERRIDE_SCORE_REASON}`);
      scoreOverride = {
        reason: OVERRIDE_SCORE_REASON, score: analysis?.score,
        blocker: Boolean(analysis?.blocker), at: today(),
      };
    } else {
      block('Оценка /analyze-article',
        `${soft.map((p) => p.message).join('; ')} — форсировать может только редактор: --override-score "<причина>"`);
    }
  }
}

// ── Шаг 5 — фактчек не протух ────────────────────────────────────────────

const markerPath = join(MARKERS_DIR, slug);

/* Раньше здесь читались только hash, date и result — то есть релиз
 * верил утверждению маркера о проверке, а не самой проверке. Сильные
 * checkReport()/checkCoverage() звались лишь при создании маркера, и
 * все десять отчётов корпуса стояли passed, хотя текущий контракт
 * отвергает каждый. Теперь тот же валидатор, что у гейта: маркер,
 * отчёт, хеш, доказательства и покрытие — на месте, а не по памяти.
 *
 * Следствие, оно же цель (B-02 бэклога): маркер, сделанный по старому
 * контракту, релиз больше не проходит. Пока отчёты не мигрированы
 * (C-04), выпуск требует перепроверки — это осознанная временная
 * жёсткость, а не побочный эффект. */
const bundle = validateFactcheckBundle({
  root: DATA_ROOT, slug, articleRaw: rawBefore, staleDays: FACTCHECK_STALE_DAYS,
});
const marker = bundle.marker;
if (bundle.ok) {
  pass('Фактчек', `маркер от ${marker.date}, отчёт проходит текущий контракт`);
} else {
  for (const { code, message } of bundle.blocking) {
    const fix = code === 'hash-mismatch' || code === 'stale' || code === 'no-marker'
      ? ` — нужен /factcheck ${slug}`
      : '';
    block('Фактчек', `${message}${fix}`);
  }
}

// ── Шаг 6 — снятие черновика (только если ничего не заблокировано) ──────

if (blockers.length) {
  /* Уже опубликованная статья с блокерами — не «ничего не поделаешь», а
   * находка: контракту не соответствует текст, который читатели уже
   * видят. Отдельный флаг в отчёте, чтобы вызывающий отличал «выпуск не
   * состоялся» от «выпущенное не проходит проверку». */
  report({ status: 'BLOCKED', ...(ALREADY_PUBLISHED ? { alreadyReleased: true } : {}) });
  process.exit(1);
}

if (ALREADY_PUBLISHED) {
  report({ status: 'ALREADY_RELEASED', reason: `${slug} уже не черновик — все гейты проходит` });
  process.exit(0);
}

if (DRY_RUN) {
  report({ status: 'WOULD_RELEASE' });
  process.exit(0);
}

let fmAfter = setField(fmBlock, 'draft', 'false');

const pubDate = getField(fmBlock, 'pubDate');
const lastModified = lastGitModified(articlePath);
if (pubDate && lastModified && lastModified.slice(0, 10) > pubDate) {
  fmAfter = setField(fmAfter, 'updatedDate', today());
}

if (pubDate) {
  const existingReview = getField(fmBlock, 'reviewDate');
  const due = addMonths(pubDate, 6);
  /* Дата проверки считается той же функцией, что и в гейте свежести.
   *
   * Здесь стоял свой расчёт — «сегодня плюс шесть месяцев», — и он
   * расходился с гейтом: тот считает по ближайшему событию в тексте и
   * от даты публикации. Релиз ставил дату, которую гейт тут же
   * краснил. Два расчёта одного поля — это не дублирование, а
   * гарантированное расхождение. */
  const computed = reviewDateFor({
    pubDate: pubDate || today(),
    articleRaw: rawBefore,
    report: bundle?.report ?? null,
  });
  const reviewDate = !existingReview || existingReview > computed.date ? computed.date : existingReview;
  fmAfter = setField(fmAfter, 'reviewDate', reviewDate);
}

const newContent = `---\n${fmAfter.trim()}\n---\n${body}`;

let contentPlanSync = null;
try {
  tx.write(articlePath, newContent);

// Снятие draft (и, возможно, updatedDate/reviewDate) само меняет хеш
// статьи — тот самый хеш, который маркер только что подтвердил. Не
// обновить маркер здесь значит гарантированно сломать его при следующей
// же проверке (pre-commit guard, /analyze-article): факты не менялись,
// маркер лишь не знает о собственном флаге draft. `date` не трогаем —
// это дата, когда факты были реально проверены, не дата этого релиза.
  const newHash = createHash('sha256').update(newContent).digest('hex');
  tx.write(markerPath, JSON.stringify({ ...marker, hash: newHash }));

// Аудит-трейл переопределений — «кто, что и почему» из F-01/F-05. Живёт
// в src/data/analyze/<slug>.json, а не в отдельном логе: это уже
// коммитящийся, per-slug файл ровно про эту оценку. health-check.mjs
// читает cycleReleaseOverride, чтобы отличить записанное исключение
// (--confirm-no-cycle с причиной) от статьи, выпущенной в обход
// скрипта вообще — прямой правкой draft:false мимо release-article.mjs.
  if ((scoreOverride || cycleOverride) && existsSync(analyzePath)) {
    const analysis = JSON.parse(readFileSync(analyzePath, 'utf8'));
    if (scoreOverride) analysis.releaseOverride = scoreOverride;
    if (cycleOverride) analysis.cycleReleaseOverride = cycleOverride;
    tx.write(analyzePath, JSON.stringify(analysis, null, 2) + '\n');
  }

// F-02 (git-локальная часть — Google Sheets вне досягаемости этого
// скрипта). Без этого шага health-check (F-05) находит расхождение
// после каждого релиза темы, которая была в контент-плане: план
// показывает planned/draft, статья уже вышла. Лучше не дать
// расхождению случиться, чем полагаться только на то, что кто-то
// прочитает предупреждение.
  contentPlanSync = syncContentPlanStatus(DATA_ROOT, slug);
} catch (e) {
  const failed = tx.rollback();
  console.error(`\n✖ Выпуск прерван: ${e.message}`);
  if (failed.length) {
    console.error('  ОТКАТ НЕ ПОЛНЫЙ — эти файлы вернуть не удалось, проверьте руками:');
    for (const f of failed) console.error(`    ${f}`);
  } else {
    console.error('  Все записи выпуска откачены: статья осталась невыпущенной.');
  }
  report({ status: 'FAILED', error: e.message, rollbackFailed: failed });
  process.exit(1);
}
if (contentPlanSync) note('Контент-план', contentPlanSync);

report({ status: 'RELEASED' });
process.exit(0);

function report(extra) {
  if (AS_JSON) {
    console.log(JSON.stringify({ slug, findings, blockers, ...extra }, null, 2));
    return;
  }
  console.log('━'.repeat(40));
  console.log(`🚀 /release-article ${slug}`);
  console.log('━'.repeat(40));
  console.log('');
  for (const f of findings) {
    const icon = f.status === 'ok' ? '✓' : f.status === 'fail' ? '✗' : 'ℹ';
    console.log(`  ${icon} ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  console.log('');
  const status = extra.status;
  if (status === 'RELEASED') console.log('draft: true → false');
  else if (status === 'WOULD_RELEASE') console.log('(--dry-run) прошла бы все гейты — draft не менялся');
  else if (status === 'ALREADY_RELEASED') console.log(extra.reason);
  else if (status === 'BLOCKED') {
    console.log(extra.alreadyReleased
      ? 'УЖЕ ОПУБЛИКОВАНА И НЕ ПРОХОДИТ ПРОВЕРКУ — чинить текст, снимать нечего'
      : 'ЗАБЛОКИРОВАНА — draft не менялся');
  }
  else if (status === 'ERROR') console.log(extra.reason);
  console.log('━'.repeat(40));
}
