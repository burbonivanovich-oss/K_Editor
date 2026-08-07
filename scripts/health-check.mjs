#!/usr/bin/env node
// Health-check проекта: проходит по ключевым системам и
// возвращает зелёный/жёлтый/красный статус. Один взгляд — и
// понятно, что в порядке, а что требует внимания.
//
// Запуск:
//   node scripts/health-check.mjs                — полный отчёт
//   node scripts/health-check.mjs --json         — для пайплайнов
//   node scripts/health-check.mjs --strict       — exit 1 при любых red
//   node scripts/health-check.mjs --content-plan — только секция плана:
//                                                  читает таблицы в
//                                                  src/content/wiki/content-plan-2026.md
//                                                  и сверяет с blog/. Печатает
//                                                  расхождения, статистику done/draft/planned,
//                                                  топ-планируемых по priority.
//
// Эту утилиту хорошо запускать:
//   - перед мержем PR в main
//   - в cron'е раз в неделю (отдельным workflow с уведомлением)
//   - вручную «что у меня вообще происходит?»

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = process.env.HEALTH_CHECK_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
const STRICT = args.has('--strict');
const CONTENT_PLAN_ONLY = args.has('--content-plan');

const checks = [];

function ok(name, detail = '')    { checks.push({ status: 'ok',    name, detail }); }
function warn(name, detail = '')  { checks.push({ status: 'warn',  name, detail }); }
function fail(name, detail = '')  { checks.push({ status: 'fail',  name, detail }); }

// ─── 1. Контент: блог ─────────────────────────────────────────────
const blogDir = join(ROOT, 'src', 'content', 'blog');
const blogFiles = existsSync(blogDir)
	? readdirSync(blogDir).filter(f => /\.(md|mdx)$/.test(f))
	: [];
const today = new Date();

let drafts = 0, future = 0, noFactcheck = 0;
const slugs = new Set();
const released = []; // draft:false статьи — вход для секции 5 (бизнес-инварианты)
for (const f of blogFiles) {
	const content = readFileSync(join(blogDir, f), 'utf8');
	const slug = f.replace(/\.(md|mdx)$/, '');
	slugs.add(slug);
	const isDraft = /^draft:\s*true/m.test(content);
	if (isDraft) drafts++;
	else released.push({ slug, content });
	const pd = content.match(/^pubDate:\s*"?(\d{4}-\d{2}-\d{2})/m);
	if (pd && new Date(pd[1]) > today) future++;
	if (!existsSync(join(ROOT, '.claude', 'factchecked', slug))) noFactcheck++;
}
ok('Блог: статей всего', `${blogFiles.length}`);
// Пустой блог — не «всё хорошо»: проверки черновиков и фактчека на нуле
// статей проходят вхолостую и раньше писались как ok, что при первом
// взгляде на отчёт читалось как «всё проверено» вместо честного «нечего
// проверять» (см. docs/audit-2026-08-04.md — ложно-зелёные прогоны
// npa-audit/check-blog-links по тому же классу причины).
if (blogFiles.length === 0) {
	warn('Блог: пуст', 'проверки черновиков и фактчека неприменимы — нечего проверять');
} else {
	if (drafts > 0) warn('Блог: черновики (draft: true)', `${drafts}`);
	else ok('Блог: черновиков нет', '0');
	if (future > 0) warn('Блог: статьи с будущим pubDate', `${future} (выйдут по auto-publish)`);
	if (noFactcheck > 0) warn('Блог: без маркера factchecked', `${noFactcheck}/${blogFiles.length}`);
	else ok('Блог: все статьи фактчекнуты', `${blogFiles.length}`);
}


// ─── 2. Workflows ────────────────────────────────────────────────────────────
const wfDir = join(ROOT, '.github', 'workflows');
const wfs = readdirSync(wfDir).filter(f => f.endsWith('.yml'));
ok('Workflows: всего', `${wfs.length}`);

// Проверяем что упомянутые в workflow скрипты существуют
const broken = [];
for (const wf of wfs) {
	const text = readFileSync(join(wfDir, wf), 'utf8');
	const scripts = [...text.matchAll(/node\s+(scripts\/[a-z0-9\-_/.]+\.mjs)/gi)].map(m => m[1]);
	for (const s of scripts) {
		if (!existsSync(join(ROOT, s))) broken.push({ wf, script: s });
	}
}
if (broken.length === 0) ok('Workflows: все script-ссылки целы', '');
else fail('Workflows: битые ссылки на скрипты', broken.map(b => `${b.wf} → ${b.script}`).join(', '));

// ─── 3. Скрипты ──────────────────────────────────────────────────────────────
const scriptsDir = join(ROOT, 'scripts');
function walkScripts(dir, acc = []) {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		const s = statSync(p);
		if (s.isDirectory()) walkScripts(p, acc);
		else if (f.endsWith('.mjs')) acc.push(p);
	}
	return acc;
}
const allScripts = walkScripts(scriptsDir);
ok('Скрипты: всего .mjs', `${allScripts.length}`);

// ─── 4. Документация ─────────────────────────────────────────────────────────
const requiredDocs = [
	'docs/content-rules.md',
	'docs/content-types.md',
	'docs/tools.md',
	'docs/editorial-cycle.md',
	'docs/editorial-policy.md',
	'docs/factcheck.md',
	'docs/wordstat.md',
	'docs/SECRETS.md',
	'docs/google-api-setup.md',
];
const missingDocs = requiredDocs.filter(d => !existsSync(join(ROOT, d)));
if (missingDocs.length === 0) ok('Документация: ключевые файлы на месте', `${requiredDocs.length}`);
else fail('Документация: пропущено', missingDocs.join(', '));

// ─── 5. Бизнес-инварианты выпуска (F-05) ──────────────────────────────────────
// Раньше health-check проверял системы по отдельности (блог, workflow,
// документация) — но не сочетания их состояний. Именно сочетания и
// прячут реальные проблемы: статья опубликована, а план думает, что
// она ещё пишется; маркер факчека существует, но не про эту версию
// текста; статья вышла в обход release-article.mjs и никто не
// подтверждал вычитку. Каждая проверка ниже смотрит минимум на два
// источника разом — то, что не видно, если проверять их порознь.
function auditReleaseInvariants() {
	if (released.length === 0) {
		ok('Бизнес-инварианты: нечего проверять', 'released-статей нет');
		return;
	}

	// A. Маркер факчека существует, но хеш — не про текущее содержимое
	// (release-article.mjs это же проверяет перед выпуском; здесь —
	// повторно, на случай правки после выпуска в обход самого скрипта).
	const staleMarkers = [];
	for (const { slug, content } of released) {
		const markerPath = join(ROOT, '.claude', 'factchecked', slug);
		if (!existsSync(markerPath)) continue; // это уже noFactcheck выше
		try {
			const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
			const hash = createHash('sha256').update(content).digest('hex');
			if (marker.hash && marker.hash !== hash) staleMarkers.push(slug);
		} catch {
			staleMarkers.push(slug); // маркер повреждён — тоже недействителен
		}
	}
	if (staleMarkers.length > 0) {
		fail(`Бизнес-инварианты: маркер факчека не про текущий текст`,
			`${staleMarkers.length}: ${staleMarkers.slice(0, 3).join(', ')}${staleMarkers.length > 3 ? ', …' : ''} — статья правилась после факчека`);
	} else {
		ok('Бизнес-инварианты: маркеры факчека согласованы с текстом');
	}

	// B. Released, но выпуск нигде не подтверждён — ни статусом
	// released в editorial-cycle.json, ни записанным исключением
	// (--confirm-no-cycle) в src/data/analyze/<slug>.json. Не
	// доказывает, что draft:false поставили в обход release-
	// article.mjs — но это единственный способ это заподозрить без
	// git blame по каждой статье.
	let cyclePlan = [];
	const cycleStatePath = join(ROOT, 'src', 'data', 'editorial-cycle.json');
	if (existsSync(cycleStatePath)) {
		try { cyclePlan = JSON.parse(readFileSync(cycleStatePath, 'utf8')).plan ?? []; } catch { /* ниже — как пустой план */ }
	}
	const unconfirmed = [];
	for (const { slug } of released) {
		const cycleTopic = cyclePlan.find((t) => t.slug === slug);
		if (cycleTopic?.status === 'released') continue;
		const analyzePath = join(ROOT, 'src', 'data', 'analyze', `${slug}.json`);
		if (existsSync(analyzePath)) {
			try {
				const a = JSON.parse(readFileSync(analyzePath, 'utf8'));
				if (a.cycleReleaseOverride?.reason) continue;
			} catch { /* повреждённый analyze — считаем неподтверждённым */ }
		}
		unconfirmed.push(slug);
	}
	if (unconfirmed.length > 0) {
		warn(`Бизнес-инварианты: выпуск без записанного пути`,
			`${unconfirmed.length}: ${unconfirmed.slice(0, 3).join(', ')}${unconfirmed.length > 3 ? ', …' : ''} — ` +
			`ни status:released в editorial-cycle.json, ни cycleReleaseOverride в analyze/<slug>.json`);
	} else {
		ok('Бизнес-инварианты: у каждого выпуска записан путь (цикл или подтверждённое исключение)');
	}
}
auditReleaseInvariants();

// ─── Контент-план: статусы тем ───────────────────────────────────────────────
// Парсит таблицы кластеров в content-plan-2026.md, сверяет с blog/, выводит
// статистику done/draft/planned + первые расхождения.
function analyzeContentPlan() {
	const planPath = join(ROOT, 'src', 'content', 'wiki', 'content-plan-2026.md');
	if (!existsSync(planPath)) {
		fail('Контент-план: файл не найден', planPath);
		return;
	}
	const planText = readFileSync(planPath, 'utf8');
	// Строки таблиц: | slug | title | P0/P1/P2 | query | status | blocker |
	const rowRe = /^\|\s*([a-z0-9][a-z0-9-]+)\s*\|\s*([^|]+?)\s*\|\s*(P[012])\s*\|\s*([^|]+?)\s*\|\s*(done|draft|planned|deprioritized)\s*\|\s*([^|]*?)\s*\|$/gm;

	const themes = [];
	let m;
	while ((m = rowRe.exec(planText)) !== null) {
		themes.push({
			slug: m[1],
			title: m[2],
			priority: m[3],
			query: m[4].trim(),
			status: m[5],
			blocker: m[6].trim(),
		});
	}

	if (themes.length === 0) {
		fail('Контент-план: ни одной темы не распарсилось', 'проверь формат таблиц');
		return;
	}

	const byStatus = themes.reduce((acc, t) => (acc[t.status] = (acc[t.status] ?? 0) + 1, acc), {});
	const byPrio = themes.reduce((acc, t) => (acc[t.priority] = (acc[t.priority] ?? 0) + 1, acc), {});

	// Сверка с blog/
	const blogSlugs = new Set();
	for (const f of blogFiles) {
		const slug = f.replace(/\.(md|mdx)$/, '');
		const short = slug.replace(/^\d{4}-\d{2}-\d{2}-/, '');
		blogSlugs.add(short);
	}

	// 1. done в плане, но slug нет в blog/ — расхождение
	const ghostDone = themes.filter(t => (t.status === 'done' || t.status === 'draft') && !blogSlugs.has(t.slug));
	// 2. есть статья в blog/, но нет slug в плане
	const planSlugs = new Set(themes.map(t => t.slug));
	const orphanArticles = [...blogSlugs].filter(s => !planSlugs.has(s));

	ok(`Контент-план: тем ${themes.length}`,
		`done ${byStatus.done ?? 0}, draft ${byStatus.draft ?? 0}, planned ${byStatus.planned ?? 0}` +
		(byStatus.deprioritized ? `, deprioritized ${byStatus.deprioritized}` : ''));

	ok(`Контент-план: приоритеты`,
		`P0 ${byPrio.P0 ?? 0}, P1 ${byPrio.P1 ?? 0}, P2 ${byPrio.P2 ?? 0}`);

	if (ghostDone.length > 0) {
		warn(`Контент-план: ${ghostDone.length} done без статьи в blog/`,
			ghostDone.slice(0, 3).map(t => t.slug).join(', ') + (ghostDone.length > 3 ? ', …' : ''));
	} else {
		ok('Контент-план: все done/draft сверены 1:1 с blog/');
	}

	// 3. draft:false в blog/, но план всё ещё думает planned/draft (F-05:
	// то самое расхождение, которое ghostDone (проверка выше) не ловит —
	// та смотрит только на «done без файла», не на «файл вышел, план не
	// узнал». Обе стороны одного и того же класса рассинхрона статусов.
	const releasedShortSlugs = new Set(released.map(({ slug }) => slug.replace(/^\d{4}-\d{2}-\d{2}-/, '')));
	const planNotCaughtUp = themes.filter(t => releasedShortSlugs.has(t.slug) && t.status !== 'done');
	if (planNotCaughtUp.length > 0) {
		warn(`Контент-план: ${planNotCaughtUp.length} статей вышли, план не обновлён`,
			planNotCaughtUp.slice(0, 3).map(t => `${t.slug} (план: ${t.status})`).join(', ') +
			(planNotCaughtUp.length > 3 ? ', …' : ''));
	} else if (released.length > 0) {
		ok('Контент-план: у всех вышедших статей план отмечен done');
	}

	if (orphanArticles.length > 0) {
		warn(`Контент-план: ${orphanArticles.length} статей в blog/ не отражены в плане`,
			orphanArticles.slice(0, 3).join(', ') + (orphanArticles.length > 3 ? ', …' : ''));
	}

	// Топ P0 planned — что писать первым
	const p0Planned = themes.filter(t => t.status === 'planned' && t.priority === 'P0');
	if (p0Planned.length > 0) {
		ok(`P0 planned в очереди: ${p0Planned.length}`,
			p0Planned.slice(0, 3).map(t => t.slug).join(', ') + (p0Planned.length > 3 ? ', …' : ''));
	}
}

analyzeContentPlan();

// ─── Вывод ───────────────────────────────────────────────────────────────────
// В --content-plan режиме оставляем только проверки про план
let outputChecks = checks;
if (CONTENT_PLAN_ONLY) {
	outputChecks = checks.filter(c => c.name.startsWith('Контент-план') || c.name.startsWith('P0 planned'));
}

if (JSON_OUT) {
	console.log(JSON.stringify({
		summary: {
			ok: outputChecks.filter(c => c.status === 'ok').length,
			warn: outputChecks.filter(c => c.status === 'warn').length,
			fail: outputChecks.filter(c => c.status === 'fail').length,
		},
		checks: outputChecks,
	}, null, 2));
} else {
	const ICON = { ok: '✓', warn: '⚠', fail: '✗' };
	const COLOR = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', reset: '\x1b[0m' };
	for (const c of outputChecks) {
		console.log(`${COLOR[c.status]}${ICON[c.status]}${COLOR.reset} ${c.name}${c.detail ? ': ' + c.detail : ''}`);
	}
	const okN = outputChecks.filter(c => c.status === 'ok').length;
	const warnN = outputChecks.filter(c => c.status === 'warn').length;
	const failN = outputChecks.filter(c => c.status === 'fail').length;
	console.log(`\nИтого: ${COLOR.ok}${okN} ok${COLOR.reset}, ${COLOR.warn}${warnN} warn${COLOR.reset}, ${COLOR.fail}${failN} fail${COLOR.reset}`);
}

if (STRICT && outputChecks.some(c => c.status === 'fail')) process.exit(1);
