#!/usr/bin/env node
/**
 * SEO-проверка всех статей блога разом, включая P1.
 *
 * `check-seo.mjs` проверяет один файл и по умолчанию показывает только
 * блокирующие P0 — так он и стоит в pre-commit и в release-article.
 * P1 при этом никто не смотрел, и они копились: 12.08.2026 из шести
 * статей пять несли предупреждение «целевой ключ не найден в title», из
 * которых четыре были ложными (сравнивалась подстрока, а ключ из
 * Wordstat идёт в именительном и без дефисов). Предупреждение, которое
 * горит всегда, перестают читать вместе с настоящими.
 *
 * После починки самой проверки корпус чист — и этот скрипт держит планку:
 * в CI он падает на любом P0 или P1. Планка держится, только пока она
 * достижима; если правило начнёт мешать, чинить надо правило, а не
 * заводить привычку игнорировать красное.
 *
 * Запуск: node scripts/audit/check-seo-all.mjs [--strict]
 */
import { readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.SEO_AUDIT_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STRICT = process.argv.includes('--strict');
const blogDir = join(ROOT, 'src', 'content', 'blog');
const checker = join(ROOT, 'scripts', 'check-seo.mjs');

if (!existsSync(blogDir)) {
  console.log('src/content/blog нет — проверять нечего.');
  process.exit(0);
}

const files = readdirSync(blogDir).filter((f) => /\.mdx?$/.test(f)).sort();
const dirty = [];
/* Не состоявшаяся проверка — не замечание, а неизвестность, и `--strict`
 * тут ни при чём: строгий режим решает, блокируют ли P1-замечания, а
 * молчащий checker не даёт ни P0, ни P1 — он не даёт ничего. */
const broken = [];

for (const f of files) {
  let out;
  try {
    out = execFileSync('node', [checker, join(blogDir, f), '--p1'], { encoding: 'utf8' });
  } catch (e) {
    // Ненулевой код — это P0; текст отчёта скрипт всё равно печатает.
    out = (e.stdout || '') + (e.stderr || '');
  }
  /* Молчание дочерней проверки — не чистота.
   *
   * `check-seo.mjs` всегда что-то печатает: «SEO OK» либо список
   * замечаний. Пустой вывод значит, что он не отработал — упал до
   * первой строки, не нашёл файл, споткнулся о синтаксис. Раньше такая
   * статья молча попадала в «без замечаний»: чем сильнее сломан
   * checker, тем зеленее выглядел агрегатор. Ровно то же правило уже
   * стоит в `gates.mjs` для его под-скриптов. */
  if (!out.trim()) {
    dirty.push([f, ['  ✗ check-seo.mjs ничего не напечатал — проверка не состоялась, а не прошла']]);
    broken.push(f);
    continue;
  }
  const lines = out.split('\n').filter((l) => /^\s+[⚠✗]/.test(l));
  if (lines.length) dirty.push([f, lines]);
}

console.log(`Проверено статей: ${files.length}`);
if (!dirty.length) {
  console.log('\n✓ Ни одного замечания — ни P0, ни P1.');
  process.exit(0);
}

console.log(`\n✖ Статей с замечаниями: ${dirty.length}\n`);
for (const [f, lines] of dirty) {
  console.log(`  ${f}`);
  for (const l of lines) console.log(`  ${l.trim()}`);
  console.log('');
}
console.log('Разбор одной статьи: node scripts/check-seo.mjs <файл> --p1');
if (broken.length) {
  console.log(`\n✖ Проверка не состоялась на ${broken.length} статьях — это не замечание, а неизвестность.`);
  process.exit(1);
}
process.exit(STRICT ? 1 : 0);
