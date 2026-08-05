#!/usr/bin/env node
// Pre-commit guard: блокирует commit статьи с draft: false, если
// check-seo.mjs находит P0-ошибку (нет title/description, нет FAQ, нет
// внутренних ссылок и т. п.).
//
// Раньше этот гейт жил в отдельном, недокументированном наборе хуков
// (scripts/hooks/ + scripts/install-hooks.sh), который либо не был
// установлен, либо конфликтовал с документированным scripts/git-hooks/
// через core.hooksPath: git использует только один источник хуков, и
// хук, поставленный вторым методом, тогда молча не исполняется. Гейт
// перенесён сюда, второй набор хуков удалён.
//
// Установка: scripts/git-hooks/install.sh
// Bypass (только при крайней необходимости): git commit --no-verify

import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';

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

let failed = false;

for (const f of blogFiles) {
  let content;
  try {
    content = execSync(`git show :${f}`, { encoding: 'utf8' });
  } catch {
    continue;
  }
  if (!content) continue;

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch || !/^draft:\s*false/m.test(fmMatch[1])) continue;

  try {
    execFileSync('node', [path.join(REPO_ROOT, 'scripts/check-seo.mjs'), `--label=${f}`], {
      input: content,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
  } catch {
    failed = true;
  }
}

if (failed) {
  console.error('');
  console.error('Коммит заблокирован: исправьте P0-ошибки SEO выше.');
  process.exit(1);
}

process.exit(0);
