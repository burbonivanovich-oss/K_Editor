/**
 * Сборка записи оценки для тестов — не для рантайма.
 *
 * Отдельным модулем по той же причине, что и bundle-fixture.mjs: запись
 * оценки теперь привязана к версии текста и к рубрике, и держать эту
 * сборку копиями в каждом тесте значит однажды проверять вчерашний
 * формат.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ANALYSIS_SCHEMA_VERSION, REQUIRED_CHECKS, INTENT_MATRICES } from './check-analysis.mjs';
import { articleHash, articleNormHash } from './factcheck/hashes.mjs';

const today = () => new Date().toISOString().slice(0, 10);

/** Все детерминированные проверки зелёные — тест обычно не про них. */
export const allChecksOk = (over = {}) =>
  ({ ...Object.fromEntries(REQUIRED_CHECKS.map((k) => [k, { ok: true }])), ...over });

/**
 * @param {string} root — корень фикстуры-репозитория.
 * @param {string} slug
 * @param {object} [opts] — что тест хочет сломать: балл, блокер, дату,
 *   набор проверок, привязку к тексту.
 */
/** Матрица задачи, пройденная целиком: тест обычно не про неё. */
export const intentChecksOk = (intent = 'instruction', over = {}) => ({
  ...Object.fromEntries(Object.keys(INTENT_MATRICES[intent].checks).map((k) => [k, { ok: true }])),
  ...over,
});

export function writeAnalysis(root, slug, {
  score = 95, blocker = false, checkedAt = today(), checks = allChecksOk(),
  categories, rubricVersion = today(), hashOf = null, extra = {},
  intent = 'instruction', intentChecks = null,
} = {}) {
  const artPath = ['md', 'mdx']
    .map((ext) => join(root, 'src/content/blog', `${slug}.${ext}`))
    .find(existsSync);
  const raw = hashOf ?? (artPath ? readFileSync(artPath, 'utf8') : '');

  /* Баллы раскладываются по категориям так, чтобы сойтись с итогом и с
   * числом замечаний: инвариант «замечания и баллы — одно и то же»
   * проверяет check-analysis, и фикстура обязана ему подчиняться. */
  const keys = ['lead', 'structure', 'language', 'usefulness'];
  let gap = Math.max(0, 100 - score);
  const cats = categories ?? Object.fromEntries(keys.map((k) => {
    const off = Math.min(25, gap);
    gap -= off;
    return [k, {
      score: 25 - off,
      issues: Array.from({ length: off }, (_, i) => ({ text: `замечание по «${k}» ${i + 1}`, severity: 'minor' })),
    }];
  }));

  const record = {
    slug,
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    checkedAt,
    rubricVersion,
    articleHash: articleHash(raw),
    articleNormHash: articleNormHash(raw),
    intent,
    intentChecks: intentChecks ?? intentChecksOk(intent),
    checks,
    categories: cats,
    score,
    maxScore: 100,
    blocker,
    // Блокер без причины check-analysis справедливо не принимает.
    ...(blocker ? { blockerReason: 'фикстура: блокер выставлен тестом' } : {}),
    ...extra,
  };
  mkdirSync(join(root, 'src/data/analyze'), { recursive: true });
  writeFileSync(join(root, 'src/data/analyze', `${slug}.json`), JSON.stringify(record, null, 2));
  return record;
}
