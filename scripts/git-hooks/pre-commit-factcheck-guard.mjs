#!/usr/bin/env node
// Pre-commit guard: блокирует commit статьи с draft: false без маркера
// .claude/factchecked/<slug>. Закрепляет 100% покрытие фактчека дисциплиной кода.
//
// Логика:
//   1. git diff --cached --name-only — получить файлы в коммите
//   2. Для каждого .md в src/content/blog/ проверить frontmatter draft
//   3. Если draft: false → требуется маркер .claude/factchecked/<slug>
//   4. Маркер — JSON {date, hash}, hash — sha256 статьи на момент факчека
//      (scripts/factcheck/write-marker.mjs). Сверяем со staged-содержимым:
//      несовпадение значит, что статью правили после факчека, и это та
//      же по духу проблема, что и отсутствие маркера — пропускать нельзя.
//   5. Если маркера нет или хеш не совпал — exit 1 с понятным сообщением
//
// Установка: scripts/git-hooks/install.sh
// Bypass (только при крайней необходимости): git commit --no-verify

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

if (process.env.SKIP_FACTCHECK_GUARD === '1') {
  console.log('SKIP_FACTCHECK_GUARD=1 — factcheck-guard пропущен.');
  process.exit(0);
}

const REPO_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
process.chdir(REPO_ROOT);

let staged;
try {
  staged = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
} catch {
  process.exit(0);
}

const blogFiles = staged.filter(
  (f) => f.startsWith('src/content/blog/') && (f.endsWith('.md') || f.endsWith('.mdx')),
);

if (blogFiles.length === 0) process.exit(0);

const missing = [];
const stale = [];

for (const f of blogFiles) {
  let staged_content;
  try {
    staged_content = execSync(`git show :${f}`, { encoding: 'utf8' });
  } catch {
    continue;
  }

  const fmMatch = staged_content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) continue;
  const fm = fmMatch[1];

  if (/^draft:\s*true/m.test(fm)) continue;
  if (!/^draft:\s*false/m.test(fm) && /^draft:/m.test(fm)) continue;

  const slug = path.basename(f).replace(/\.(md|mdx)$/, '');
  const marker = path.join(REPO_ROOT, '.claude', 'factchecked', slug);
  if (!fs.existsSync(marker)) {
    missing.push({ file: f, slug });
    continue;
  }

  let markerData;
  try {
    markerData = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    missing.push({ file: f, slug });
    continue;
  }

  const stagedHash = createHash('sha256').update(staged_content).digest('hex');
  if (markerData.hash !== stagedHash) {
    stale.push({ file: f, slug });
  }
}

if (missing.length === 0 && stale.length === 0) process.exit(0);

console.error('');
if (missing.length) {
  console.error('✗ Pre-commit guard: factcheck-маркер обязателен для draft: false');
  console.error('');
  for (const v of missing) {
    console.error(`  ${v.file}`);
    console.error(`     отсутствует или повреждён .claude/factchecked/${v.slug}`);
  }
  console.error('');
}
if (stale.length) {
  console.error('✗ Pre-commit guard: статья менялась после факчека');
  console.error('');
  for (const v of stale) {
    console.error(`  ${v.file}`);
    console.error(`     хеш .claude/factchecked/${v.slug} не совпадает с текущим содержимым`);
  }
  console.error('');
}
console.error('Варианты:');
console.error('  1. Прогнать фактчек заново: /factcheck <slug>');
console.error('     (перезапишет маркер: node scripts/factcheck/write-marker.mjs <slug>)');
console.error('  2. Если статья ещё в работе — поставить draft: true');
console.error('  3. Срочное исключение: git commit --no-verify (запиши причину в сообщение)');
console.error('');
process.exit(1);
