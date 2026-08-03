#!/usr/bin/env node
// Удаляет orphaned записи из keys.json — фразы, которых уже нет в
// текущих кандидатах из blog/seo.keywords и content-plan-2026.md.
//
// Без этой уборки keys.json копит мусор: статью удалили или
// переписали с другими ключами — старые записи висят вечно,
// съедают квоту Wordstat при weekly refresh.
//
// Запуск:
//   node scripts/wordstat/cleanup-orphans.mjs            # dry-run
//   node scripts/wordstat/cleanup-orphans.mjs --apply    # реально удалить
//   node scripts/wordstat/cleanup-orphans.mjs --age 90   # пороговое окно в днях (default 90)
//
// Идемпотентен: повторный прогон с теми же данными не делает изменений.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEYS_FILE = join(ROOT, "src", "data", "wordstat", "keys.json");
const CANDIDATES_FILE = join(ROOT, "src", "data", "wordstat", ".candidates.json");
const BLOG_DIR = join(ROOT, "src", "content", "blog");
const PLAN_FILE = join(ROOT, "src", "content", "wiki", "content-plan-2026.md");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const ageIdx = args.indexOf("--age");
const ageDays = ageIdx >= 0 ? Number(args[ageIdx + 1]) : 90;

if (!existsSync(KEYS_FILE)) {
  console.error("keys.json не найден:", KEYS_FILE);
  process.exit(1);
}

// 1. Соберём актуальные ключи из источников.
const activePhrases = new Set();

if (existsSync(CANDIDATES_FILE)) {
  const c = JSON.parse(readFileSync(CANDIDATES_FILE, "utf8"));
  const arr = c.keys ?? c.candidates ?? (Array.isArray(c) ? c : []);
  for (const item of arr) {
    const phrase = typeof item === "string" ? item : item.norm || item.phrase;
    if (phrase) activePhrases.add(normalize(phrase));
  }
} else {
  // Fallback: парсим напрямую если .candidates.json не сгенерирован
  for (const f of readdirSync(BLOG_DIR).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(BLOG_DIR, f), "utf8");
    const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const keywords = fm.match(/keywords:\s*\n((?:\s*-\s.+\n?)+)/)?.[1] ?? "";
    for (const m of keywords.matchAll(/^\s*-\s*["']?(.+?)["']?\s*$/gm)) {
      activePhrases.add(normalize(m[1]));
    }
  }
  if (existsSync(PLAN_FILE)) {
    const text = readFileSync(PLAN_FILE, "utf8");
    for (const m of text.matchAll(/\|\s*["']?([^|"'\n]{8,80}?)["']?\s*\|/g)) {
      activePhrases.add(normalize(m[1]));
    }
  }
}

console.log(`Актуальных фраз: ${activePhrases.size}`);

// 2. Загрузим keys.json и найдём orphans.
const keysData = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
const keys = keysData.keys ?? {};

const now = Date.now();
const threshold = ageDays * 24 * 60 * 60 * 1000;

const orphans = [];
const kept = {};

for (const [phrase, record] of Object.entries(keys)) {
  const norm = normalize(phrase);
  const fetchedAt = record.fetchedAt ? new Date(record.fetchedAt).getTime() : 0;
  const age = now - fetchedAt;

  if (activePhrases.has(norm)) {
    kept[phrase] = record;
    continue;
  }
  // Orphan: нет в активных. Но удаляем только если age > threshold.
  if (age > threshold) {
    orphans.push({ phrase, fetchedAt: record.fetchedAt, ageDays: Math.floor(age / 86400000) });
  } else {
    kept[phrase] = record;
  }
}

console.log(`Всего записей в keys.json: ${Object.keys(keys).length}`);
console.log(`Активных (есть в источниках): ${Object.keys(keys).length - orphans.length}`);
console.log(`Orphans (нет в источниках + старше ${ageDays} дней): ${orphans.length}`);

if (orphans.length === 0) {
  console.log("\n✓ Уборка не нужна.");
  process.exit(0);
}

console.log("\nКандидаты на удаление:");
for (const o of orphans.slice(0, 20)) {
  console.log(`  ${o.phrase}  (возраст: ${o.ageDays} дней)`);
}
if (orphans.length > 20) console.log(`  ...и ещё ${orphans.length - 20}`);

if (!apply) {
  console.log(`\nDry-run. Запусти с --apply, чтобы удалить.`);
  process.exit(0);
}

keysData.keys = kept;
keysData.lastCleanup = new Date().toISOString();
writeFileSync(KEYS_FILE, JSON.stringify(keysData, null, 2) + "\n");

console.log(`\n✓ Удалено ${orphans.length} orphans. keys.json обновлён.`);

function normalize(s) {
  return s.toLowerCase().replace(/["'«»]/g, "").trim();
}
