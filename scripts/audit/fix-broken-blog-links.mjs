#!/usr/bin/env node
// Чинит внутренние ссылки вида /blog/<slug-без-даты>/ на /blog/<полный-slug>/.
// Идемпотентен: повторный прогон не делает изменений.
//
// Источник истины: имя файла в src/content/blog/ (с расширением .md/.mdx).
// Внутренние ссылки на статьи используют это имя без расширения как slug —
// именно оно должно совпадать с частью пути /blog/<slug>/.

import fs from 'node:fs';
import path from 'node:path';

const BLOG_DIR = 'src/content/blog';

const files = fs
  .readdirSync(BLOG_DIR)
  .filter((f) => f.endsWith('.md') || f.endsWith('.mdx'));

const validSlugs = new Set(files.map((f) => f.replace(/\.(md|mdx)$/, '')));

const strippedToReal = new Map();
for (const slug of validSlugs) {
  const stripped = slug.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  if (!strippedToReal.has(stripped)) strippedToReal.set(stripped, []);
  strippedToReal.get(stripped).push(slug);
}

let totalReplacements = 0;
let filesChanged = 0;
const ambiguous = [];
const unknown = [];

for (const f of files) {
  const filePath = path.join(BLOG_DIR, f);
  const original = fs.readFileSync(filePath, 'utf8');

  let changed = original.replace(/\/blog\/([a-z0-9-]+)(\/?)/g, (match, linked, trailing) => {
    if (validSlugs.has(linked)) return match;
    const candidates = strippedToReal.get(linked);
    if (!candidates) {
      unknown.push({ file: f, linked });
      return match;
    }
    if (candidates.length > 1) {
      ambiguous.push({ file: f, linked, candidates });
      return match;
    }
    totalReplacements++;
    return `/blog/${candidates[0]}/`;
  });

  if (changed !== original) {
    fs.writeFileSync(filePath, changed);
    filesChanged++;
  }
}

console.log(`Заменено ссылок: ${totalReplacements}`);
console.log(`Изменено файлов: ${filesChanged}`);
if (ambiguous.length) {
  console.log('\nНеоднозначные ссылки (несколько кандидатов) — пропущены:');
  for (const a of ambiguous) console.log(`  ${a.file}: /blog/${a.linked}/ → ${a.candidates.join(', ')}`);
}
if (unknown.length) {
  console.log('\nНеизвестные ссылки (не сопоставлены) — пропущены:');
  for (const u of unknown) console.log(`  ${u.file}: /blog/${u.linked}/`);
}
