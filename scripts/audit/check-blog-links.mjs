#!/usr/bin/env node
// Падает с exit code 1, если в src/content/blog/ найдены битые внутренние
// ссылки /blog/<slug>/, где <slug> не соответствует реальному файлу.
// Подключается в CI после fix-broken-blog-links.mjs как страховка от регрессий.

import fs from 'node:fs';
import path from 'node:path';

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
