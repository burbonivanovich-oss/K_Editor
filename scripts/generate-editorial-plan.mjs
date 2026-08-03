#!/usr/bin/env node
/**
 * Парсит src/content/wiki/content-plan-2026.md и генерирует
 * src/data/editorial-plan.json — машиночитаемый список тем.
 *
 * Использование: node scripts/generate-editorial-plan.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

const src = readFileSync(join(ROOT, 'src/content/wiki/content-plan-2026.md'), 'utf8');
const lines = src.split('\n');

// Определяем текущий кластер
let currentCluster = '';
const clusterMap = {};
const items = [];

for (const line of lines) {
  // Заголовок кластера вида "### Кластер N. Название"
  const clusterMatch = line.match(/^###\s+Кластер\s+\d+\.\s+(.+)/);
  if (clusterMatch) {
    currentCluster = clusterMatch[1].trim();
    continue;
  }

  // Строка таблицы вида | slug | title | priority | keyword | status | blocker |
  const tableMatch = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(P[012])\s*\|\s*([^|]+?)\s*\|\s*(planned|done|draft|deprioritized)\s*\|\s*([^|]*?)\s*\|/);
  if (!tableMatch) continue;

  const [, slug, title, priority, targetKeyword, status, blocker] = tableMatch;

  // Пропускаем заголовок таблицы
  if (slug.trim() === 'Slug' || slug.trim() === '---') continue;

  const cleanSlug = slug.trim();
  const cleanBlocker = blocker.trim() === '—' ? null : blocker.trim();

  items.push({
    slug: cleanSlug,
    title: title.trim(),
    priority: priority.trim(),
    targetKeyword: targetKeyword.trim(),
    status: status.trim(),
    blocker: cleanBlocker,
    cluster: currentCluster,
  });
}

// Статистика
const stats = {
  total: items.length,
  byStatus: {},
  byPriority: {},
};
for (const item of items) {
  stats.byStatus[item.status] = (stats.byStatus[item.status] || 0) + 1;
  stats.byPriority[item.priority] = (stats.byPriority[item.priority] || 0) + 1;
}

const output = {
  _generated: new Date().toISOString().slice(0, 10),
  _source: 'src/content/wiki/content-plan-2026.md',
  stats,
  items,
};

const outPath = join(ROOT, 'src/data/editorial-plan.json');
writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
console.log(`✅ editorial-plan.json: ${items.length} тем (${stats.byStatus.planned || 0} planned, ${stats.byStatus.done || 0} done)`);
