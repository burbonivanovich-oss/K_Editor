#!/usr/bin/env node
// Записывает маркер факчека .claude/factchecked/<slug>, привязанный к
// содержимому статьи хешем.
//
// Раньше маркер был пустым файлом (или файлом с датой в виде текста):
// он подтверждал только факт «когда-то факчек прошёл», но не то, что
// статья с тех пор не менялась. Правка статьи после факчека — например,
// редактор поправил цифру во время вычитки — маркер не трогала, и все
// проверки (`pre-commit-factcheck-guard.mjs`, `/analyze-article`,
// `/release-article`) продолжали видеть «проверено».
//
// Хеш — sha256 полного содержимого файла на момент факчека. Любая правка
// статьи меняет хеш, и guard увидит несовпадение вместо устаревшего OK.
//
// Использование: node scripts/factcheck/write-marker.mjs <slug>

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const slug = process.argv[2];
if (!slug) {
  console.error('Использование: node scripts/factcheck/write-marker.mjs <slug>');
  process.exit(1);
}

const candidates = [
  join(ROOT, 'src/content/blog', `${slug}.md`),
  join(ROOT, 'src/content/blog', `${slug}.mdx`),
];
const articlePath = candidates.find(existsSync);
if (!articlePath) {
  console.error(`Не найдена статья для slug «${slug}» в src/content/blog/`);
  process.exit(1);
}

const content = readFileSync(articlePath, 'utf8');
const hash = createHash('sha256').update(content).digest('hex');
const date = new Date().toISOString().slice(0, 10);

const markerDir = join(ROOT, '.claude', 'factchecked');
mkdirSync(markerDir, { recursive: true });
writeFileSync(join(markerDir, slug), JSON.stringify({ date, hash }) + '\n');

console.log(`✓ .claude/factchecked/${slug} — hash ${hash.slice(0, 12)}…, ${date}`);
