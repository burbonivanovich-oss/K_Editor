#!/usr/bin/env node
// Регрессионный аудит: для каждой опубликованной статьи (draft: false)
// проверяет, что маркер .claude/factchecked/<slug> существует и его хеш
// совпадает с текущим содержимым файла.
//
// Зачем отдельно от pre-commit-factcheck-guard.mjs: guard сверяет
// staged-содержимое в момент коммита и обходится флагом
// git commit --no-verify. Этот скрипт сверяет закоммиченное дерево — то,
// что реально попало в main — и запускается в CI, где --no-verify уже
// ничего не даёт: если кто-то обошёл локальный хук, здесь несовпадение
// всё равно всплывёт.
//
// Использование:
//   node scripts/factcheck/audit-marker-hashes.mjs           # отчёт
//   node scripts/factcheck/audit-marker-hashes.mjs --strict  # exit 1 при находках (для CI)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const BLOG_DIR = 'src/content/blog';
const MARKERS_DIR = '.claude/factchecked';

const files = existsSync(BLOG_DIR)
  ? readdirSync(BLOG_DIR).filter((f) => f.endsWith('.md') || f.endsWith('.mdx'))
  : [];

const missing = [];
const stale = [];
let checked = 0;

for (const f of files) {
  const raw = readFileSync(join(BLOG_DIR, f), 'utf8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch || !/^draft:\s*false/m.test(fmMatch[1])) continue;

  const slug = f.replace(/\.(md|mdx)$/, '');
  checked++;
  const markerPath = join(MARKERS_DIR, slug);

  if (!existsSync(markerPath)) {
    missing.push(slug);
    continue;
  }
  let marker = null;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    missing.push(slug);
    continue;
  }
  const currentHash = createHash('sha256').update(raw).digest('hex');
  if (marker.hash !== currentHash) stale.push(slug);
}

if (checked === 0) {
  console.log('⚠ Опубликованных статей (draft: false) нет — проверять нечего.');
} else {
  console.log(`Проверено опубликованных статей: ${checked}`);
  if (missing.length) {
    console.log(`\n=== Нет маркера или он повреждён (${missing.length}) ===`);
    for (const s of missing) console.log(`  ${s}`);
  }
  if (stale.length) {
    console.log(`\n=== Хеш маркера не совпадает с закоммиченным содержимым (${stale.length}) ===`);
    console.log('Статью правили после факчека без повторного /factcheck.\n');
    for (const s of stale) console.log(`  ${s}`);
  }
  if (!missing.length && !stale.length) console.log('\n✓ Все маркеры на месте и совпадают с содержимым.');
}

if (process.argv.includes('--strict') && (missing.length || stale.length)) process.exit(1);
