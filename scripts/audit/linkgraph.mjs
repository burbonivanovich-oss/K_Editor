#!/usr/bin/env node
// Аудит внутренней перелинковки в блоге.
// Находит статьи без входящих ссылок («сироты»), тупики (без исходящих),
// и общую статистику. Для каждой сироты предлагает 3 кандидата на
// проставление ссылки — по совпадению категории и тегов.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BLOG_DIR = join(ROOT, "src", "content", "blog");
const OUT_DIR = join(ROOT, "src", "data", "audit");

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  return m ? { fm: m[1], body: md.slice(m[0].length) } : { fm: "", body: md };
}

function getList(fm, key) {
  const re = new RegExp(`^${key}:\\s*\\n((?:\\s+- .+\\n?)+)`, "m");
  const m = fm.match(re);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

function getField(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"));
  return m ? m[1].trim() : null;
}

function extractInternalLinks(body) {
  const links = new Set();
  // markdown links вида [текст](/blog/slug/) или (/blog/slug)
  const re = /\]\((\/blog\/([^)\s#]+?))\/?(?:#[^)\s]*)?\)/g;
  let m;
  while ((m = re.exec(body))) {
    links.add(m[2]); // только slug
  }
  return [...links];
}

function buildGraph() {
  const articles = new Map(); // slug → { slug, title, categories, tags, outbound[], inbound[], draft }
  for (const f of readdirSync(BLOG_DIR)) {
    if (!f.endsWith(".md") && !f.endsWith(".mdx")) continue;
    const slug = f.replace(/\.(md|mdx)$/, "");
    const md = readFileSync(join(BLOG_DIR, f), "utf8");
    const { fm, body } = parseFrontmatter(md);
    articles.set(slug, {
      slug,
      title: getField(fm, "title"),
      categories: getList(fm, "categories"),
      tags: getList(fm, "tags"),
      draft: /^draft:\s*true/m.test(fm),
      outbound: extractInternalLinks(body),
      inbound: [],
    });
  }
  // inbound — обратный обход
  for (const [slug, a] of articles) {
    for (const target of a.outbound) {
      const t = articles.get(target);
      if (t) t.inbound.push(slug);
    }
  }
  return articles;
}

function suggestSourcesFor(orphan, articles, limit = 3) {
  // Кандидаты — статьи с пересечением категории/тегов, не draft, не сам orphan.
  const candidates = [];
  for (const [slug, a] of articles) {
    if (slug === orphan.slug || a.draft) continue;
    const catOverlap = a.categories.filter((c) => orphan.categories.includes(c)).length;
    const tagOverlap = a.tags.filter((t) => orphan.tags.includes(t)).length;
    const score = catOverlap * 2 + tagOverlap;
    if (score === 0) continue;
    // Меньше outbound = легче добавить ссылку без перегруза
    candidates.push({ slug, title: a.title, score, outboundCount: a.outbound.length });
  }
  candidates.sort((a, b) => b.score - a.score || a.outboundCount - b.outboundCount);
  return candidates.slice(0, limit);
}

function main() {
  const articles = buildGraph();
  const published = [...articles.values()].filter((a) => !a.draft);
  const orphans = published.filter((a) => a.inbound.length === 0);
  const deadends = published.filter((a) => a.outbound.length === 0);
  const weak = published.filter((a) => a.inbound.length === 1);

  // Топ по входящим
  const topInbound = [...published]
    .sort((a, b) => b.inbound.length - a.inbound.length)
    .slice(0, 10);

  const report = {
    generatedAt: new Date().toISOString(),
    totals: {
      total: articles.size,
      published: published.length,
      drafts: articles.size - published.length,
      orphans: orphans.length,
      weak: weak.length,
      deadends: deadends.length,
    },
    orphans: orphans.map((o) => ({
      slug: o.slug,
      title: o.title,
      categories: o.categories,
      outboundCount: o.outbound.length,
      suggestions: suggestSourcesFor(o, articles),
    })),
    weak: weak.map((w) => ({
      slug: w.slug,
      title: w.title,
      inbound: w.inbound,
    })),
    deadends: deadends.map((d) => ({ slug: d.slug, title: d.title })),
    topInbound: topInbound.map((a) => ({
      slug: a.slug,
      title: a.title,
      inboundCount: a.inbound.length,
    })),
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, "linkgraph.json"),
    JSON.stringify(report, null, 2) + "\n",
  );

  console.log(`Linkgraph: ${published.length} опубликованных статей`);
  console.log(`  🔴 сирот (0 входящих):  ${orphans.length}`);
  console.log(`  🟡 слабых (1 входящая): ${weak.length}`);
  console.log(`  🟠 тупиков (0 исходящих): ${deadends.length}`);
  console.log();
  if (report.orphans.length) {
    console.log("Сироты (требуют входящих ссылок) — первые 10:");
    for (const o of report.orphans.slice(0, 10)) {
      console.log(`  • ${o.slug}`);
      for (const s of o.suggestions) {
        console.log(`      ← ${s.slug} (score ${s.score})`);
      }
    }
    if (report.orphans.length > 10) {
      console.log(`  …и ещё ${report.orphans.length - 10}`);
    }
  }
  console.log();
  console.log(`Отчёт: ${join(OUT_DIR, "linkgraph.json")}`);
}

main();
