#!/usr/bin/env node
// Падает с exit code 1, если в src/content/blog/ найдены битые внутренние
// ссылки /blog/<slug>/, где <slug> не соответствует реальному файлу.
// Подключается в CI после fix-broken-blog-links.mjs как страховка от регрессий.

import fs from 'node:fs';
import path from 'node:path';
import { resolveInternalLink } from '../lib/resolve-links.mjs';

const BLOG_DIR = 'src/content/blog';

const files = fs
  .readdirSync(BLOG_DIR)
  .filter((f) => f.endsWith('.md') || f.endsWith('.mdx'));

const validSlugs = new Set(files.map((f) => f.replace(/\.(md|mdx)$/, '')));

const broken = [];

for (const f of files) {
  const text = fs.readFileSync(path.join(BLOG_DIR, f), 'utf8');
  const matches = [...text.matchAll(/\/blog\/([a-z0-9-]+)\/?/g)];
  for (const m of matches) {
    if (!validSlugs.has(m[1])) broken.push({ file: f, linked: m[1] });
  }
}

if (broken.length) {
  console.error(`Битых внутренних ссылок: ${broken.length}`);
  for (const b of broken) console.error(`  ${b.file}: /blog/${b.linked}/`);
  process.exit(1);
}

console.log('Битых внутренних ссылок не найдено.');

/* Вторая половина проверки — не про репозиторий, а про то, что увидит
 * редактор. Ссылка может указывать на существующую статью и всё равно
 * стать в Google Doc простым текстом: своего сайта у модуля нет, и адрес
 * берётся либо из BLOG_BASE_URL, либо из konturUrl целевой статьи, либо
 * из каталога Маркета при уверенном совпадении. Не блокируем сборку —
 * пары в каталоге может не быть вовсе, это нормально, — но и молчать
 * нельзя: иначе перелинковка тихо исчезает в каждом доке. */
const noUrl = new Map();
for (const f of files) {
  const text = fs.readFileSync(path.join(BLOG_DIR, f), 'utf8');
  for (const m of text.matchAll(/\]\((\/blog\/[a-z0-9-]+)\/?\)/g)) {
    if (resolveInternalLink(m[1], { blogBase: process.env.BLOG_BASE_URL || '' })) continue;
    if (!noUrl.has(m[1])) noUrl.set(m[1], new Set());
    noUrl.get(m[1]).add(f);
  }
}

if (noUrl.size) {
  console.log(`\n⚠ Ссылок, которые в доке станут текстом: ${noUrl.size}`);
  for (const [href, from] of noUrl) {
    console.log(`  ${href}`);
    console.log(`     ссылаются: ${[...from].join(', ')}`);
  }
  console.log('  Чинится полем konturUrl во frontmatter целевой статьи');
  console.log('  (docs/content-rules.md) или переменной BLOG_BASE_URL.');
}
