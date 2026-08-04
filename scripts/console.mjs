#!/usr/bin/env node
//
// Консоль модуля: одна точка входа вместо 25 скриптов и 25 slash-команд.
//
// Запуск:
//   node scripts/console.mjs           — интерактивное меню
//   node scripts/console.mjs status    — только панель состояния, без меню
//
// Что делает: показывает состояние модуля одним экраном и запускает
// скрипты по номеру пункта. Часть работы модуля живёт не в скриптах, а в
// агентах Claude (/create-article, /cycle-batch и остальные) — такие
// пункты консоль не выполняет, а выдаёт строку для вставки в Claude.
// Притворяться, что она их запускает, было бы враньём: у консоли нет
// доступа ни к агентам, ни к их шлюзам.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isTTY = process.stdin.isTTY && process.stdout.isTTY;

// ─── оформление ────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const paint = (s, c) => (process.stdout.isTTY ? `${C[c]}${s}${C.reset}` : String(s));
const ok = (s) => paint(s, "green");
const warn = (s) => paint(s, "yellow");
const bad = (s) => paint(s, "red");
const dim = (s) => paint(s, "gray");

// ─── чтение состояния ──────────────────────────────────────────────────

function readJSON(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
  return { code: r.status ?? 1, out: (r.stdout || "").trim(), err: (r.error || "").toString() };
}

function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : "";
}

// Сколько кластеров должен покрывать отчёт спроса. Машиночитаемого списка
// кластеров в проекте нет (канонический — таблица в docs/content-rules.md),
// поэтому считаем по seeds.json: там у каждого seed проставлен кластер.
function expectedClusters() {
  const seeds = readJSON("src/data/wordstat/discoveries/seeds.json");
  if (!seeds?.seeds) return 18;
  const set = new Set(seeds.seeds.map((x) => x.cluster).filter((c) => c && c !== "any"));
  return set.size || 18;
}

function collectStatus() {
  const s = {};

  // git
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  const unpushed = sh("git", ["log", "--oneline", "@{u}..HEAD"]).out;
  const dirty = sh("git", ["status", "--porcelain"]).out;
  s.git = {
    branch: branch || "—",
    unpushed: unpushed ? unpushed.split("\n").length : 0,
    dirty: dirty ? dirty.split("\n").length : 0,
    // Хуки ставятся двумя способами: git config core.hooksPath (так делает
    // документированный scripts/git-hooks/install.sh) либо копией в
    // .git/hooks. Проверяем оба, иначе установленные хуки выглядят как
    // отсутствующие.
    hooks:
      Boolean(sh("git", ["config", "core.hooksPath"]).out) ||
      existsSync(join(ROOT, ".git/hooks/pre-commit")),
  };

  // контент
  const blogDir = join(ROOT, "src/content/blog");
  let total = 0, drafts = 0;
  if (existsSync(blogDir)) {
    for (const f of readdirSync(blogDir)) {
      if (!/\.mdx?$/.test(f)) continue;
      total++;
      if (/^draft:\s*true\s*$/m.test(frontmatter(readFileSync(join(blogDir, f), "utf8")))) drafts++;
    }
  }
  const fcDir = join(ROOT, ".claude/factchecked");
  const markers = existsSync(fcDir) ? readdirSync(fcDir).filter((f) => !f.startsWith(".")).length : 0;
  s.content = { total, drafts, markers };

  // план
  const plan = readJSON("src/data/editorial-plan.json");
  const items = plan?.items ?? [];
  s.plan = {
    total: items.length,
    byStatus: items.reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {}),
    p0: items.filter((t) => t.priority === "P0" && t.status === "planned").length,
  };

  // цикл
  const cyc = readJSON("src/data/editorial-cycle.json");
  const topics = cyc?.plan ?? [];
  s.cycle = {
    state: cyc?.state ?? "—",
    cycleId: cyc?.cycleId ?? null,
    hasDrive: Boolean(cyc?.drive?.sheetId),
    byStatus: topics.reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {}),
    inReview: topics.filter((t) => t.status === "review").length,
    maxInReview: cyc?.maxInReview ?? 6,
  };

  // доступы
  const has = (n) => Boolean(process.env[n] && process.env[n].trim());
  s.creds = {
    google: ["GOOGLE_DOCS_KEY", "GOOGLE_DOCS_FOLDER_ID", "GSC_CLIENT_ID", "GSC_REFRESH_TOKEN"].filter(has),
    yandex: ["YC_API_KEY", "YC_FOLDER_ID"].filter(has),
  };

  // wordstat
  const keys = readJSON("src/data/wordstat/keys.json");
  if (keys?.keys) {
    const stamps = Object.values(keys.keys).map((k) => k.fetchedAt).filter(Boolean).sort();
    s.wordstat = {
      count: Object.keys(keys.keys).length,
      declared: keys.lastFullUpdate ?? null,
      actual: stamps.length ? stamps[stamps.length - 1].slice(0, 10) : null,
    };
  }
  // demand-watch: дату берём из текста отчёта, а не из mtime — mtime
  // показывает время клонирования репозитория, а не генерации.
  const demand = join(ROOT, "src/data/wordstat/demand-watch.md");
  s.wordstat = s.wordstat || {};
  if (existsSync(demand)) {
    const head = readFileSync(demand, "utf8").slice(0, 600);
    const gen = head.match(/Сгенерирован\s+(\d{4}-\d{2}-\d{2})/);
    const clusters = head.match(/Кластеров:\s*(\d+)/);
    s.wordstat.report = {
      date: gen ? gen[1] : null,
      age: gen ? daysSince(gen[1]) : null,
      clusters: clusters ? Number(clusters[1]) : null,
    };
  }

  return s;
}

function renderStatus(s) {
  const CLUSTERS_EXPECTED = expectedClusters();
  const L = [];
  const row = (label, value) => L.push(`  ${label.padEnd(22)} ${value}`);

  L.push("");
  L.push(paint("  СОСТОЯНИЕ МОДУЛЯ", "bold"));
  L.push(dim("  " + "─".repeat(58)));

  // git
  const gitBits = [s.git.branch];
  if (s.git.unpushed) gitBits.push(warn(`${s.git.unpushed} не запушено`));
  if (s.git.dirty) gitBits.push(warn(`${s.git.dirty} изменено`));
  if (!s.git.hooks) gitBits.push(bad("hooks не установлены"));
  row("Ветка", gitBits.join(dim(" · ")));

  // контент
  const cBits = [`${s.content.total} статей`];
  if (s.content.drafts) cBits.push(`${s.content.drafts} черновиков`);
  cBits.push(
    s.content.total === 0
      ? dim("блог пуст — проверки контента проходят вхолостую")
      : s.content.markers < s.content.total
        ? bad(`факт-чек: ${s.content.markers}/${s.content.total}`)
        : ok(`факт-чек: ${s.content.markers}/${s.content.total}`),
  );
  row("Контент", cBits.join(dim(" · ")));

  // план
  row("План", `${s.plan.total} тем${s.plan.p0 ? dim(` · P0 в очереди: ${s.plan.p0}`) : ""}`);

  // цикл
  const cy = s.cycle;
  const queue = `${cy.inReview}/${cy.maxInReview}`;
  const cyBits = [cy.state === "idle" ? dim("idle") : ok(cy.state)];
  if (cy.cycleId) cyBits.push(cy.cycleId);
  cyBits.push(`очередь редактора ${cy.inReview >= cy.maxInReview ? bad(queue) : queue}`);
  if (!cy.hasDrive) cyBits.push(warn("Drive не развёрнут"));
  row("Цикл", cyBits.join(dim(" · ")));

  // доступы
  const g = s.creds.google.length;
  row(
    "Google (цикл)",
    g === 0
      ? bad("нет в окружении") + dim(" — нужны переменные среды, не секреты репозитория")
      : ok(`${g}/4 переменных`),
  );
  row(
    "Yandex (wordstat)",
    s.creds.yandex.length === 0
      ? dim("нет в окружении") + dim(" — норма, живут в секретах репозитория")
      : ok(`${s.creds.yandex.length}/2 переменных`),
  );

  // wordstat
  const w = s.wordstat || {};
  if (w.count) {
    const gap = w.declared && w.actual && w.declared !== w.actual;
    row(
      "Wordstat",
      `${w.count} ключей · ` +
        (gap
          ? bad(`данные от ${w.actual}, метка «${w.declared}»`)
          : ok(`данные от ${w.actual ?? "—"}`)),
    );
  }
  if (w.report) {
    const bits = [];
    bits.push(w.report.age > 14 ? warn(`${w.report.date} (${w.report.age} дн.)`) : `${w.report.date}`);
    if (w.report.clusters !== null && w.report.clusters < CLUSTERS_EXPECTED) {
      bits.push(bad(`покрыто кластеров ${w.report.clusters}/${CLUSTERS_EXPECTED}`));
    }
    row("demand-watch", bits.join(dim(" · ")));
  }

  L.push("");
  return L.join("\n");
}

// ─── меню ──────────────────────────────────────────────────────────────
//
// type: "run"    — консоль запускает сама
//       "claude" — работа агента, консоль отдаёт строку для Claude

const MENU = [
  {
    title: "Проверки",
    items: [
      { k: "1", label: "Health-check — сводка по всем подсистемам", type: "run", cmd: ["node", "scripts/health-check.mjs"] },
      { k: "2", label: "Доступ к Google API (диагностика цикла)", type: "run", cmd: ["node", "scripts/drive-sync.mjs", "check"] },
      { k: "3", label: "Устаревшие статьи (reviewDate прошёл)", type: "run", cmd: ["node", "scripts/check-stale-content.mjs"] },
      { k: "4", label: "Перелинковка: сироты и тупики", type: "run", cmd: ["node", "scripts/audit/linkgraph.mjs"] },
      { k: "5", label: "Битые внутренние ссылки", type: "run", cmd: ["node", "scripts/audit/check-blog-links.mjs"] },
      { k: "6", label: "Аудит ссылок на НПА (--strict)", type: "run", cmd: ["node", "scripts/factcheck/audit-npa-references.mjs", "--strict"] },
      { k: "7", label: "AI-маркеры в статье", type: "run", cmd: ["node", "scripts/check-ai-markers.mjs"], needs: "slug" },
      { k: "8", label: "SEO-качество статьи", type: "run", cmd: ["node", "scripts/check-seo.mjs"], needs: "slug" },
    ],
  },
  {
    title: "Редакционный цикл",
    items: [
      { k: "10", label: "Где сейчас цикл", type: "run", cmd: ["node", "scripts/cycle-state.mjs", "get"] },
      { k: "11", label: "Можно ли стартовать батч", type: "run", cmd: ["node", "scripts/cycle-state.mjs", "can-start-batch"] },
      { k: "12", label: "Рутина A — собрать план и выложить редактору", type: "claude", cmd: "/cycle-plan" },
      { k: "13", label: "Рутина A0 — недельный бэклог тем", type: "claude", cmd: "/cycle-backlog" },
      { k: "14", label: "Рутина B — прочитать решения редактора", type: "claude", cmd: "/cycle-listen" },
      { k: "15", label: "Рутина C — написать батч из 3 статей", type: "claude", cmd: "/cycle-batch" },
    ],
  },
  {
    title: "Статья",
    items: [
      { k: "20", label: "Полный цикл со шлюзами", type: "claude", cmd: '/create-article "<тема>"' },
      { k: "21", label: "Быстрый черновик без шлюзов", type: "claude", cmd: '/new-post "<тема>"' },
      { k: "22", label: "Факт-чек", type: "claude", cmd: "/factcheck <slug>" },
      { k: "23", label: "Оценка 0–100", type: "claude", cmd: "/analyze-article <slug>" },
      { k: "24", label: "Снять черновик (финальный шлюз)", type: "claude", cmd: "/release-article <slug>" },
      { k: "25", label: "Рерайт под соцканалы", type: "claude", cmd: "/social-rewrite <slug>" },
      { k: "26", label: "Пересобрать editorial-plan.json из контент-плана", type: "run", cmd: ["node", "scripts/generate-editorial-plan.mjs"] },
    ],
  },
  {
    title: "Wordstat и темы",
    items: [
      { k: "30", label: "Собрать ключи-кандидаты", type: "run", cmd: ["node", "scripts/wordstat/extract-keys.mjs"] },
      { k: "31", label: "Discovery вхолостую (DRY_RUN, без запросов к API)", type: "run", cmd: ["node", "scripts/wordstat/discover.mjs"], env: { DRY_RUN: "1" } },
      { k: "32", label: "Отчёт спроса по кластерам", type: "run", cmd: ["node", "scripts/wordstat/demand-watch.mjs"] },
      { k: "33", label: "Diff последних выгрузок", type: "run", cmd: ["node", "scripts/wordstat/diff-snapshots.mjs"] },
      { k: "34", label: "Кандидаты на пересмотр по изменившейся нормативке", type: "run", cmd: ["node", "scripts/npa-change-candidates.mjs"] },
      { k: "35", label: "Поиск новых тем", type: "claude", cmd: "/find-topics" },
    ],
  },
  {
    title: "Обслуживание",
    items: [
      { k: "40", label: "Установить git-хуки (гейт факт-чека)", type: "run", cmd: ["bash", "scripts/git-hooks/install.sh"] },
      { k: "41", label: "Убрать orphaned-ключи из кеша Wordstat", type: "run", cmd: ["node", "scripts/wordstat/cleanup-orphans.mjs"] },
      { k: "42", label: "Подчистить историю выгрузок по ретенции", type: "run", cmd: ["node", "scripts/wordstat/prune-history.mjs"] },
    ],
  },
];

function renderMenu() {
  const L = [];
  for (const section of MENU) {
    L.push("");
    L.push(paint(`  ${section.title}`, "bold"));
    for (const it of section.items) {
      const mark = it.type === "claude" ? paint("→", "cyan") : " ";
      const note = it.needs === "slug" ? dim(" (спросит slug)") : "";
      L.push(`  ${mark} ${paint(it.k.padStart(2), "bold")}  ${it.label}${note}`);
    }
  }
  L.push("");
  L.push(dim(`  ${paint("→", "cyan")} ${dim("— выполняет агент Claude, консоль выдаст строку для вставки")}`));
  L.push(dim("  s — обновить состояние   q — выход"));
  L.push("");
  return L.join("\n");
}

// ─── выполнение пункта ─────────────────────────────────────────────────

function findItem(key) {
  for (const s of MENU) for (const it of s.items) if (it.k === key) return it;
  return null;
}

function runItem(it, slug) {
  if (it.type === "claude") {
    const line = slug ? it.cmd.replace("<slug>", slug) : it.cmd;
    console.log("");
    console.log(paint("  Это делает агент Claude — консоль его не запускает.", "yellow"));
    console.log("  Вставьте в Claude Code:");
    console.log("");
    console.log(paint(`      ${line}`, "cyan"));
    console.log("");
    return;
  }

  const [cmd, ...args] = it.cmd;
  const full = [...args];
  if (it.needs === "slug") {
    if (!slug) { console.log(bad("\n  Нужен slug статьи — отменено.\n")); return; }
    full.push(`src/content/blog/${slug}.md`);
  }

  console.log(dim(`\n  $ ${cmd} ${full.join(" ")}\n`));
  const r = spawnSync(cmd, full, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...(it.env || {}) },
  });
  const code = r.status ?? 1;
  console.log("");
  console.log(code === 0 ? ok(`  ✓ готово (код ${code})`) : bad(`  ✗ упало с кодом ${code}`));
  console.log("");
}

// ─── точка входа ───────────────────────────────────────────────────────

const arg = process.argv[2];

if (arg === "status") {
  console.log(renderStatus(collectStatus()));
  process.exit(0);
}

// Меню сгнивает тихо: скрипт переименовали, пункт остался и падает уже у
// пользователя. Проверяем, что каждый запускаемый пункт указывает на
// существующий файл, и что номера пунктов не задвоились.
if (arg === "check") {
  const problems = [];
  const seen = new Map();
  for (const section of MENU) {
    for (const it of section.items) {
      if (seen.has(it.k)) problems.push(`номер ${it.k} занят дважды: «${seen.get(it.k)}» и «${it.label}»`);
      seen.set(it.k, it.label);
      if (it.type !== "run") continue;
      const target = it.cmd[1];
      if (target && !existsSync(join(ROOT, target))) problems.push(`пункт ${it.k}: нет файла ${target}`);
    }
  }
  if (problems.length) {
    console.log(bad(`\n  Проблем: ${problems.length}`));
    for (const p of problems) console.log(`    ✗ ${p}`);
    console.log("");
    process.exit(1);
  }
  console.log(ok(`\n  ✓ все ${seen.size} пунктов на месте\n`));
  process.exit(0);
}

if (!isTTY) {
  // Без терминала меню повисло бы на ожидании ввода. Показываем всё разом.
  console.log(renderStatus(collectStatus()));
  console.log(renderMenu());
  console.log(dim("  Терминал не интерактивный — меню показано справочно.\n"));
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

function screen() {
  console.clear();
  console.log(renderStatus(collectStatus()));
  console.log(renderMenu());
}

screen();

while (true) {
  const answer = await ask(paint("  Пункт: ", "bold"));

  if (answer === "q" || answer === "quit" || answer === "exit") break;
  if (answer === "" || answer === "s") { screen(); continue; }

  const it = findItem(answer);
  if (!it) { console.log(bad(`\n  Нет пункта «${answer}».\n`)); continue; }

  let slug = null;
  if (it.needs === "slug" || (it.type === "claude" && it.cmd.includes("<slug>"))) {
    slug = await ask("  Slug статьи (без .md): ");
    if (!slug) { console.log(bad("\n  Пусто — отменено.\n")); continue; }
  }

  runItem(it, slug);
  await ask(dim("  Enter — вернуться в меню "));
  screen();
}

rl.close();
