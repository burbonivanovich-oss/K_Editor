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
//     # редактор принимает статью с баллом /analyze-article < 70 —
//     # решение записывается в src/data/analyze/<slug>.json.releaseOverride,
//     # остальные гейты (НПА, ссылки, SEO P0, AI-маркеры, факчек-хеш)
//     # override не снимает — это единственный канонический путь
//     # снять draft, включая случай осознанного отступления от балла
//
// Выход: 0 — выпущена (или уже была draft: false), 1 — заблокирована.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// не публиковать статью с баллом < 70 без явного решения пользователя»,
// не «никогда»). Раньше единственный способ был обойти весь release-
// article.mjs целиком (см. cycle-listen.md, шаг 5 — прямая правка
// draft:false в обход этого скрипта: то самое расхождение путей
// выпуска из внешнего ревью). Здесь — то же самое решение, но через
// тот же CLI и с обязательной причиной, записанной в audit-trail
// (src/data/analyze/<slug>.json), а не молча.
const OVERRIDE_SCORE_IDX = args.indexOf('--override-score');
const OVERRIDE_SCORE_REASON = OVERRIDE_SCORE_IDX !== -1 ? args[OVERRIDE_SCORE_IDX + 1] : null;
if (OVERRIDE_SCORE_IDX !== -1 && (!OVERRIDE_SCORE_REASON || OVERRIDE_SCORE_REASON.startsWith('--'))) {
  console.error('--override-score требует причину: --override-score "<почему редактор принял балл ниже 70>"');
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
  writeFileSync(planPath, text.replace(rowRe, '$1done$3'));

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
function runGate(cmd, cmdArgs, cwd = REPO_ROOT) {
  const absArgs = cmdArgs.map((a) => (a.startsWith('scripts/') ? join(REPO_ROOT, a) : a));
  try {
    const out = execFileSync(cmd, absArgs, { encoding: 'utf8', cwd });
    return { ok: true, output: out };
  } catch (e) {
    return { ok: false, output: (e.stdout || '') + (e.stderr || '') };
  }
}

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

if (getField(fmBlock, 'draft') === 'false') {
  report({ status: 'ALREADY_RELEASED', reason: `${slug} уже не черновик` });
  process.exit(0);
}

// ── Шаг 2 — редактор принял статью ──────────────────────────────────────

let cycleTopic = null;
if (existsSync(CYCLE_STATE_PATH)) {
  try {
    const cycle = JSON.parse(readFileSync(CYCLE_STATE_PATH, 'utf8'));
    cycleTopic = (cycle.plan || []).find((t) => t.slug === slug) || null;
  } catch {
    /* повреждённый cycle-state — ниже трактуем как «темы нет в цикле» */
  }
}

if (cycleTopic) {
  if (cycleTopic.status === 'accepted') {
    pass('Приёмка редактором', 'accepted');
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

const npa = runGate('node', ['scripts/factcheck/audit-npa-references.mjs', '--strict'], DATA_ROOT);
if (npa.ok) pass('НПА-аудит (--strict)');
else block('НПА-аудит (--strict)', 'незнакомые номера НПА — см. node scripts/factcheck/audit-npa-references.mjs');

const links = runGate('node', ['scripts/audit/check-blog-links.mjs'], DATA_ROOT);
if (links.ok) pass('Внутренние ссылки');
else block('Внутренние ссылки', 'битые /blog/ ссылки — см. node scripts/audit/check-blog-links.mjs');

const seo = runGate('node', ['scripts/check-seo.mjs', articlePath]);
if (seo.ok) pass('SEO (P0)');
else block('SEO (P0)', 'P0-ошибки — см. node scripts/check-seo.mjs ' + articlePath);

const ai = runGate('node', ['scripts/check-ai-markers.mjs', articlePath]);
if (ai.ok) pass('AI-маркеры');
else block('AI-маркеры', 'скор выше порога — см. node scripts/check-ai-markers.mjs ' + articlePath);

// ── Шаг 4 — оценка свежая и проходная ───────────────────────────────────

const analyzePath = join(ANALYZE_DIR, `${slug}.json`);
if (!existsSync(analyzePath)) {
  block('Оценка /analyze-article', 'нет src/data/analyze/<slug>.json — запустить /analyze-article ' + slug);
} else {
  let analysis = null;
  try {
    analysis = JSON.parse(readFileSync(analyzePath, 'utf8'));
  } catch {
    block('Оценка /analyze-article', 'src/data/analyze/<slug>.json повреждён');
  }
  if (analysis) {
    const age = ageDays(analysis.checkedAt);
    if (age === null || age > ANALYZE_STALE_DAYS) {
      block('Оценка /analyze-article', `устарела (${age ?? '?'} дн.) — перезапустить /analyze-article ${slug}`);
    } else if (analysis.blocker || (analysis.score ?? 0) < 70) {
      if (OVERRIDE_SCORE_REASON) {
        note(
          'Оценка /analyze-article',
          `${analysis.score}/100, blocker: ${Boolean(analysis.blocker)} — переопределено редактором: ${OVERRIDE_SCORE_REASON}`,
        );
        scoreOverride = { reason: OVERRIDE_SCORE_REASON, score: analysis.score, blocker: Boolean(analysis.blocker), at: today() };
      } else {
        block(
          'Оценка /analyze-article',
          `${analysis.score}/100, blocker: ${Boolean(analysis.blocker)} — форсировать может только редактор: ` +
            '--override-score "<причина>"',
        );
      }
    } else {
      pass('Оценка /analyze-article', `${analysis.score}/100 (проверена ${analysis.checkedAt})`);
    }
  }
}

// ── Шаг 5 — фактчек не протух ────────────────────────────────────────────

const markerPath = join(MARKERS_DIR, slug);
let marker = null;
if (!existsSync(markerPath)) {
  block('Фактчек', `нет маркера .claude/factchecked/${slug} — нужен /factcheck ${slug}`);
} else {
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    block('Фактчек', 'маркер повреждён — нужен /factcheck ' + slug);
  }
  if (marker) {
    const currentHash = createHash('sha256').update(rawBefore).digest('hex');
    const age = ageDays(marker.date);
    if (marker.hash !== currentHash) {
      block('Фактчек', 'статья менялась после факчека — нужен /factcheck ' + slug);
    } else if (age === null || age > FACTCHECK_STALE_DAYS) {
      block('Фактчек', `маркер старше ${FACTCHECK_STALE_DAYS} дн. (${age ?? '?'}) — нужен /factcheck ${slug}`);
    } else {
      pass('Фактчек', `маркер от ${marker.date} (${age} дн.)`);
    }
  }
}

// ── Шаг 6 — снятие черновика (только если ничего не заблокировано) ──────

if (blockers.length) {
  report({ status: 'BLOCKED' });
  process.exit(1);
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
  const reviewDate = !existingReview || existingReview < today() ? (due < today() ? addMonths(today(), 6) : due) : existingReview;
  fmAfter = setField(fmAfter, 'reviewDate', reviewDate);
}

const newContent = `---\n${fmAfter.trim()}\n---\n${body}`;
writeFileSync(articlePath, newContent);

// Снятие draft (и, возможно, updatedDate/reviewDate) само меняет хеш
// статьи — тот самый хеш, который маркер только что подтвердил. Не
// обновить маркер здесь значит гарантированно сломать его при следующей
// же проверке (pre-commit guard, /analyze-article): факты не менялись,
// маркер лишь не знает о собственном флаге draft. `date` не трогаем —
// это дата, когда факты были реально проверены, не дата этого релиза.
const newHash = createHash('sha256').update(newContent).digest('hex');
writeFileSync(markerPath, JSON.stringify({ ...marker, hash: newHash }));

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
  writeFileSync(analyzePath, JSON.stringify(analysis, null, 2) + '\n');
}

// F-02 (git-локальная часть — Google Sheets вне досягаемости этого
// скрипта). Без этого шага health-check (F-05) находит расхождение
// после каждого релиза темы, которая была в контент-плане: план
// показывает planned/draft, статья уже вышла. Лучше не дать
// расхождению случиться, чем полагаться только на то, что кто-то
// прочитает предупреждение.
const contentPlanSync = syncContentPlanStatus(DATA_ROOT, slug);
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
  else if (status === 'BLOCKED') console.log('ЗАБЛОКИРОВАНА — draft не менялся');
  else if (status === 'ERROR') console.log(extra.reason);
  console.log('━'.repeat(40));
}
