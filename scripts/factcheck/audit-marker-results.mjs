#!/usr/bin/env node
/**
 * Каждая выпущенная статья должна иметь пройденный факчек — не маркер, а
 * результат.
 *
 * Маркер `.claude/factchecked/<slug>` подтверждал три вещи: процедуру
 * запускали, текст с тех пор не менялся, когда это было. Ни одна из них
 * не отвечает на вопрос «а факты-то сверили». Пока никто не спрашивал,
 * пять статей из шести жили с маркером, где `result: null` — отчёта
 * `src/data/factcheck/results/<slug>.json` рядом не было вовсе
 * (12.08.2026).
 *
 * Дыру закрыли в трёх местах: write-marker.mjs больше не пишет маркер без
 * отчёта, pre-commit-хук и release-article.mjs требуют `result: passed`.
 * Этот скрипт — четвёртое: проверка на стороне CI, где нет ни хука, ни
 * человека. Хук можно обойти `--no-verify`, выпуск — руками, CI обойти
 * нельзя.
 *
 * Проверяются только выпущенные статьи (`draft: false`): черновик на то и
 * черновик, что факты в нём ещё едут.
 *
 * Запуск: node scripts/factcheck/audit-marker-results.mjs [--strict]
 *   --strict — ненулевой код возврата при находках (для CI).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.FACTCHECK_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STRICT = process.argv.includes('--strict');
const blogDir = join(ROOT, 'src', 'content', 'blog');

if (!existsSync(blogDir)) {
  console.log('src/content/blog нет — проверять нечего.');
  process.exit(0);
}

const problems = [];
let released = 0;

for (const f of readdirSync(blogDir).filter((n) => /\.mdx?$/.test(n))) {
  const content = readFileSync(join(blogDir, f), 'utf8');
  if (!/^draft:\s*false/m.test(content)) continue;
  released++;

  const slug = f.replace(/\.mdx?$/, '');
  const markerPath = join(ROOT, '.claude', 'factchecked', slug);
  if (!existsSync(markerPath)) {
    problems.push([slug, 'маркера нет — /factcheck не запускали']);
    continue;
  }

  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    problems.push([slug, 'маркер нечитаем']);
    continue;
  }

  if (marker.result === undefined || marker.result === null) {
    problems.push([slug, `нет результата — отчёта ${marker.report || 'results/<slug>.json'} не существует`]);
  } else if (marker.result !== 'passed') {
    problems.push([slug, `факчек не пройден: ${marker.result}`]);
  } else if (marker.criticalMismatches > 0) {
    problems.push([slug, `критичных расхождений: ${marker.criticalMismatches}`]);
  } else if (!existsSync(join(ROOT, marker.report || ''))) {
    // Маркер говорит «passed», а отчёта на диске нет: либо его удалили,
    // либо маркер писали не тем путём. Верить маркеру в отрыве от отчёта
    // — это ровно то, из-за чего проверка и понадобилась.
    problems.push([slug, `отчёт ${marker.report} потерян, маркеру верить нельзя`]);
  }
}

console.log(`Проверено выпущенных статей: ${released}`);
if (!problems.length) {
  console.log('\n✓ У каждой выпущенной статьи факчек доведён до отчёта.');
  process.exit(0);
}

console.log(`\n✖ Статей с недоведённым факчеком: ${problems.length}\n`);
for (const [slug, why] of problems) console.log(`  ${slug}\n    ${why}`);
console.log('\nПочинить: пройти .claude/commands/factcheck.md целиком (шаг 4 — записать отчёт),');
console.log('затем node scripts/factcheck/write-marker.mjs <slug>.');
process.exit(STRICT ? 1 : 0);
