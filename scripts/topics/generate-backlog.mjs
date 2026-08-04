#!/usr/bin/env node
/**
 * Рутина A0 — недельный бэклог тем.
 *
 * Собирает кандидатов из последнего Wordstat-диффа, отсеивает то, что уже
 * покрыто планом и блогом, снимает заглушённые темы и объясняет по каждой,
 * почему её стоит писать именно сейчас. Результат уходит редактору
 * таблицей: он раз в неделю проставляет решения, ничего не выискивая сам.
 *
 * Сигналы /monitor-rss и /monitor-competitors подмешиваются файлом
 * --signals: эти команды работают в сессии Claude и артефакта на диске не
 * оставляют, поэтому забрать их автоматически неоткуда.
 *
 * Запуск:
 *   node scripts/topics/generate-backlog.mjs
 *   node scripts/topics/generate-backlog.mjs --limit 20 --signals /tmp/signals.json
 *   node scripts/topics/generate-backlog.mjs --dry-run
 *
 * Пишет src/data/topic-backlog.json. Решения редактора разбирает
 * cycle-listen, память об отказах ведёт suppressions.mjs.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isSuppressed, normalize, load as loadSuppressions } from "./suppressions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DISC_DIR = join(ROOT, "src", "data", "wordstat", "discoveries");
const PLAN_FILE = join(ROOT, "src", "data", "editorial-plan.json");
const BLOG_DIR = join(ROOT, "src", "content", "blog");
const OUT = join(ROOT, "src", "data", "topic-backlog.json");

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
};
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = parseInt(arg("limit", "15"), 10);
const MIN_COUNT = parseInt(arg("min-count", "50"), 10);

/* ────────────────────────────────────────────── что уже покрыто ──── */

/** Ключи, по которым уже есть статья или запланированная тема. */
function coveredKeywords() {
  const covered = new Set();

  if (existsSync(PLAN_FILE)) {
    const plan = JSON.parse(readFileSync(PLAN_FILE, "utf8"));
    for (const row of plan.topics ?? plan.rows ?? []) {
      if (row.targetKeyword) covered.add(normalize(row.targetKeyword));
    }
  }

  if (existsSync(BLOG_DIR)) {
    for (const f of readdirSync(BLOG_DIR).filter((f) => /\.mdx?$/.test(f))) {
      const raw = readFileSync(join(BLOG_DIR, f), "utf8");
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) continue;
      // seo.keywords — список под отступом; берём всё до следующего
      // ключа верхнего уровня.
      const kw = fm[1].match(/keywords:\s*\n((?:\s+-\s+[^\n]+\n?)+)/);
      if (!kw) continue;
      for (const line of kw[1].match(/(?<=-\s)(.+)/g) ?? []) {
        covered.add(normalize(line.replace(/^["']|["']$/g, "")));
      }
    }
  }
  return covered;
}

/* ──────────────────────────────────────────── источник: Wordstat ──── */

/** Последний diff-json по каждому namespace (корень и вложенные). */
function latestDiffs() {
  if (!existsSync(DISC_DIR)) return [];
  const out = [];

  const collect = (base, ns) => {
    const diffs = join(base, "diffs");
    if (!existsSync(diffs)) return;
    const files = readdirSync(diffs)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    if (!files.length) return;
    const payload = JSON.parse(readFileSync(join(diffs, files[files.length - 1]), "utf8"));
    out.push({ ns, file: files[files.length - 1], payload });
  };

  collect(DISC_DIR, null);
  for (const name of readdirSync(DISC_DIR)) {
    const p = join(DISC_DIR, name);
    if (name === "diffs" || /^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    try {
      if (readdirSync(p)) collect(p, name);
    } catch {
      /* не каталог — пропускаем */
    }
  }
  return out;
}

/**
 * Обоснование «почему сейчас». Редактору нужен повод, а не голая цифра:
 * без него решение принимается вслепую.
 */
function reasonFor(item) {
  if (item.kind === "breakout") {
    return `пробила порог шума: ${item.prev} → ${item.now} показов в месяц (×${item.ratio.toFixed(1)})`;
  }
  if (item.kind === "rising") {
    return `рост частотности: ${item.prev} → ${item.now} показов в месяц (×${item.ratio.toFixed(1)})`;
  }
  return `новая фраза в выдаче, ${item.count} показов в месяц`;
}

function candidatesFromDiffs(diffs) {
  const rows = [];
  for (const { ns, payload } of diffs) {
    for (const seed of payload.seeds ?? []) {
      const cluster = seed.cluster || null;
      for (const n of seed.diff?.NEW ?? []) {
        if (n.count < MIN_COUNT) continue;
        rows.push({
          phrase: n.phrase, cluster, seed: seed.seed, ns,
          kind: "new", count: n.count, weight: n.count,
        });
      }
      for (const r of seed.diff?.RISING ?? []) {
        if (r.now < MIN_COUNT) continue;
        rows.push({
          phrase: r.phrase, cluster, seed: seed.seed, ns,
          kind: r.breakout ? "breakout" : "rising",
          prev: r.prev, now: r.now, ratio: r.ratio,
          // Прорыв снизу интереснее ровного роста той же величины:
          // это тема, которой на прошлой неделе фактически не было.
          weight: (r.now - r.prev) * (r.breakout ? 1.5 : 1),
        });
      }
    }
  }
  return rows;
}

/* ─────────────────────────────────────────────────────── сборка ──── */

const signalsPath = arg("signals");
let extraSignals = [];
if (signalsPath) {
  if (!existsSync(signalsPath)) {
    console.error(`Файл сигналов не найден: ${signalsPath}`);
    process.exit(1);
  }
  extraSignals = JSON.parse(readFileSync(signalsPath, "utf8"));
  if (!Array.isArray(extraSignals)) {
    console.error("--signals должен содержать массив тем");
    process.exit(1);
  }
}

const diffs = latestDiffs();
if (!diffs.length && !extraSignals.length) {
  console.log(
    "Нет ни одного diff-json и ни одного внешнего сигнала.\n" +
      "Дождитесь прогона wordstat-workflow или передайте --signals.",
  );
  process.exit(0);
}

const covered = coveredKeywords();
const suppressionData = loadSuppressions();

const raw = [
  ...candidatesFromDiffs(diffs),
  ...extraSignals.map((s) => ({
    phrase: s.topic || s.phrase,
    cluster: s.cluster || null,
    kind: "signal",
    source: s.source || "monitor",
    note: s.note || null,
    weight: s.weight ?? 0,
  })),
];

const stats = { всего: raw.length, дубли: 0, покрыто: 0, заглушено: 0 };
const seen = new Set();
const candidates = [];

for (const item of raw.sort((a, b) => b.weight - a.weight)) {
  const key = normalize(item.phrase);
  if (!key) continue;

  if (seen.has(key)) { stats.дубли++; continue; }
  seen.add(key);

  if (covered.has(key)) { stats.покрыто++; continue; }

  const hit = isSuppressed(item.phrase, suppressionData);
  if (hit) {
    stats.заглушено++;
    continue;
  }

  candidates.push({
    topic: item.phrase,
    cluster: item.cluster,
    source: item.kind === "signal" ? item.source : `wordstat:${item.ns ?? "root"}`,
    why: item.kind === "signal" ? (item.note ?? "сигнал мониторинга") : reasonFor(item),
    metrics: item.kind === "signal"
      ? null
      : { kind: item.kind, prev: item.prev ?? null, now: item.now ?? item.count, ratio: item.ratio ?? null },
    decision: "",
    author: "",
    declineReason: "",
  });

  if (candidates.length >= LIMIT) break;
}

const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  sources: diffs.map((d) => `${d.ns ?? "root"}/${d.file}`),
  limit: LIMIT,
  minCount: MIN_COUNT,
  stats,
  candidates,
};

console.log(`Кандидатов на входе: ${stats.всего}`);
console.log(`  дублей схлопнуто:   ${stats.дубли}`);
console.log(`  уже покрыто:        ${stats.покрыто}`);
console.log(`  заглушено отказами: ${stats.заглушено}`);
console.log(`В бэклог: ${candidates.length} (лимит ${LIMIT})`);

for (const c of candidates.slice(0, 10)) {
  console.log(`  • ${c.topic}  [${c.cluster ?? "—"}] — ${c.why}`);
}

if (DRY_RUN) {
  console.log("\nDry-run: файл не записан.");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`\n✓ ${OUT.replace(ROOT + "/", "")}`);
}
