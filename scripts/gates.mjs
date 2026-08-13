#!/usr/bin/env node
/**
 * Один гейт вместо шести чек-листов.
 *
 * До 13.08.2026 пайплайн `/create-article` состоял из девяти стадий и 26
 * пунктов чек-листов, которые сессия проверяла по памяти. Часть пунктов
 * дублировала друг друга, а четыре — SEO, каннибализация, перелинковка,
 * объём — проверялись глазами при том, что скрипты для них уже написаны
 * и лежали рядом. Стадия 5 «SEO» не вызывала `check-seo.mjs` вообще.
 *
 * Чек-лист, который проверяют глазами, — это не проверка, а напоминание.
 * Он молча слабеет: пункт, который однажды не сработал, в следующий раз
 * пропускают быстрее.
 *
 * Здесь всё детерминированное собрано в один прогон с одним отчётом.
 * Пайплайн перестаёт быть списком, который надо помнить и не срезать:
 * срезать нечего, глазами проверять нечего.
 *
 * Три исхода вместо двух — потому что не всякая находка это провал:
 *
 *   зелёное   — проверено, вопросов нет;
 *   красное   — блокер, дальше не идём;
 *   решение   — скрипт сузил, но выбор за человеком или сессией
 *               (пересечение с Маркетом, объём ниже опорного).
 *
 * `--json` отдаёт блок `checks` в том виде, в каком его ждёт
 * `/analyze-article`: гейты считают факты, оценщик читает текст, и
 * пересчитывать одно и то же дважды не нужно.
 *
 * Запуск:
 *   node scripts/gates.mjs <slug>
 *   node scripts/gates.mjs <slug> --json
 *   npm run gates -- <slug>
 *
 * Коды: 0 — всё зелёное, 1 — есть блокер, 2 — только «требует решения».
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.GATES_ROOT || REPO;

export const OK = 'ok', FAIL = 'fail', DECIDE = 'decide', NA = 'na';

/**
 * Проверки гейта и их человеческие названия — один список на всё.
 *
 * Тот же набор ключей ждёт `check-analysis.mjs` в `REQUIRED_CHECKS`.
 * Списки в двух файлах расходятся ровно тогда, когда в один из них
 * добавляют проверку: гейт её считает, оценщик про неё не знает, и
 * пропажа не видна ни в одном отчёте. Совпадение проверяется тестом
 * (`gates-contract.test.mjs`), а не договорённостью.
 */
export const GATE_CHECKS = {
  frontmatter: 'Frontmatter',
  words: 'Объём',
  internalLinks: 'Внутренние ссылки',
  seo: 'SEO',
  ai: 'Машинный текст',
  links: 'Ссылки',
  npa: 'Нормы',
  factcheck: 'Факчек',
  duplication: 'Дубли',
  market: 'Каталог Маркета',
  graph: 'Граф ссылок',
  pillar: 'Опорный материал',
};

/* Корень для под-скриптов.
 *
 * У каждого скрипта своя переменная для подмены корня, и одного cwd им
 * мало: пути они считают от собственного расположения. Пока это не
 * пробрасывалось, гейт на тестовой фикстуре честно проверял её
 * frontmatter и объём — и одновременно искал дубли по живому корпусу.
 * Такая проверка не врёт громко, она врёт тихо: отвечает правду на
 * вопрос про чужие данные. */
const SUB_ROOTS = ['DUP_ROOT', 'AI_PROFILE_ROOT', 'SEO_AUDIT_ROOT', 'MARKET_ROOT', 'LINKGRAPH_ROOT'];

/** Прогон скрипта: код возврата и вывод. Падение самого скрипта — тоже ответ. */
function run(script, args = []) {
  const env = { ...process.env };
  if (process.env.GATES_ROOT) for (const k of SUB_ROOTS) env[k] = ROOT;
  try {
    const out = execFileSync('node', [join(REPO, 'scripts', script), ...args], {
      encoding: 'utf8', cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const CATEGORY_RE = /categories:\s*\n\s*-\s*([a-z-]+)/;

function readArticle(slug) {
  for (const ext of ['.md', '.mdx']) {
    const p = join(ROOT, 'src/content/blog', slug + ext);
    if (existsSync(p)) return { path: p, raw: readFileSync(p, 'utf8') };
  }
  return null;
}

/** Полнота frontmatter — раньше это был пункт чек-листа «Frontmatter полный?». */
function checkFrontmatter(fm) {
  const missing = [];
  for (const f of ['title', 'description', 'pubDate', 'reviewDate']) {
    if (!new RegExp(`^${f}:\\s*\\S`, 'm').test(fm)) missing.push(f);
  }
  if (!/^categories:/m.test(fm)) missing.push('categories');
  if (!/keywords:/m.test(fm)) missing.push('seo.keywords');

  const tags = fm.match(/tags:\s*\n((?:\s*-\s*[^\n]+\n?)+)/)?.[1];
  const tagCount = tags ? (tags.match(/^\s*-\s+\S/gm) || []).length : 0;
  const cats = (fm.match(/^categories:\s*\n((?:\s*-\s*[^\n]+\n?)+)/m)?.[1].match(/^\s*-\s+\S/gm) || []).length;

  const notes = [];
  if (missing.length) notes.push(`нет полей: ${missing.join(', ')}`);
  if (tagCount < 4 || tagCount > 7) notes.push(`тегов ${tagCount} (норма 4–7)`);
  if (cats !== 1) notes.push(`категорий ${cats} (нужна ровно одна)`);

  return notes.length
    ? { status: FAIL, note: notes.join('; ') }
    : { status: OK, note: `поля на месте, тегов ${tagCount}` };
}

/** Объём. Ниже 800 — блокер, между 800 и 1500 — решение: сателлит или недописано. */
function checkWords(body) {
  const words = (body.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) || []).length;
  if (words < 800) return { status: FAIL, note: `${words} слов, минимум 800`, value: words };
  if (words < 1500) return { status: DECIDE, note: `${words} слов — сателлит; для опорной нужно 1500+`, value: words };
  return { status: OK, note: `${words} слов`, value: words };
}

/** Внутренние ссылки: раньше пункт «Внутренних ссылок ≥ 3?» в двух чек-листах. */
function checkInternalLinks(body) {
  const links = new Set((body.match(/\]\((\/[^)#]+)/g) || []).map((m) => m.slice(2)));
  return links.size >= 3
    ? { status: OK, note: `${links.size} внутренних ссылок` }
    : { status: FAIL, note: `${links.size} внутренних ссылок, нужно 3` };
}

/** Факчек: маркер есть, отчёт на месте, хеш совпадает с текущим текстом. */
function checkFactcheck(slug, raw) {
  const p = join(ROOT, '.claude/factchecked', slug);
  if (!existsSync(p)) return { status: FAIL, note: 'маркера нет — факчек не проводился' };
  let m;
  try { m = JSON.parse(readFileSync(p, 'utf8')); } catch { return { status: FAIL, note: 'маркер повреждён' }; }
  if (!m.report) return { status: FAIL, note: 'маркер без отчёта — проверка не доведена' };
  if (!existsSync(join(ROOT, m.report))) return { status: FAIL, note: `отчёта ${m.report} нет на диске` };
  if (m.result !== 'passed') return { status: FAIL, note: `результат факчека «${m.result}»` };
  if (Number(m.criticalMismatches) > 0) return { status: FAIL, note: `критических расхождений ${m.criticalMismatches}` };
  const hash = createHash('sha256').update(raw).digest('hex');
  if (m.hash && m.hash !== hash) {
    return { status: FAIL, note: 'статью правили после факчека — маркер недействителен' };
  }
  return { status: OK, note: `проверено ${m.date}` };
}

/**
 * Дубль. Свою же статью из выдачи убираем — иначе каждая статья дубль
 * сама себе.
 *
 * Здесь это всегда «требует решения», никогда не блокер, и вот почему.
 * Блокирующая проверка на дубль стоит **до ресёрча** — шаг 1 пайплайна и
 * шаг 1б рутины C. Если дубль дошёл сюда, статья уже написана, и
 * механическим «нельзя» работу не вернуть: выбор между «объединить»,
 * «развести углы» и «canonical» — редакционный, а не арифметический.
 *
 * Кроме того, порог 0.4 калибровался под вопрос «писать ли новую тему».
 * Для уже написанной статьи опорный материал и его сателлит закономерно
 * дают 0.4+ («Что такое ТС ПИоТ» против «Кто обязан подключить ТС ПИоТ»
 * — 0.43), и это нормальное устройство кластера, а не ошибка.
 */
function checkDuplication(slug, title) {
  const r = run('audit/check-draft-duplication.mjs', [title, '--json']);
  let hits = [];
  try { hits = JSON.parse(r.out).hits || []; } catch { return { status: DECIDE, note: 'разбор не удался, посмотреть руками' }; }
  const others = hits.filter((h) => !h.file.startsWith(slug));
  if (!others.length) return { status: OK, note: 'совпадений нет' };
  const top = others[0];
  return top.score >= 0.4
    ? { status: DECIDE, note: `${top.score} — «${top.title}»: объединить, развести углы или canonical` }
    : { status: DECIDE, note: `${top.score} — «${top.title}»: сузить угол и сослаться` };
}

/** Пересечение с каталогом Маркета — не блокер, а решение (AGENTS.md). */
function checkMarket(title, body) {
  const r = run('audit/check-market-duplication.mjs', [title]);
  /* Балл идёт в скобках: «  [1.00] Заголовок». Первая версия шаблона
   * искала голое число в начале строки и не находила ничего никогда —
   * проверка молча докладывала «совпадений нет» на статьях, у которых
   * совпадение было. Поймано тестом, глазами такое не видно: отчёт
   * выглядит зелёным и правдоподобным. */
  const scores = [...r.out.matchAll(/\[(\d+(?:\.\d+)?)\]/g)].map((m) => Number(m[1]));
  const score = scores.length ? Math.max(...scores) : 0;
  if (score < 0.6) return { status: OK, note: score ? `максимум ${score}` : 'совпадений нет' };
  return /kontur\.ru\/market/.test(body)
    ? { status: OK, note: `совпадение ${score}, ссылка на Маркет в тексте есть` }
    : { status: DECIDE, note: `совпадение ${score} без ссылки на Маркет — сузить угол или сослаться` };
}

/**
 * Входящие ссылки — считаем сами, а не спрашиваем linkgraph.
 *
 * Первая версия брала список сирот из `linkgraph.json`, и проверка была
 * мертва: linkgraph относит к сиротам только **выпущенные** статьи
 * (`draft: false`), а гейт по устройству работает с черновиками — все
 * статьи на этой стадии `draft: true`. То есть на вопрос «на статью
 * кто-нибудь ссылается» гейт отвечал «да» независимо от ответа.
 *
 * Поймано не глазами и не на корпусе (там у всех статей ссылки есть, и
 * зелёное выглядело правдой), а требованием доказать, что проверка
 * умеет сказать «нет» — `gates-liveness.test.mjs`.
 *
 * Заодно из гейта ушёл лишний подпроцесс и запись в отслеживаемый
 * `src/data/audit/linkgraph.json`.
 */
function checkInbound(slug, dir) {
  if (!existsSync(dir)) return { status: DECIDE, note: 'корпуса нет — посчитать входящие не по чему' };
  const inbound = readdirSync(dir)
    .filter((f) => /\.mdx?$/.test(f) && !f.startsWith(slug))
    .filter((f) => readFileSync(join(dir, f), 'utf8').includes(`/blog/${slug}`));
  return inbound.length
    ? { status: OK, note: `входящих ссылок: ${inbound.length}` }
    : { status: DECIDE, note: 'на статью никто не ссылается — добавить ссылку из смежной статьи' };
}

/** Опорный материал кластера. Нет pillar — критерий неприменим, а не провален. */
function checkPillar(slug, category) {
  if (!category) return { status: NA, note: 'категория не определена' };
  const p = join(ROOT, 'src/content/pillars', `${category}.md`);
  if (!existsSync(p)) return { status: NA, note: `у кластера ${category} нет опорного материала` };
  return readFileSync(p, 'utf8').includes(slug)
    ? { status: OK, note: `pillar ${category} ссылается` }
    : { status: DECIDE, note: `pillar ${category} не ссылается на статью` };
}

export function runGates(slug) {
  const art = readArticle(slug);
  if (!art) return null;

  const fm = art.raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const body = art.raw.slice(art.raw.indexOf('\n---', 3) + 4);
  const title = fm.match(/title:\s*["'](.+?)["']/)?.[1] ?? slug;
  const category = fm.match(CATEGORY_RE)?.[1] ?? null;
  const rel = art.path.slice(ROOT.length + 1);

  const seo = run('check-seo.mjs', [rel]);
  const ai = run('check-ai-markers.mjs', [rel]);
  const aiScore = Number(ai.out.match(/(\d+)\s*\/\s*10/)?.[1] ?? NaN);
  const links = run('audit/check-blog-links.mjs');
  const npa = run('factcheck/audit-npa-references.mjs', ['--strict']);


  return {
    slug,
    title,
    checks: {
      frontmatter: checkFrontmatter(fm),
      words: checkWords(body),
      internalLinks: checkInternalLinks(body),
      seo: seo.code === 0 ? { status: OK, note: 'без P0-ошибок' } : { status: FAIL, note: 'P0-ошибки SEO' },
      ai: Number.isFinite(aiScore)
        ? (aiScore < 6 ? { status: OK, note: `${aiScore}/10`, value: aiScore } : { status: FAIL, note: `${aiScore}/10, порог 6`, value: aiScore })
        : (ai.code === 0 ? { status: OK, note: 'маркеров не найдено' } : { status: FAIL, note: 'проверка упала' }),
      links: links.code === 0 ? { status: OK, note: 'ссылки рабочие' } : { status: FAIL, note: 'битые внутренние ссылки' },
      npa: npa.code === 0 ? { status: OK, note: 'нормы действующие' } : { status: FAIL, note: 'ссылка на недействующую норму' },
      factcheck: checkFactcheck(slug, art.raw),
      duplication: checkDuplication(slug, title),
      market: checkMarket(title, body),
      graph: checkInbound(slug, join(ROOT, 'src/content/blog')),
      pillar: checkPillar(slug, category),
    },
  };
}

/** Блок `checks` в том виде, в каком его ждёт /analyze-article. */
export function toAnalyzeChecks(result) {
  const out = {};
  for (const [k, v] of Object.entries(result.checks)) {
    out[k] = v.status === NA
      ? { applicable: false, note: v.note }
      : { ok: v.status !== FAIL, ...(v.value !== undefined ? { value: v.value } : {}), note: v.note };
  }
  return out;
}

export const verdict = (result) => {
  const st = Object.values(result.checks).map((c) => c.status);
  if (st.includes(FAIL)) return 1;
  return st.includes(DECIDE) ? 2 : 0;
};

/**
 * Распределение ответов по корпусу — картина, а не гейт.
 *
 * Показывает, что каждая проверка отвечает на живых статьях. Полезно
 * посмотреть глазами раз в месяц: «Дубли: решение 8, зелёное 2» говорит
 * о корпусе больше, чем десять отдельных отчётов.
 *
 * Гарантией это не является и предупреждений не выдаёт. Первая версия
 * помечала подозрительной всякую проверку с одинаковым ответом на всех
 * статьях — и пометила девять из двенадцати: на здоровом корпусе
 * frontmatter и ссылки обязаны быть зелёными везде. Девять
 * предупреждений, из которых восемь ложные, перестают читать за неделю
 * — то есть такой сигнал воспроизводит ровно ту болезнь, ради которой
 * чек-листы и заменили скриптом.
 *
 * Настоящая защита от мёртвой проверки — `gates-liveness.test.mjs`: там
 * для каждой проверки есть вход, на котором она обязана сказать «нет».
 * Это доказательство, а не наблюдение.
 */
export function auditChecks(slugs) {
  const dist = Object.fromEntries(Object.keys(GATE_CHECKS).map((k) => [k, {}]));
  const seen = [];
  for (const slug of slugs) {
    const r = runGates(slug);
    if (!r) continue;
    seen.push(slug);
    for (const [k, v] of Object.entries(r.checks)) {
      dist[k][v.status] = (dist[k][v.status] || 0) + 1;
    }
  }
  return { articles: seen.length, rows: Object.entries(dist).map(([key, counts]) => ({ key, counts })) };
}

/**
 * Гейт до работы: можно ли вообще браться за тему.
 *
 * Стадия 1 пайплайна раньше требовала двух отдельных вызовов — дубль и
 * каталог Маркета. Оба отвечают на один вопрос («не написано ли это
 * уже»), различаются только тем, чьё написано: наше или Маркета. Два
 * вызова с двумя разными форматами вывода на один вопрос — это то же
 * дробление, ради ухода от которого собирали гейт после работы.
 *
 * Словарь исходов тот же: зелёное / красное / требует решения. Разница
 * с гейтом после работы только в одном — здесь дубль **блокирует**,
 * потому что работа ещё не сделана и её не жалко.
 */
export function runTopicGate(topic) {
  const dup = run('audit/check-draft-duplication.mjs', [topic, '--json']);
  let hits = [];
  try { hits = JSON.parse(dup.out).hits || []; } catch { /* пусто — значит чисто */ }
  const top = hits[0];

  const mkt = run('audit/check-market-duplication.mjs', [topic]);
  const scores = [...mkt.out.matchAll(/\[(\d+(?:\.\d+)?)\]/g)].map((m) => Number(m[1]));
  const mScore = scores.length ? Math.max(...scores) : 0;
  const mUrl = mkt.out.match(/(https?:\/\/\S+)/)?.[1] ?? null;

  return {
    topic,
    checks: {
      duplication: !top
        ? { status: OK, note: 'своих статей по теме нет' }
        : top.score >= 0.4
          ? { status: FAIL, note: `дубль ${top.score}: «${top.title}»${top.draft ? ' (черновик — довести его)' : ' (выпущена — тему снять)'}` }
          : { status: DECIDE, note: `${top.score} — «${top.title}»: сузить угол и сослаться` },
      market: mScore < 0.3
        ? { status: OK, note: mScore ? `максимум ${mScore}` : 'совпадений с каталогом нет' }
        : { status: DECIDE, note: `${mScore} — ${mUrl || 'материал Маркета'}: ${mScore >= 0.6 ? 'сузить угол или дополнить тем, чего у Маркета нет' : 'поставить ссылку в тексте'}` },
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const topicIdx = process.argv.indexOf('--topic');
  if (topicIdx !== -1) {
    const topic = process.argv[topicIdx + 1];
    if (!topic) { console.error('Использование: gates.mjs --topic "<тема>"'); process.exit(1); }
    const r = runTopicGate(topic);
    const code = verdict(r);
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ topic, checks: toAnalyzeChecks(r), verdict: code }, null, 2));
      process.exit(code);
    }
    const M = { [OK]: '✓', [FAIL]: '✖', [DECIDE]: '?', [NA]: '—' };
    console.log(`Тема: «${topic}»\n`);
    console.log(`  ${M[r.checks.duplication.status]} Свои статьи        ${r.checks.duplication.note}`);
    console.log(`  ${M[r.checks.market.status]} Каталог Маркета    ${r.checks.market.note}`);
    console.log(code === 1
      ? '\n✖ Тему не писать — решение по правилу в шаге 1.2 /create-article.'
      : code === 2 ? '\n? Писать можно. Решение по вопросу выше записать в отчёт.' : '\n✓ Тема свободна.');
    process.exit(code);
  }

  if (process.argv.includes('--audit')) {
    const dir = join(ROOT, 'src/content/blog');
    const slugs = existsSync(dir)
      ? readdirSync(dir).filter((f) => /\.mdx?$/.test(f)).map((f) => f.replace(/\.mdx?$/, ''))
      : [];
    if (!slugs.length) { console.error('✖ Статей нет.'); process.exit(1); }

    const { articles, rows } = auditChecks(slugs);
    console.log(`Ответы проверок по ${articles} статьям корпуса\n`);
    const RU = { ok: 'зелёное', fail: 'красное', decide: 'решение', na: 'неприменимо' };
    for (const r of rows) {
      const spread = Object.entries(r.counts).map(([s, n]) => `${RU[s] || s} ${n}`).join(', ');
      console.log(`  ${GATE_CHECKS[r.key].padEnd(20)} ${spread}`);
    }
    const red = rows.filter((r) => r.counts.fail);
    console.log(red.length
      ? `\n✖ Красное есть у: ${red.map((r) => GATE_CHECKS[r.key]).join(', ')}`
      : '\n✓ Красного в корпусе нет.');
    console.log('Что каждая проверка умеет говорить «нет» — доказывает gates-liveness.test.mjs.');
    process.exit(0);
  }

  const slug = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!slug) {
    console.error('Использование: node scripts/gates.mjs <slug> [--json] | --audit');
    process.exit(1);
  }
  const result = runGates(slug);
  if (!result) {
    console.error(`✖ Статьи src/content/blog/${slug}.md нет.`);
    process.exit(1);
  }

  const code = verdict(result);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ slug, checks: toAnalyzeChecks(result), verdict: code }, null, 2));
    process.exit(code);
  }

  const MARK = { [OK]: '✓', [FAIL]: '✖', [DECIDE]: '?', [NA]: '—' };

  console.log(`Гейты: ${result.title}\n`);
  for (const [k, v] of Object.entries(result.checks)) {
    console.log(`  ${MARK[v.status]} ${(GATE_CHECKS[k] || k).padEnd(20)} ${v.note}`);
  }
  const n = (s) => Object.values(result.checks).filter((c) => c.status === s).length;
  console.log(`\n${n(OK)} зелёных · ${n(FAIL)} красных · ${n(DECIDE)} требуют решения · ${n(NA)} неприменимо`);
  if (code === 1) console.log('\n✖ Дальше не идём: сначала красное.');
  else if (code === 2) console.log('\n? Блокеров нет. Решения по вопросам выше — записать в отчёт.');
  else console.log('\n✓ Всё зелёное.');
  process.exit(code);
}
