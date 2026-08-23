/**
 * Факчек как связка «маркер + отчёт + текст статьи», проверяемая целиком.
 *
 * Почему одна функция, а не проверка по месту вызова. Сильные
 * `checkReport()` и `checkCoverage()` существовали с 13.08.2026, но
 * звались только при создании маркера. Гейт `gates.mjs` их вызывал,
 * `release-article.mjs` — нет: он читал из маркера `hash`, `date` и
 * `result` и на этом останавливался. CI смотрел ещё меньше. Поэтому все
 * десять отчётов корпуса стояли `passed`, хотя текущий `checkReport()`
 * отвергает каждый: у трёх опубликованных статей 33, 33 и 32 нарушения
 * доказательного формата.
 *
 * Маркер — это утверждение о проверке, а не сама проверка. Доверять
 * можно только тому, что перепроверяется на месте: отчёт лежит, хеш
 * сходится с текстом, доказательства в отчёте выдерживают текущий
 * контракт, а в статье не осталось значений, которых отчёт не касался.
 *
 * Связка версионирована (C-01). Отчёт хранит `schemaVersion`,
 * `articleHash`, `articleNormHash` и `policyVersion`; маркер — свою
 * `schemaVersion`, `reportHash` и `claimsHash`. Это даёт три разных
 * ответа вместо одного «проверено»: та ли версия текста, тот ли отчёт,
 * тот ли контракт. Артефакт предыдущего контракта распознаётся как
 * таковой и требует перепроверки, а не считается зелёным по умолчанию.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkReportFull } from './check-report.mjs';
import { riskOf } from './risk.mjs';
import { checkCoverage } from './check-coverage.mjs';
import { SCHEMA_VERSION, CONTRACT_VERSION, computeOutcome, outcomeToResult } from './report-schema.mjs';
import { articleHash, articleNormHash, reportHash, claimsHash, isSafeDiff, policyHash } from './hashes.mjs';
import { checkLedger } from './ledger.mjs';
import { checkClassification } from './classify.mjs';
import { verifyEvidenceSnapshot } from './snapshot.mjs';

/** Маркер старше этого — факты могли устареть, даже если текст не менялся. */
export const DEFAULT_STALE_DAYS = 180;

const ageDays = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
};

/**
 * @param {object} opts
 * @param {string} opts.root — корень репозитория или фикстуры.
 * @param {string} opts.slug — имя файла статьи без расширения.
 * @param {string} opts.articleRaw — текст статьи целиком, как на диске.
 * @param {number|null} [opts.staleDays] — порог возраста; null — не проверять.
 * @returns {{ok: boolean, marker: object|null, problems: Array<{code: string, message: string}>}}
 *
 * Проблемы возвращаются списком, а не первой попавшейся: «нет отчёта» и
 * «хеш не сошёлся» — разные починки, и знать про обе сразу полезнее.
 * Порядок — от «проверки не было вовсе» к «проверка была, но слабая».
 */
export function validateFactcheckBundle({ root, slug, articleRaw, staleDays = DEFAULT_STALE_DAYS }) {
  const problems = [];
  const add = (code, message) => problems.push({ code, message });
  const done = () => ({ ok: problems.length === 0, marker: null, problems, blocking: problems });

  const markerPath = join(root, '.claude/factchecked', slug);
  if (!existsSync(markerPath)) {
    add('no-marker', `нет маркера .claude/factchecked/${slug} — факчек не проводился`);
    return done();
  }

  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    add('marker-broken', 'маркер повреждён — нужен полный факчек заново');
    return done();
  }

  /* `info`-записи — след для разбора, не претензия: в ok они не
   * участвуют и релиз не блокируют. */
  const out = () => {
    const real = problems.filter((p) => !p.info);
    return { ok: real.length === 0, marker, problems, blocking: real };
  };

  /* Контракт артефакта. Маркер старого образца — не «почти хороший»:
   * правила, по которым его выписали, слабее нынешних, и зелёным по
   * умолчанию он быть не может. */
  if (marker.schemaVersion !== SCHEMA_VERSION) {
    add('legacy-marker',
      `маркер по контракту ${marker.schemaVersion ?? 'без версии'} при текущем ${SCHEMA_VERSION} — нужен полный факчек заново`);
  }

  /* Хеш — про версию текста, а не про качество проверки. Сначала он:
   * если статью правили после факчека, остальные претензии к отчёту
   * относятся к другому тексту. */
  if (marker.hash && marker.hash !== articleHash(articleRaw)) {
    add('hash-mismatch', 'статью правили после факчека — маркер недействителен');
  }

  if (staleDays !== null) {
    const age = ageDays(marker.date);
    if (age === null || age > staleDays) {
      add('stale', `маркер старше ${staleDays} дн. (${age ?? '?'}) — факты могли измениться`);
    }
  }

  /* Вердикт из маркера. Он не доказательство, но его отсутствие —
   * доказательство обратного: write-marker честно ставит result: null,
   * когда отчёта рядом нет. */
  if (marker.result === null || marker.result === undefined) {
    add('no-result', `маркер без результата — отчёта src/data/factcheck/results/${slug}.json нет, факчек не доведён до конца`);
  } else if (marker.result !== 'passed') {
    add('not-passed', `факчек не пройден: result «${marker.result}», критичных расхождений ${marker.criticalMismatches ?? '?'}`);
  }
  if (Number(marker.criticalMismatches) > 0) {
    add('critical-mismatches', `критических расхождений ${marker.criticalMismatches} — нужен разбор по docs/editorial-policy.md`);
  }

  /* Дальше — сам отчёт. Путь к нему хранит маркер; безымянный маркер
   * ссылается на соглашение о расположении, но проверить надо всё
   * равно наличие файла, а не веру в соглашение. */
  const reportRel = marker.report || `src/data/factcheck/results/${slug}.json`;
  const reportPath = join(root, reportRel);
  if (!marker.report) {
    add('no-report-link', 'маркер без отчёта — проверка не доведена до документа');
  }
  if (!existsSync(reportPath)) {
    add('report-missing', `отчёта ${reportRel} нет на диске`);
    return out();
  }

  let reportText;
  let report;
  try {
    reportText = readFileSync(reportPath, 'utf8');
    report = JSON.parse(reportText);
  } catch {
    add('report-broken', `отчёт ${reportRel} нечитаем`);
    return out();
  }

  /* Отчёт после выписки маркера мог измениться — сам файл или только
   * утверждения в нём. Маркер держит оба отпечатка: по файлу видно
   * переформатирование, по claims — правку по существу. */
  if (marker.reportHash && marker.reportHash !== reportHash(reportText)) {
    add('report-changed', 'отчёт менялся после выписки маркера — маркер относится к другой его версии');
  }
  if (marker.claimsHash && marker.claimsHash !== claimsHash(report.claims)) {
    add('claims-changed', 'утверждения в отчёте менялись после выписки маркера');
  }

  /* Смысловая привязка отчёта к тексту (C-02). Точный хеш выше ловит
   * любую правку, включая снятие draft самим релизом; этот — только
   * ту, что меняет текст по существу. Разошёлся он — старые
   * доказательства относятся к другой статье. */
  if (!report.articleNormHash) {
    add('no-article-hash', 'отчёт не привязан к версии текста (нет articleNormHash) — сделан по старому контракту');
  } else if (!isSafeDiff(articleRaw, report)) {
    add('semantic-drift', 'текст статьи менялся по существу после факчека — прежние доказательства к нему не относятся');
  } else if (report.articleHash && report.articleHash !== articleHash(articleRaw)) {
    /* Косметическая правка (снятие draft, экспорт из Docs) — не
     * проблема, но след о ней полезен при разборе. */
    problems.push({ code: 'safe-diff', message: 'текст отличается от зафакчеканного только формой (safe-diff)', info: true });
  }

  /* Вердикт маркера обязан следовать из утверждений отчёта, а не быть
   * переписанным из summary, которое составлял тот же проверяющий. */
  const outcome = computeOutcome(report.claims);
  const expected = outcomeToResult(outcome);
  if (marker.result && marker.result !== expected) {
    add('result-mismatch', `в маркере result «${marker.result}», а по утверждениям отчёта выходит «${expected}»`);
  }

  problems.push(...checkEvidenceChain({ root, slug, articleRaw, report }));
  return out();
}

/**
 * Доказательная цепочка со стороны отчёта: всё, что можно проверить, не
 * зная про маркер.
 *
 * Вынесено отдельно ради одной цели — чтобы `write-marker` проверял то
 * же самое, что и все остальные. Иначе получается дыра, которая уже
 * была: маркер выписывался по своему набору правил, а валидатор
 * отвергал получившуюся связку. Печать, которую сразу же не принимает
 * проверяющий, — это не печать, а лишний способ решить, что всё в
 * порядке.
 *
 * Здесь нет ничего про хеши маркера, возраст и вердикт: это свойства
 * самой печати, и проверять их до её появления не по чему.
 *
 * @returns {Array<{code: string, message: string}>}
 */
export function checkEvidenceChain({ root, slug, articleRaw, report }) {
  const problems = [];
  const add = (code, message) => problems.push({ code, message });

  /* По каким правилам и с какой строгостью разбирали.
   *
   * Дата редполитики поднималась сама — от прикосновения к файлу; хеш
   * так не поднять. Версия контракта проверок отделена от версии формы
   * артефактов: форма не менялась, когда к проверкам добавились реестр,
   * классификация и снимки, и старые отчёты проходили как современные. */
  const nowPolicy = policyHash(root);
  if (!report?.policyHash) {
    add('no-policy-hash', 'в отчёте нет policyHash — неизвестно, по какой редакции редполитики разбирали');
  } else if (nowPolicy && report.policyHash !== nowPolicy) {
    add('policy-changed', 'редполитика изменилась после проверки — прежний разбор относится к другим правилам');
  }
  if (Number(report?.contractVersion ?? 0) < CONTRACT_VERSION) {
    add('weaker-contract',
      `отчёт разобран по контракту проверок ${report?.contractVersion ?? 'без версии'} при текущем ${CONTRACT_VERSION} — нужен повторный факчек`);
  }

  /* Доказывает ли отчёт проверку.
   *
   * Эта проверка жила снаружи — в `validateFactcheckBundle`, после
   * вызова цепочки. Из-за этого `write-marker`, зовущий цепочку, её не
   * выполнял: маркер выписывался со статусом `passed` для строгого
   * утверждения без единого доказательства, а полный валидатор тут же
   * отвергал связку как `weak-evidence`. Разошлись ровно те два места,
   * которые сводились в одно.
   *
   * Место у неё здесь: она не смотрит на маркер и проверяема до его
   * появления. */
  const evidence = checkReportFull(report, `results/${slug}.json`);
  if (evidence.length) {
    const first = evidence.slice(0, 2).map((p) => `${p.id ?? '?'}: ${p.problem}`).join('; ');
    add('weak-evidence',
      `отчёт не доказывает проверку: ${evidence.length} замечаний (node scripts/factcheck/check-report.mjs ${slug}) — ${first}`);
  }

  /* Снимки первоисточников — артефакты, а не числа.
   *
   * До хранилища `snapshotHash` проверялся на форму: 64
   * шестнадцатеричных символа. Такую проверку нельзя не пройти, и поле
   * «отпечаток полученного текста» доказывало ровно ничего. Теперь
   * рядом лежит сам снимок: пересчитываем его хеш и ищем в нём цитату.
   * Офлайн — CI в сеть не ходит.
   *
   * Проверяются доказательства строгого класса: у мягких утверждений
   * первоисточник не обязателен, и требовать от них снимок значит
   * требовать снимок ссылки на словарь. */
  for (const c of report?.claims || []) {
    if (!riskOf(c).strict) continue;
    for (const [j, e] of (c.evidence || []).entries()) {
      if (e?.kind !== 'primary') continue;
      const v = verifyEvidenceSnapshot(root, e);
      if (!v.ok) {
        add('snapshot-unverified',
          `${c.id ?? `#${j}`}: доказательство не подтверждено снимком — ${v.reason}. `
          + `Снять: node scripts/factcheck/snapshot.mjs "${e.url}" --save --quote "…"`);
      }
    }
  }

  /* Замкнутость реестра (H-01). Покрытие ниже отвечает на вопрос «все ли
   * значения статьи разобраны», реестр — на более широкий: «у каждого
   * извлечённого утверждения есть исход, и ссылка ведёт туда, куда
   * заявлено». До него ссылка была видимостью: 159 утверждений корпуса
   * указывали на чужое место, и это ничем не ловилось. */
  const extractionPath = join(root, 'src/data/factcheck/claims', `${slug}.json`);
  let extraction = null;
  if (existsSync(extractionPath)) {
    try { extraction = JSON.parse(readFileSync(extractionPath, 'utf8')); } catch { extraction = null; }
  }
  if (!extraction) {
    add('no-ledger',
      `нет реестра извлечения src/data/factcheck/claims/${slug}.json — полноту разбора проверить нечем ` +
      `(node scripts/factcheck/extract-claims.mjs ${slug})`);
  } else {
    const led = checkLedger(extraction, report, `claims/${slug}.json`);
    if (led.length) {
      const first = led.slice(0, 2).map((p) => `${p.id}: ${p.problem}`).join('; ');
      add('ledger-open',
        `реестр утверждений не замкнут: ${led.length} замечаний — ${first}`);
    }
  }

  /* Замкнутость классификации (K-02). Покрытие отвечает «все ли значения
   * разобраны», реестр — «у каждого извлечённого утверждения есть
   * исход». Оба вопроса про то, что нашли. Этот — про то, чего не
   * искали: утверждение без числа обеим проверкам невидимо, а «услуги
   * блокируют накопитель» и «единого справочника кодов нет» держатся не
   * на числах. */
  const cls = checkClassification(articleRaw, report);
  if (cls.length) {
    const first = cls.slice(0, 2).map((p) => p.problem).join('; ');
    add('classification-open', `текст разобран не весь: ${cls.length} замечаний — ${first}`);
  }

  /* Доказанность разобранного — половина дела. Вторая: не осталось ли в
   * статье значений, которых в отчёте нет вовсе. Отсутствующее не
   * оставляет следа. */
  const cov = checkCoverage(articleRaw, report);
  if (cov.missing.length) {
    const list = cov.missing.slice(0, 3).map((x) => `${x.text} (строка ${x.spans[0].line})`).join(', ');
    add('coverage-gap',
      `факчеком не разбирались: ${list}${cov.missing.length > 3 ? ` и ещё ${cov.missing.length - 3}` : ''}`);
  }
  /* Разобрано — но утверждение про другое (H-04). Отдельный код, потому
   * что чинится иначе: не дописать недостающее, а разобраться, к чему
   * относится утверждение. Ровно этот случай пропустил загрязнение в
   * опубликованной статье про разрешительный режим: дата совпала,
   * утверждение было из отчёта по другому материалу. */
  if (cov.conflicting?.length) {
    const list = cov.conflicting.slice(0, 3)
      .map((x) => `${x.text} (строка ${x.spans[0].line}): ${x.reason}`)
      .join('; ');
    add('coverage-conflict',
      `утверждение расходится со статьёй по смыслу: ${list}${cov.conflicting.length > 3 ? ` и ещё ${cov.conflicting.length - 3}` : ''}`);
  }

  /* Разобрано, но не целиком: у статьи «ч. 2 ст. 14.5», а подтверждена
   * только статья. У частей разные санкции, поэтому это не мелочь — но
   * и не «не проверяли»: отдельный код, чтобы работа была понятной. */
  if (cov.partial.length) {
    const list = cov.partial.slice(0, 3)
      .map((x) => `${x.text} (строка ${x.spans[0].line}): не подтверждено ${x.unconfirmed.join(', ')}`)
      .join('; ');
    add('coverage-partial',
      `разобрано не целиком: ${list}${cov.partial.length > 3 ? ` и ещё ${cov.partial.length - 3}` : ''}`);
  }

  return problems;
}

/** Первая по порядку настоящая проблема — то, с чего чинить. */
export const firstProblem = (r) => (r.blocking?.length ? r.blocking[0].message : null);
