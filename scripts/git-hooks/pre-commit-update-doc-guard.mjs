#!/usr/bin/env node
// Pre-commit guard: блокирует коммит документа актуализации, у которого
// сломана форма — правка без цитаты «Было», правка без источника, пустой
// раздел «Что оставить как есть», промо без подводки.
//
// Проверка стоит и в процедуре (`/update-article`, шаг 5), но процедура —
// это намерение, а хук — гарантия. Разница здесь дороже обычного: сломанный
// документ правок выглядит как готовая работа. Редактор открывает его,
// видит правки без цитат и не может найти у себя места, которые надо
// заменить, — а понимает это уже после того, как отложил свои дела.
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

const docs = staged.filter(
  (f) => f.startsWith('src/content/updates/') && (f.endsWith('.md') || f.endsWith('.mdx')),
);
if (docs.length === 0) process.exit(0);

let failed = false;
for (const f of docs) {
  // README каталога — не документ актуализации.
  if (path.basename(f).toLowerCase() === 'readme.md') continue;
  try {
    execFileSync('node', [path.join(REPO_ROOT, 'scripts/check-update-doc.mjs'), f], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch {
    failed = true;
  }
}

if (failed) {
  console.error('');
  console.error('Коммит заблокирован: документ актуализации не собран до конца — см. замечания выше.');
  process.exit(1);
}

process.exit(0);
