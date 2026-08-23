/**
 * I-02. Метрики замкнутости: то, что должно быть нулём.
 *
 * Зачем отдельно от гейтов. Гейт отвечает «эту статью выпускать можно
 * или нет» — по одной статье и в момент выпуска. Метрики отвечают на
 * другой вопрос: движется ли корпус в правильную сторону. Разница
 * практическая: гейт молчит, пока всё зелёное, и не показывает, что
 * зелёное держится на списке исключений из десяти статей.
 *
 * Все показатели устроены одинаково: целевое значение — ноль, рост —
 * плохая новость, и ни один не считается «из головы». Каждый — прямое
 * следствие находки второго прохода аудита:
 *
 *   orphans        — 134 извлечённых утверждения не имели следа в отчётах;
 *   wrongTarget    — 159 ссылок резолвились в чужое утверждение;
 *   unlinked       — утверждение отчёта, не привязанное к реестру;
 *   weakEvidence   — high-risk без применимого первоисточника;
 *   conflicting    — утверждение расходится со статьёй по смыслу;
 *   allowlistGrown — список исключений вырос, а он может только таять.
 *
 * Показатель, который нечем посчитать, возвращается как `null`, а не как
 * ноль. Ноль означает «проверили, чисто»; `null` — «не проверяли». Это
 * ровно та разница, из-за которой весь второй проход и случился.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ledgerStats } from './ledger.mjs';
import { checkCoverage } from './check-coverage.mjs';
import { checkReport } from './check-report.mjs';
import { classificationStats } from './classify.mjs';
import { allowlistGrowth, legacyAllowlist } from './audit-bundles.mjs';

const ROOT = process.env.FACTCHECK_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = (p) => {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

/**
 * @param {string} [root]
 * @returns {{articles: number, orphans, unlinked, wrongTarget, danglingId,
 *            weakEvidence, coverageMissing, coveragePartial, coverageConflicting,
 *            allowlistGrown, allowlistDebt, allowlistBaseline, perArticle: Array}}
 */
export function closureMetrics(root = ROOT) {
  const blog = join(root, 'src/content/blog');
  const slugs = existsSync(blog)
    ? readdirSync(blog).filter((f) => /\.mdx?$/.test(f)).map((f) => f.replace(/\.mdx?$/, ''))
    : [];

  const total = {
    articles: slugs.length,
    orphans: 0, unlinked: 0, wrongTarget: 0, danglingId: 0,
    weakEvidence: 0,
    unclassifiedUnits: 0, textUnits: 0,
    /* Статья, у которой отчёта нет вовсе, не попадала ни в один
     * счётчик: она не даёт ни orphans, ни пропущенных значений —
     * потому что разбирать нечего. Ноль по всем показателям на
     * неразобранном корпусе выглядел как закрытый долг. */
    unchecked: 0,
    coverageMissing: 0, coveragePartial: 0, coverageConflicting: 0,
  };
  const perArticle = [];

  for (const slug of slugs) {
    const report = readJson(join(root, 'src/data/factcheck/results', `${slug}.json`));
    const extraction = readJson(join(root, 'src/data/factcheck/claims', `${slug}.json`));
    const articlePath = ['.md', '.mdx']
      .map((e) => join(blog, slug + e))
      .find(existsSync);
    const raw = articlePath ? readFileSync(articlePath, 'utf8') : null;

    /* Ни отчёта, ни реестра — считать нечего, но и молчать нельзя:
     * статья без разбора это не «ноль проблем». */
    if (!report || !raw) {
      total.unchecked += 1;
      perArticle.push({ slug, checked: false });
      continue;
    }

    const led = ledgerStats(extraction ?? { claims: [] }, report);
    const cov = checkCoverage(raw, report);
    const evidence = checkReport(report, slug).length;
    const cls = classificationStats(raw, report);

    total.orphans += led.orphans;
    total.unlinked += led.unlinked;
    total.wrongTarget += led.wrongTarget;
    total.danglingId += led.danglingId;
    total.weakEvidence += evidence;
    total.unclassifiedUnits += cls.unclassified;
    total.textUnits += cls.units;
    total.coverageMissing += cov.missing.length;
    total.coveragePartial += cov.partial.length;
    total.coverageConflicting += (cov.conflicting ?? []).length;

    perArticle.push({
      slug, checked: true,
      orphans: led.orphans, unlinked: led.unlinked, wrongTarget: led.wrongTarget,
      weakEvidence: evidence,
      unclassified: cls.unclassified, units: cls.units,
      missing: cov.missing.length, partial: cov.partial.length,
      conflicting: (cov.conflicting ?? []).length,
    });
  }

  const { meta } = legacyAllowlist(root);
  return {
    ...total,
    allowlistGrown: allowlistGrowth(root).length,
    allowlistDebt: (meta?.articles || []).length,
    allowlistBaseline: Array.isArray(meta?.baseline) ? meta.baseline.length : null,
    perArticle,
  };
}

/**
 * Показатели в порядке разговора: сначала то, что означает «проверки не
 * было», потом то, что означает «проверка была, но слабая».
 *
 * `null` в `value` — «посчитать нечем», и это не ноль.
 */
export function metricRows(m) {
  return [
    ['статей без разбора вовсе', m.unchecked, 'ни отчёта, ни текста — считать по ним нечего, и это не ноль проблем'],
    ['неклассифицированных единиц текста', m.unclassifiedUnits, 'предложение, строка таблицы или пункт без решения «факт или нет»'],
    ['утверждений без исхода (orphans)', m.orphans, 'у извлечённого утверждения нет ни разбора, ни решения'],
    ['утверждений без привязки к реестру', m.unlinked, 'у утверждения отчёта нет claimId'],
    ['ссылок в чужое утверждение', m.wrongTarget, 'claimId резолвится, но указывает на другое место статьи'],
    ['ссылок в никуда', m.danglingId, 'claimId такого утверждения в реестре нет'],
    ['значений статьи вне отчёта', m.coverageMissing, 'значение есть в тексте, утверждения про него нет'],
    ['разобранных не целиком', m.coveragePartial, 'подтверждена часть элементов значения'],
    ['утверждений против статьи', m.coverageConflicting, 'значение разобрано, но утверждение говорит про другое'],
    ['замечаний к доказательствам', m.weakEvidence, 'high-risk без применимого первоисточника'],
    ['новых строк в списке исключений', m.allowlistGrown, 'список может только сокращаться'],
  ];
}
