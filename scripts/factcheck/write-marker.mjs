#!/usr/bin/env node
// Записывает маркер факчека .claude/factchecked/<slug>, привязанный к
// содержимому статьи хешем.
//
// Раньше маркер был пустым файлом (или файлом с датой в виде текста):
// он подтверждал только факт «когда-то факчек прошёл», но не то, что
// статья с тех пор не менялась, не то, каким был результат, и не то, по
// какой версии редполитики его сверяли. Правка статьи после факчека —
// например, редактор поправил цифру во время вычитки — маркер не
// трогала, и все проверки (`pre-commit-factcheck-guard.mjs`,
// `/analyze-article`, `/release-article`) продолжали видеть «проверено».
//
// Хеш — sha256 полного содержимого файла на момент факчека. Любая правка
// статьи меняет хеш, и guard увидит несовпадение вместо устаревшего OK.
//
// Если рядом есть src/data/factcheck/results/<slug>.json с полем
// summary — result/criticalMismatches берутся из него. Файла нет или
// summary в нём нет — маркер всё равно пишется (хеш и дата — это
// минимум), но result/criticalMismatches остаются null: нечестно
// подставлять "passed" без реального отчёта.
//
// rulesVersion — дата последнего изменения docs/editorial-policy.md по
// git-истории: прокси для «по какой версии редполитики сверяли», без
// ручной дисциплины проставлять номер версии в самом файле.
//
// Использование: node scripts/factcheck/write-marker.mjs <slug>

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.FACTCHECK_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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

const reportPath = join(ROOT, 'src/data/factcheck/results', `${slug}.json`);
/* Без отчёта маркера не бывает.
 *
 * Раньше маркер писался и в этом случае — с result: null и честным
 * комментарием «нечестно подставлять passed без отчёта». Честность в
 * поле оказалась бесполезной: гейты смотрели на хеш и дату, а маркер на
 * диске читался всеми как «проверено». Из шести статей пять вышли
 * ровно так: процедура доходила до write-marker, шаг с отчётом
 * пропускала, и никто не спотыкался (найдено 12.08.2026).
 *
 * Поэтому теперь — отказ. Пропущенный шаг должен ломать процедуру
 * сразу, а не оставлять след, похожий на результат. */
let result = null;
let criticalMismatches = null;
if (!existsSync(reportPath)) {
  console.error(
    `✖ Нет отчёта факчека: ${reportPath.replace(ROOT + '/', '')}\n` +
    '  Маркер без отчёта — это не проверка, а её след, и все гейты примут его за проверку.\n' +
    '  Сначала шаг 4 процедуры (.claude/commands/factcheck.md): сверить claims и записать отчёт.',
  );
  process.exit(1);
}
try {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (!report.summary) throw new Error('в отчёте нет summary');
  criticalMismatches = report.summary.criticalIssues ?? 0;
  result = report.summary.overallStatus === 'needs-rewrite' ? 'failed' : 'passed';
} catch (e) {
  console.error(`✖ Отчёт ${reportPath.replace(ROOT + '/', '')} нечитаем или без summary: ${e.message}`);
  process.exit(1);
}

let rulesVersion = null;
try {
  rulesVersion = execFileSync(
    'git', ['log', '-1', '--format=%as', '--', 'docs/editorial-policy.md'],
    { encoding: 'utf8', cwd: ROOT },
  ).trim() || null;
} catch {
  /* не git-репозиторий или файла нет — не блокирующая деталь маркера */
}

const markerDir = join(ROOT, '.claude', 'factchecked');
mkdirSync(markerDir, { recursive: true });
const marker = {
  date, hash, result, criticalMismatches, rulesVersion,
  report: `src/data/factcheck/results/${slug}.json`,
};
writeFileSync(join(markerDir, slug), JSON.stringify(marker) + '\n');

console.log(
  `✓ .claude/factchecked/${slug} — hash ${hash.slice(0, 12)}…, ${date}` +
    (result ? `, ${result}` : ''),
);
