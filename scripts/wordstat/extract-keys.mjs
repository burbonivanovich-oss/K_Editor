#!/usr/bin/env node
// Собирает все ключи-кандидаты для запросов в Wordstat API.
// Источники (только мультисловные информационные запросы):
//   1. src/content/blog/*.md → frontmatter.seo.keywords (приоритет 1)
//   2. src/content/wiki/content-plan-2026.md → колонка «Целевой запрос» (приоритет 1)
//
// Тэги не собираем — это категориальные ярлыки, их частота смешана
// с чужими интентами и даёт бесполезный шум.
//
// Вывод: src/data/wordstat/.candidates.json — список уникальных фраз с тегами источника.
// Файл затем читает fetch.mjs.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BLOG_DIR = join(ROOT, "src", "content", "blog");
const PLAN_FILE = join(ROOT, "src", "content", "wiki", "content-plan-2026.md");
const OUT_DIR = join(ROOT, "src", "data", "wordstat");
const OUT_FILE = join(OUT_DIR, ".candidates.json");

function stripQuotes(s) {
  return s.replace(/^["'`«»]+|["'`«»]+$/g, "");
}

function normalize(s) {
  return stripQuotes(s)
    .trim()
    .replace(/[«»"]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isUseful(norm) {
  if (!norm || norm.length < 3) return false;
  if (/^\d+$/.test(norm)) return false; // чистое число вроде "2026"
  // Минимум 2 значимых слова. Однословные ключи («штраф», «регистрация»)
  // дают сильно завышенную частоту — туда подмешиваются интенты другой
  // тематики (автомобильные штрафы, регистрация на госуслугах и т.д.).
  const tokens = norm.split(/[\s-]+/).filter(Boolean);
  if (tokens.length < 2) return false;
  return true;
}

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  return m[1];
}

function extractSeoKeywords(fm) {
  // Матчим keywords: напрямую. Двухшаговый разбор через seo:-блок ломался,
  // когда seo — последнее поле frontmatter (нет следующего top-level ключа,
  // и lookahead $ обрезал блок на строке «keywords:»). «keywords:» встречается
  // во frontmatter только внутри seo, поэтому прямой матч безопасен.
  const kwBlock = fm.match(/^\s*keywords:\s*\n((?:\s+-\s.+\n?)+)/m);
  if (!kwBlock) return [];
  return kwBlock[1]
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

function collectFromBlog() {
  // Тэги мы НЕ собираем — это категориальные ярлыки, не информационные запросы.
  // Их частота в Wordstat смешивается с чужими интентами («штраф», «алкоголь»).
  // Источник истины для частот — frontmatter.seo.keywords + content-plan.
  const items = [];
  for (const file of readdirSync(BLOG_DIR)) {
    if (!file.endsWith(".md") && !file.endsWith(".mdx")) continue;
    const full = join(BLOG_DIR, file);
    const md = readFileSync(full, "utf8");
    const fm = parseFrontmatter(md);
    if (!fm) continue;
    for (const k of extractSeoKeywords(fm)) {
      items.push({ phrase: k, priority: 1, source: `blog:${file}:seo` });
    }
  }
  return items;
}

function collectFromPlan() {
  if (!existsSync(PLAN_FILE)) return [];
  const md = readFileSync(PLAN_FILE, "utf8");
  // Таблицы вида: | # | Слаг | Тема | Целевой запрос | Приоритет |
  // Ищем строки с 5 столбцами; 4-й столбец — целевой запрос.
  const items = [];
  const lines = md.split("\n");
  let inTable = false;
  let phraseCol = -1;
  for (const line of lines) {
    if (!line.startsWith("|")) {
      inTable = false;
      phraseCol = -1;
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (!inTable) {
      // Это заголовок таблицы?
      const idx = cells.findIndex((c) => /целевой запрос/i.test(c));
      if (idx >= 0) {
        inTable = true;
        phraseCol = idx;
      }
      continue;
    }
    // Пропускаем разделитель `| --- | --- |`
    if (cells.every((c) => /^[-:\s]+$/.test(c))) continue;
    const phrase = cells[phraseCol];
    if (!phrase || phrase.startsWith("---")) continue;
    items.push({ phrase, priority: 1, source: "content-plan-2026" });
  }
  return items;
}

function main() {
  const blogItems = collectFromBlog();
  const planItems = collectFromPlan();
  const all = [...blogItems, ...planItems];

  // Дедуп по нормализованной фразе, оставляем максимальный приоритет
  // (priority 1 > priority 2; priority 1 = меньшее число).
  const byNorm = new Map();
  for (const it of all) {
    const key = normalize(it.phrase);
    if (!isUseful(key)) continue;
    const prev = byNorm.get(key);
    if (!prev) {
      byNorm.set(key, {
        phrase: stripQuotes(it.phrase.trim()),
        norm: key,
        priority: it.priority,
        sources: [it.source],
      });
    } else {
      prev.sources.push(it.source);
      if (it.priority < prev.priority) prev.priority = it.priority;
    }
  }

  const keys = [...byNorm.values()].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.norm.localeCompare(b.norm, "ru");
  });

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    counts: {
      total: keys.length,
      priority1: keys.filter((k) => k.priority === 1).length,
      priority2: keys.filter((k) => k.priority === 2).length,
    },
    keys,
  };
  writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    `extract-keys: ${payload.counts.total} unique phrases ` +
      `(P1: ${payload.counts.priority1}, P2: ${payload.counts.priority2})`,
  );
  console.log(`  → ${OUT_FILE}`);
}

main();
