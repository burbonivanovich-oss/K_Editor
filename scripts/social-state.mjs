#!/usr/bin/env node
/**
 * Память об адаптациях статьи под площадки.
 *
 * Раньше состояния не было вовсе: понять через месяц, что по статье уже
 * делали Telegram и VK, а Дзен и email — нет, было неоткуда. Хуже того,
 * сам результат лежал в `.claude/social/`, который в .gitignore, — при
 * новой сессии или чистой рабочей копии готовый текст просто исчезал.
 *
 * Поэтому здесь два изменения разом: состояние в git и текст адаптаций
 * в git (`src/data/social/<slug>.md`), а не в игнорируемой папке.
 *
 * Запуск:
 *   node scripts/social-state.mjs get <slug>
 *   node scripts/social-state.mjs list [--pending]
 *   node scripts/social-state.mjs mark <slug> --platform telegram [--doc-id <id>]
 *   node scripts/social-state.mjs unmark <slug> --platform telegram
 *
 * Файл src/data/social-adaptations.json руками не редактируется.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from './lib/is-main.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "src", "data", "social-adaptations.json");

export const PLATFORMS = ["telegram", "vk", "dzen", "email", "promo"];

const PLATFORM_LABELS = {
  telegram: "Telegram",
  vk: "VK",
  dzen: "Дзен",
  email: "Email-дайджест",
  promo: "Промостраница",
};

function load() {
  if (!existsSync(FILE)) return { schemaVersion: 1, articles: {} };
  return JSON.parse(readFileSync(FILE, "utf8"));
}

function save(data) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n");
}

const today = () => new Date().toISOString().slice(0, 10);

export function get(slug, data = load()) {
  const entry = data.articles[slug];
  const done = entry?.platforms ?? {};
  return {
    slug,
    done: Object.keys(done),
    pending: PLATFORMS.filter((p) => !done[p]),
    platforms: done,
    file: entry?.file ?? null,
  };
}

export function mark(slug, platform, { docId = null, file = null } = {}) {
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`Неизвестная площадка: ${platform}. Есть: ${PLATFORMS.join(", ")}`);
  }
  const data = load();
  const entry = (data.articles[slug] ??= { platforms: {} });
  entry.platforms[platform] = { adaptedAt: today(), docId };
  if (file) entry.file = file;
  save(data);
  return get(slug, data);
}

export function unmark(slug, platform) {
  const data = load();
  const entry = data.articles[slug];
  if (entry?.platforms) delete entry.platforms[platform];
  save(data);
  return get(slug, data);
}

/* ─────────────────────────────────────────────────────────────── CLI ── */

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
};

if (isMain(import.meta.url)) {
  const cmd = process.argv[2];
  const slug = process.argv[3];

  if (cmd === "get") {
    if (!slug) { console.error("нужен slug"); process.exit(2); }
    const s = get(slug);
    console.log(`Статья: ${slug}`);
    console.log(`Сделано:  ${s.done.map((p) => PLATFORM_LABELS[p]).join(", ") || "ничего"}`);
    console.log(`Осталось: ${s.pending.map((p) => PLATFORM_LABELS[p]).join(", ") || "всё готово"}`);
    for (const [p, meta] of Object.entries(s.platforms)) {
      console.log(`  ${PLATFORM_LABELS[p]} — ${meta.adaptedAt}${meta.docId ? ` (док ${meta.docId})` : ""}`);
    }
  } else if (cmd === "list") {
    const data = load();
    const onlyPending = process.argv.includes("--pending");
    const slugs = Object.keys(data.articles).sort();
    if (!slugs.length) { console.log("Пока ни одной адаптации."); process.exit(0); }
    for (const s of slugs) {
      const st = get(s, data);
      if (onlyPending && !st.pending.length) continue;
      console.log(`${s}`);
      console.log(`  готово: ${st.done.join(", ") || "—"}`);
      console.log(`  нет:    ${st.pending.join(", ") || "—"}`);
    }
  } else if (cmd === "mark" || cmd === "unmark") {
    const platform = arg("platform");
    if (!slug || !platform) {
      console.error(`нужен slug и --platform (${PLATFORMS.join("|")})`);
      process.exit(2);
    }
    let st;
    try {
      st = cmd === "mark"
        ? mark(slug, platform, { docId: arg("doc-id"), file: arg("file") })
        : unmark(slug, platform);
    } catch (err) {
      console.error(err.message);
      process.exit(2);
    }
    console.log(`✓ ${slug}: готово — ${st.done.join(", ") || "—"}; осталось — ${st.pending.join(", ") || "—"}`);
  } else {
    console.log("Команды: get <slug> | list [--pending] | mark <slug> --platform <p> | unmark <slug> --platform <p>");
    process.exit(2);
  }
}
