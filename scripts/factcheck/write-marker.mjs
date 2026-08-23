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
// policyVersion — дата последнего изменения docs/editorial-policy.md по
// git-истории: прокси для «по какой версии редполитики сверяли», без
// ручной дисциплины проставлять номер версии в самом файле. (Раньше поле
// называлось rulesVersion; переименовано в C-01 вместе с остальным
// контрактом артефактов.)
//
// C-01/C-02. Маркер и отчёт — версионированная связка. Отчёт получает
// schemaVersion, articleHash (точная версия текста), articleNormHash
// (смысловой отпечаток) и policyVersion; маркер — свою schemaVersion,
// reportHash и claimsHash. Это закрывает перепривязку маркера к
// изменённой статье: раньше write-marker считал хеш текущего текста, а
// отчёт своего хеша не хранил, и смысловая правка «не обязан» →
// «обязан» получала свежий маркер со старыми доказательствами, если
// набор чисел не менялся.
//
// Косметическая правка (снятый draft, экспорт из Google Docs) маркер
// перевыписать позволяет: сходится смысловой отпечаток. Смысловая — нет,
// нужен полный /factcheck.
//
// Использование: node scripts/factcheck/write-marker.mjs <slug>

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEvidenceChain } from './validate-bundle.mjs';
import { SCHEMA_VERSION, CONTRACT_VERSION, computeOutcome, outcomeToResult } from './report-schema.mjs';
import { articleHash, articleNormHash, reportHash, claimsHash, policyHash } from './hashes.mjs';

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
const hash = articleHash(content);
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
if (!existsSync(reportPath)) {
  console.error(
    `✖ Нет отчёта факчека: ${reportPath.replace(ROOT + '/', '')}\n` +
    '  Маркер без отчёта — это не проверка, а её след, и все гейты примут его за проверку.\n' +
    '  Сначала шаг 4 процедуры (.claude/commands/factcheck.md): сверить claims и записать отчёт.',
  );
  process.exit(1);
}
let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (e) {
  console.error(`✖ Отчёт ${reportPath.replace(ROOT + '/', '')} не разбирается: ${e.message}`);
  process.exit(1);
}

/* Версия редполитики, по которой сверяли: дата последнего изменения
 * docs/editorial-policy.md по git-истории. Прокси вместо ручной
 * дисциплины проставлять номер версии в самом файле. */
const policyPath = join(ROOT, 'docs/editorial-policy.md');
let policyVersion = null;
try {
  policyVersion = execFileSync(
    'git', ['log', '-1', '--format=%as', '--', 'docs/editorial-policy.md'],
    { encoding: 'utf8', cwd: ROOT },
  ).trim() || null;
} catch {
  /* не git-репозиторий — ниже запасной вариант по файлу */
}
/* Git может молчать (нет истории, свежий файл, чужая рабочая копия), но
 * пока сам файл политики на месте, версия у неё есть — дата файла. Без
 * файла версии нет вообще, и маркер выписывать не по чему: это ловит
 * проверка схемы ниже. */
if (!policyVersion && existsSync(policyPath)) {
  policyVersion = statSync(policyPath).mtime.toISOString().slice(0, 10);
}
if (!policyVersion) {
  console.error(
    '✖ Нет docs/editorial-policy.md — версию редполитики, по которой сверяли, взять неоткуда.\n' +
    '  Маркер не выписан: без policyVersion отчёт не привязан ни к каким правилам.',
  );
  process.exit(1);
}

/* C-02. Смысловая привязка отчёта к тексту.
 *
 * Отчёт, у которого отпечаток уже стоит, относится к конкретной версии
 * статьи. Совпал — можно перевыписывать маркер (правка косметическая:
 * снятый draft, чищенный экспорт из Docs). Не совпал — текст изменился
 * по существу, и прежние доказательства к нему не относятся: маркер не
 * выписываем, нужен полный факчек. */
const currentNorm = articleNormHash(content);
if (report.articleNormHash && report.articleNormHash !== currentNorm) {
  console.error(
    '✖ Статья изменилась по существу после факчека.\n' +
    '  Отпечаток текста в отчёте не совпадает с текущим — значит правка не сводится\n' +
    '  к пробелам, экранированию из Docs или полям draft/updatedDate/reviewDate.\n' +
    '  Маркер не выписан: доказательства из отчёта относятся к другой версии текста.\n' +
    `  Нужен полный факчек: /factcheck ${slug}`,
  );
  process.exit(1);
}

/* Печати контракта. articleHash ставится один раз — это версия, на
 * которой факчек реально делали; при косметической правке он остаётся
 * историческим, а сходимость держит articleNormHash. */
const before = JSON.stringify(report);
report.schemaVersion = SCHEMA_VERSION;
if (!report.articleHash) report.articleHash = articleHash(content);
if (!report.articleNormHash) report.articleNormHash = currentNorm;
if (policyVersion) report.policyVersion = policyVersion;

/* Происхождение разбора: печать ставится один раз, при самом факчеке.
 *
 * Раньше обе печати переписывались текущими значениями безусловно —
 * и `policy-changed` c `weaker-contract` в валидаторе не срабатывали
 * никогда: к моменту проверки поля уже совпадали с текущими. Отчёт,
 * разобранный по прежней редполитике, формально «повышался» до новой
 * без единого нового прочтения. Печать, которую ставит тот же прогон,
 * что её и проверяет, не свидетельствует ни о чём.
 *
 * Теперь: нет печати — ставим (это и есть момент разбора). Есть и
 * совпадает — оставляем. Есть и расходится — отказываем: правила
 * изменились после разбора, и подтвердить его может только новое
 * прочтение.
 *
 * Оговорка на правку, не меняющую смысла правил (опечатка в
 * редполитике, переверстка), — `--accept-policy "<причина>"`. Она не
 * прячет расхождение, а записывает его в отчёт полем `policyReview`:
 * дата, прежний и новый отпечаток, причина. В диффе это видно, и
 * ревью видит ровно то, что произошло. Без такой оговорки любая
 * запятая в редполитике стоила бы десяти полных факчеков — а гейт,
 * который нельзя пройти честно, проходят нечестно. */
const nowPolicy = policyHash(ROOT);
const accept = (() => {
  const i = process.argv.indexOf('--accept-policy');
  return i === -1 ? null : process.argv[i + 1];
})();

if (!report.policyHash) {
  report.policyHash = nowPolicy;
} else if (nowPolicy && report.policyHash !== nowPolicy) {
  if (!accept || accept.startsWith('--')) {
    console.error('✖ Редполитика изменилась после факчека.');
    console.error(`  В отчёте ${String(report.policyHash).slice(0, 12)}…, сейчас ${String(nowPolicy).slice(0, 12)}…`);
    console.error('  Прежний разбор относится к другим правилам, и переставить печать');
    console.error('  этим же прогоном значит подтвердить разбор самим фактом печати.\n');
    console.error(`  Разобрать заново:   /factcheck ${slug}`);
    console.error('  Либо, если правка редполитики смысла правил не меняет:');
    console.error(`    node scripts/factcheck/write-marker.mjs ${slug} --accept-policy "что изменилось и почему это не влияет на разбор"`);
    process.exit(1);
  }
  report.policyReview = [...(report.policyReview ?? []), {
    at: date, from: report.policyHash, to: nowPolicy, reason: accept,
  }];
  report.policyHash = nowPolicy;
  console.error(`⚠ Расхождение редполитики принято под запись: ${accept}`);
}

/* Версия контракта проверок — то же правило. Поднять её задним числом
 * значит объявить, что старый отчёт прошёл проверки, которых на момент
 * разбора не существовало. */
if (!report.contractVersion) {
  report.contractVersion = CONTRACT_VERSION;
} else if (Number(report.contractVersion) < CONTRACT_VERSION) {
  console.error(`✖ Отчёт разобран по контракту проверок ${report.contractVersion} при текущем ${CONTRACT_VERSION}.`);
  console.error('  Поднять версию здесь нельзя: это объявило бы пройденными проверки,');
  console.error(`  которых на момент разбора не было. Нужен полный факчек: /factcheck ${slug}`);
  process.exit(1);
}
if (!report.checkedAt) report.checkedAt = date;

/* Итог считается из утверждений, а не берётся из summary: его писал тот
 * же проверяющий, что и сами утверждения. Раньше маркер копировал
 * summary как есть и считал успехом всё, кроме точного «needs-rewrite». */
const outcome = computeOutcome(report.claims);
report.summary = outcome;

/* Между отчётом и маркером — та же проверка, что у всех остальных.
 *
 * Раньше здесь стоял свой набор: форма отчёта плюс покрытие. Набор был
 * уже, чем у валидатора, и разница была не теоретической — маркер
 * выписывался для связки, которую `validateFactcheckBundle` затем
 * отвергал: реестр не замкнут, текст не классифицирован. Печать,
 * которую сразу же не принимает проверяющий, это не печать, а ещё один
 * способ решить, что всё в порядке.
 *
 * Теперь общая функция: всё, что можно проверить, не зная про маркер,
 * проверяется до его появления. Свойства самой печати — хеши, возраст,
 * вердикт — проверит валидатор после. */
const problems = checkEvidenceChain({ root: ROOT, slug, articleRaw: content, report });
if (problems.length) {
  console.error(`✖ Связка не проходит контракт — ${problems.length} замечаний:`);
  for (const pr of problems.slice(0, 10)) console.error(`    [${pr.code}] ${pr.message.slice(0, 200)}`);
  if (problems.length > 10) console.error(`    … и ещё ${problems.length - 10}`);
  console.error('\n  Маркер не выписан. Тот же валидатор зовут гейт, релиз, CI и health —');
  console.error('  выписать печать в обход него значит соврать всем четверым сразу.');
  process.exit(1);
}

/* Отчёт мог получить печати или пересчитанный итог — тогда его надо
 * сохранить до того, как считать его хеш для маркера. */
const reportText = JSON.stringify(report, null, 2) + '\n';
if (JSON.stringify(report) !== before) writeFileSync(reportPath, reportText);
else writeFileSync(reportPath, reportText);

const result = outcomeToResult(outcome);
const criticalMismatches = outcome.criticalIssues;

const markerDir = join(ROOT, '.claude', 'factchecked');
mkdirSync(markerDir, { recursive: true });
const marker = {
  schemaVersion: SCHEMA_VERSION,
  date,
  hash,
  result,
  criticalMismatches,
  policyVersion,
  reportHash: reportHash(reportText),
  claimsHash: claimsHash(report.claims),
  report: `src/data/factcheck/results/${slug}.json`,
};
writeFileSync(join(markerDir, slug), JSON.stringify(marker) + '\n');

const safeDiff = report.articleHash !== hash;
console.log(
  `✓ .claude/factchecked/${slug} — hash ${hash.slice(0, 12)}…, ${date}, ${result}` +
    (safeDiff ? ' (косметическая правка после факчека: смысловой отпечаток сошёлся)' : ''),
);
