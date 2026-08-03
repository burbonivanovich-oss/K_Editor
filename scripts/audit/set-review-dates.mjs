#!/usr/bin/env node
// Проставляет reviewDate = pubDate + 90 дней в статьях, где его нет.
// Идемпотентен: статьи с уже существующим reviewDate не трогает.
// Не трогает draft: true.

import fs from 'node:fs';
import path from 'node:path';

const BLOG_DIR = 'src/content/blog';
const QUARTER_DAYS = 90;

const files = fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith('.md') || f.endsWith('.mdx'));

let added = 0;
const skippedDraft = [];
const skippedNoPubDate = [];

for (const f of files) {
  const filePath = path.join(BLOG_DIR, f);
  const text = fs.readFileSync(filePath, 'utf8');
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) continue;
  const fm = fmMatch[1];

  if (/^draft:\s*true/m.test(fm)) {
    skippedDraft.push(f);
    continue;
  }
  if (/^reviewDate:/m.test(fm)) continue;

  const pubMatch = fm.match(/^pubDate:\s*["']?(\d{4}-\d{2}-\d{2})/m);
  if (!pubMatch) {
    skippedNoPubDate.push(f);
    continue;
  }

  const pub = new Date(pubMatch[1] + 'T00:00:00Z');
  pub.setUTCDate(pub.getUTCDate() + QUARTER_DAYS);
  const reviewDate = pub.toISOString().slice(0, 10);

  // Вставляем reviewDate сразу после pubDate (или updatedDate если он есть).
  const anchor = fm.match(/^(updatedDate:.+|pubDate:.+)$/m);
  const anchorLine = [...fm.matchAll(/^(updatedDate:.+|pubDate:.+)$/gm)].pop()?.[0];
  if (!anchorLine) continue;

  const newFm = fm.replace(anchorLine, `${anchorLine}\nreviewDate: "${reviewDate}"`);
  const newText = text.replace(fm, newFm);
  fs.writeFileSync(filePath, newText);
  added++;
}

console.log(`Проставлен reviewDate: ${added} статей`);
if (skippedDraft.length) console.log(`Пропущено (draft): ${skippedDraft.length}`);
if (skippedNoPubDate.length) {
  console.log(`Пропущено (нет pubDate): ${skippedNoPubDate.length}`);
  for (const f of skippedNoPubDate) console.log(`  ${f}`);
}
