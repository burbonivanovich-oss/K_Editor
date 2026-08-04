/**
 * Ретенция истории Wordstat.
 *
 * Прогоны fetch/discover каждый раз создают новые датированные файлы и
 * папки и никогда их не удаляют. kontur-набор гоняется ежедневно, так что
 * рабочее дерево растёт быстрее всего именно из-за него.
 *
 * Что чистим и почему по-разному:
 *
 *   discoveries/<NS>/YYYY-MM-DD/  — читает diff-snapshots.mjs, но ему нужны
 *                                   ровно две последние даты. Держим запас
 *                                   на случай пропущенных прогонов.
 *   snapshots/YYYY-MM-DD.json     — не читает никто: fetch.mjs пишет, и на
 *                                   этом всё. Держим короткую историю на
 *                                   случай ручного разбора.
 *   discoveries/<NS>/diffs/*.md   — отчёты для человека, а не вход для
 *                                   скриптов. Мелкие, храним дольше.
 *
 * Запуск:
 *   node scripts/wordstat/prune-history.mjs
 *   node scripts/wordstat/prune-history.mjs --dry-run
 *
 * Флаги и переменные окружения:
 *   --dry-run            показать, что будет удалено, ничего не трогая
 *   KEEP_DISCOVERIES=8   сколько датированных папок оставить (мин. 2)
 *   KEEP_SNAPSHOTS=8     сколько snapshots/*.json оставить
 *   KEEP_DIFFS=26        сколько diff-отчётов оставить
 *
 * Выход: всегда 0 — ретенция не должна ронять workflow.
 */
import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WS_DIR = join(ROOT, "src", "data", "wordstat");
const DISC_DIR = join(WS_DIR, "discoveries");
const SNAP_DIR = join(WS_DIR, "snapshots");

const DRY_RUN = process.argv.includes("--dry-run");

// diff-snapshots.mjs сравнивает две последние даты. Ниже двух опускаться
// нельзя — потеряется сама возможность построить diff.
const KEEP_DISCOVERIES = Math.max(
  2,
  parseInt(process.env.KEEP_DISCOVERIES || "8", 10),
);
const KEEP_SNAPSHOTS = Math.max(1, parseInt(process.env.KEEP_SNAPSHOTS || "8", 10));
const KEEP_DIFFS = Math.max(1, parseInt(process.env.KEEP_DIFFS || "26", 10));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let removedCount = 0;

function remove(path, label) {
  removedCount++;
  if (DRY_RUN) {
    console.log(`  [dry-run] ${label}`);
    return;
  }
  rmSync(path, { recursive: true, force: true });
  console.log(`  удалено: ${label}`);
}

/** Датированные папки одного namespace: discoveries/ или discoveries/kontur/. */
function pruneDiscoveryDirs(base, nsLabel) {
  if (!existsSync(base)) return;

  const dated = readdirSync(base)
    .filter((n) => DATE_RE.test(n))
    .filter((n) => statSync(join(base, n)).isDirectory())
    .sort();

  const excess = dated.slice(0, Math.max(0, dated.length - KEEP_DISCOVERIES));
  if (!excess.length) {
    console.log(
      `${nsLabel}: ${dated.length} папок, лимит ${KEEP_DISCOVERIES} — чистить нечего`,
    );
    return;
  }

  console.log(
    `${nsLabel}: ${dated.length} папок, оставляем ${KEEP_DISCOVERIES} свежих`,
  );
  for (const d of excess) remove(join(base, d), `${nsLabel}/${d}/`);
}

function pruneDiffs(base, nsLabel) {
  const diffsDir = join(base, "diffs");
  if (!existsSync(diffsDir)) return;

  const files = readdirSync(diffsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const excess = files.slice(0, Math.max(0, files.length - KEEP_DIFFS));
  if (!excess.length) return;

  console.log(`${nsLabel}/diffs: ${files.length} отчётов, оставляем ${KEEP_DIFFS}`);
  for (const f of excess) remove(join(diffsDir, f), `${nsLabel}/diffs/${f}`);
}

function pruneSnapshots() {
  if (!existsSync(SNAP_DIR)) return;

  const files = readdirSync(SNAP_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  const excess = files.slice(0, Math.max(0, files.length - KEEP_SNAPSHOTS));
  if (!excess.length) {
    console.log(`snapshots: ${files.length} файлов, лимит ${KEEP_SNAPSHOTS} — чистить нечего`);
    return;
  }

  console.log(`snapshots: ${files.length} файлов, оставляем ${KEEP_SNAPSHOTS} свежих`);
  for (const f of excess) remove(join(SNAP_DIR, f), `snapshots/${f}`);
}

console.log(`Ретенция Wordstat${DRY_RUN ? " (dry-run)" : ""}`);
console.log("─".repeat(60));

// Корневой namespace — только датированные папки верхнего уровня.
pruneDiscoveryDirs(DISC_DIR, "discoveries");
pruneDiffs(DISC_DIR, "discoveries");

// Вложенные namespace'ы (kontur и любые будущие): всё, что не дата и не diffs.
if (existsSync(DISC_DIR)) {
  const namespaces = readdirSync(DISC_DIR)
    .filter((n) => !DATE_RE.test(n) && n !== "diffs")
    .filter((n) => statSync(join(DISC_DIR, n)).isDirectory());

  for (const ns of namespaces) {
    pruneDiscoveryDirs(join(DISC_DIR, ns), `discoveries/${ns}`);
    pruneDiffs(join(DISC_DIR, ns), `discoveries/${ns}`);
  }
}

pruneSnapshots();

console.log("─".repeat(60));
console.log(
  removedCount === 0
    ? "Нечего удалять."
    : DRY_RUN
      ? `К удалению: ${removedCount}. Запустите без --dry-run.`
      : `Удалено: ${removedCount}.`,
);
