/**
 * Сборка факчек-связки для тестов: отчёт + маркер по текущему контракту.
 *
 * Не для рантайма — только для тестов (gates, release, порядок рутины B).
 * Отдельным модулем, а не копией в каждом тесте, по прошлому опыту:
 * когда контракт артефактов поменялся, четыре копии фикстуры пришлось
 * править синхронно, и любая забытая копия дала бы тест, который
 * проверяет вчерашний формат.
 *
 * Всё, что тест хочет сломать, ломается параметром: нет отчёта, чужой
 * хеш, старый contract, вердикт не по утверждениям.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION, CONTRACT_VERSION, computeOutcome, outcomeToResult } from './report-schema.mjs';
import { articleHash, articleNormHash, reportHash, claimsHash, policyHash } from './hashes.mjs';
import { textUnits } from './classify.mjs';
import { saveSnapshot, snapshotHash } from './snapshot.mjs';
import { draftContract } from './content-contract.mjs';

/** Доказательство с первоисточника — форма из D-02. */
export const GOOD_EVIDENCE = {
  kind: 'primary',
  sourceRole: 'norm',
  url: 'http://publication.pravo.gov.ru/document/0001202301010001',
  locator: 'статья 14.5, часть 2',
  retrievedAt: '2026-08-20',
  effectiveAsOf: '2026-08-20',
  snapshotHash: 'b'.repeat(64),
  quote: 'влечёт наложение административного штрафа на должностных лиц в размере не менее 10 000 рублей',
};

/** Утверждение, собранное как надо: сформулировано, с доказательством. */
export const GOOD_CLAIM = {
  id: 'r1',
  /* Ссылка в реестр извлечения (H-01). Фикстура пишет реестр под неё —
   * иначе связка не замкнута, и это правильно ловится валидатором. */
  claimId: 'cfix0001',
  type: 'MONEY',
  raw: '10 000 ₽',
  statement: 'штраф по ч. 2 ст. 14.5 КоАП РФ для должностных лиц — не менее 10 000 ₽',
  subject: 'должностное лицо',
  modality: 'obligation',
  status: 'match',
  severity: 'critical',
  confidence: 0.95,
  evidence: [GOOD_EVIDENCE],
  sources: ['http://publication.pravo.gov.ru/document/0001202301010001'],
  action: 'keep',
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Достроить связку до полной: снимки, реестр извлечения, классификация.
 *
 * Отдельно от `writeBundle`, потому что не все фикстуры собирают отчёт
 * через неё — часть тестов пишет свой. Без достройки такая фикстура
 * упирается не в то, что проверяет тест, а в отсутствие бумаг: реестра,
 * снимков, классификации. Тест про порядок выпуска не обязан помнить
 * про снимки первоисточников.
 */
export function completeBundle(root, slug, articleRaw, data) {
  for (const c of data?.claims ?? []) {
    if (c.evidence === undefined) c.evidence = [{ ...GOOD_EVIDENCE }];
    for (const e of c.evidence) {
      if (!e || e.kind !== 'primary') continue;
      e.snapshotHash = saveSnapshot(root, `Фикстура снимка.\n${e.quote}\nКонец.`);
    }
    if (!c.claimId) c.claimId = `cfix${String(data.claims.indexOf(c) + 1).padStart(4, '0')}`;
  }

  mkdirSync(join(root, 'src/data/factcheck/claims'), { recursive: true });
  writeFileSync(join(root, 'src/data/factcheck/claims', `${slug}.json`), JSON.stringify({
    slug,
    claims: (data?.claims ?? []).map((c) => ({ id: c.claimId, type: c.type, raw: c.raw, offset: 0, line: 1 })),
  }, null, 2));

  const list = textUnits(articleRaw);
  const table = {};
  const taken = new Set();
  for (const c of data?.claims ?? []) {
    const u = list.find((x) => !taken.has(x.id) && c.raw && x.text.includes(String(c.raw)));
    if (!u) continue;
    taken.add(u.id);
    table[u.id] = { class: 'factual' };
    c.span = u.id;
  }
  for (const u of list) if (!table[u.id]) table[u.id] = { class: 'non_factual', reason: 'фикстура' };
  if (data) data.units = table;
  return data;
}

/** Отчёт по текущему контракту для конкретного текста статьи. */
export function buildReport(articleRaw, {
  claims = [GOOD_CLAIM],
  policyVersion = '2026-08-04',
  schemaVersion = SCHEMA_VERSION,
  checkedAt = today(),
} = {}) {
  return {
    schemaVersion,
    articleHash: articleHash(articleRaw),
    articleNormHash: articleNormHash(articleRaw),
    policyVersion,
    checkedAt,
    claims,
    summary: computeOutcome(claims),
  };
}

/**
 * Пишет отчёт и маркер в фикстуру-репозиторий.
 *
 * @param {string} root — корень фикстуры.
 * @param {string} slug
 * @param {object} [opts]
 * @param {object|null} [opts.report] — готовый отчёт; null — не писать отчёт вовсе.
 * @param {Array} [opts.claims] — утверждения для отчёта по умолчанию.
 * @param {string} [opts.hashOf] — текст, от которого считать хеш маркера.
 * @param {string} [opts.result] — вердикт маркера вместо посчитанного.
 * @param {boolean} [opts.reportLink] — ссылаться ли из маркера на отчёт.
 * @param {number} [opts.schemaVersion] — версия контракта в маркере.
 * @param {Array|null} [opts.extraction] — реестр извлечения: свой список,
 *   `null` — не писать вовсе, по умолчанию собирается из отчёта.
 * @param {object|null} [opts.units] — классификация единиц текста:
 *   своя таблица, `null` — не писать вовсе, по умолчанию из текста.
 * @param {boolean} [opts.snapshots] — `false` отключает сохранение
 *   снимков первоисточников: связка остаётся с неподтверждённым
 *   отпечатком, как было до хранилища.
 */
export function writeBundle(root, slug, {
  report, claims, date = today(), hashOf = null, result, criticalMismatches,
  reportLink = true, schemaVersion = SCHEMA_VERSION, policyVersion = '2026-08-04',
  articlePath = null, extraction, units, snapshots, contract,
} = {}) {
  const artPath = articlePath || ['md', 'mdx']
    .map((ext) => join(root, 'src/content/blog', `${slug}.${ext}`))
    .find(existsSync);
  const raw = readFileSync(artPath, 'utf8');

  const rel = `src/data/factcheck/results/${slug}.json`;
  const data = report === null ? null : (report ?? buildReport(raw, { claims, policyVersion }));

  /* Утверждение без поля `evidence` фикстура достраивает.
   *
   * Отличие от пустого списка принципиальное: `evidence: []` — это
   * заявление «доказательств нет», и тест, который его пишет, проверяет
   * именно отказ. Отсутствие поля — просто краткость теста про другое,
   * и достроить его честнее, чем ронять проверку на бумажной причине. */
  for (const c of data?.claims ?? []) {
    if (c.evidence === undefined) c.evidence = [{ ...GOOD_EVIDENCE }];
  }

  /* Снимки первоисточников — по умолчанию, как и всё остальное.
   *
   * Валидатор требует, чтобы `snapshotHash` указывал на сохранённый
   * текст, в котором есть цитата. Тест про гейты про снимки не думает,
   * поэтому фикстура кладёт их сама: под каждое доказательство —
   * страничка, содержащая его цитату. Тест, которому нужна подделка,
   * ломает это явно (`snapshots: false` либо своим snapshotHash). */
  /* Печати политики и контракта проверок: фикстура здоровой связки
   * обязана быть здоровой целиком, включая «по каким правилам». */
  if (data) {
    mkdirSync(join(root, 'docs'), { recursive: true });
    if (!existsSync(join(root, 'docs/editorial-policy.md'))) {
      writeFileSync(join(root, 'docs/editorial-policy.md'), '# Редполитика фикстуры\n');
    }
    data.policyHash = policyHash(root);
    data.contractVersion = CONTRACT_VERSION;
  }

  if (data && snapshots !== false) {
    for (const c of data.claims || []) {
      for (const e of c.evidence || []) {
        if (!e || e.kind !== 'primary') continue;
        const page = `Фикстура снимка первоисточника.\n${e.quote}\nКонец документа.`;
        e.snapshotHash = saveSnapshot(root, page);
        if (snapshotHash(page) !== e.snapshotHash) throw new Error('снимок не сходится сам с собой');
      }
    }
  }

  /* Классификация единиц текста — тоже по умолчанию (K-02).
   *
   * Единица, в которой встречается цитата разбираемого утверждения,
   * помечается `factual` и связывается с ним через `span`; остальные —
   * `non_factual` с причиной. Это делает фикстуру замкнутой по
   * построению: тест про гейты не должен помнить про классификацию.
   * Тест, которому нужна дыра, ломает её явно (`units: null`). */
  if (data && units !== null) {
    const list = textUnits(raw);
    const table = {};
    /* Одно утверждение — одна единица. Цитата вроде «10 000 ₽» попадает
     * и в предложение, и в строку таблицы; пометить `factual` обе значит
     * оставить вторую без утверждения, и связка честно покраснеет. */
    const taken = new Set();
    for (const c of data.claims || []) {
      if (!c.raw) continue;
      const u = list.find((x) => !taken.has(x.id) && x.text.includes(String(c.raw)));
      if (!u) continue;
      taken.add(u.id);
      table[u.id] = { class: 'factual' };
      c.span = u.id;
    }
    for (const u of list) {
      if (!table[u.id]) table[u.id] = { class: 'non_factual', reason: 'фикстура: связующий текст' };
    }
    data.units = units ?? table;
  }

  /* Ссылка в реестр — по умолчанию, а не по требованию к каждому тесту.
   *
   * Тестов, которые проверяют гейты, релиз и порядок рутины, десятки, и
   * реестр утверждений им безразличен: они собирают отчёт своими
   * claims и хотят зелёную связку. Поэтому фикстура сама проставляет
   * claimId там, где его нет, и заводит под него запись реестра. Тест,
   * которому нужен именно незамкнутый реестр, ломает его явно —
   * `extraction: null` или свой список. */
  if (data) {
    (data.claims || []).forEach((c, i) => {
      if (c && !c.claimId) c.claimId = `cfix${String(i + 1).padStart(4, '0')}`;
    });
    data.summary = computeOutcome(data.claims);
  }

  let text = null;
  if (data) {
    mkdirSync(join(root, 'src/data/factcheck/results'), { recursive: true });
    text = JSON.stringify(data);
    writeFileSync(join(root, rel), text);
  }

  /* Реестр извлечения под отчёт (H-01).
   *
   * Собирается из самого отчёта: у каждого утверждения с `claimId`
   * заводится запись реестра с тем же id и тем же текстом. Это делает
   * связку замкнутой по построению — тест, который не про реестр, о нём
   * и не думает. Тест, который про реестр, ломает его явно:
   * `extraction: null` — реестра нет вовсе, `extraction: [...]` — свой. */
  if (data && extraction !== null) {
    mkdirSync(join(root, 'src/data/factcheck/claims'), { recursive: true });
    const entries = extraction ?? data.claims
      .filter((c) => c.claimId)
      .map((c) => ({ id: c.claimId, type: c.type, raw: c.raw, offset: 0, line: 1, context: c.raw }));
    writeFileSync(
      join(root, 'src/data/factcheck/claims', `${slug}.json`),
      JSON.stringify({ slug, claims: entries }, null, 2) + '\n',
    );
  }

  /* Контракт материала и реестр фактов — тоже часть здоровой связки.
   *
   * Гейт `contract` требует контракт, гейт `corpus` — реестр. Тест про
   * релиз не обязан помнить ни про то, ни про другое: он проверяет
   * порядок выпуска, а не бумаги. Фикстура кладёт минимально честные
   * версии, а тест, которому нужна дыра, ломает их явно. */
  if (contract !== null) {
    mkdirSync(join(root, 'src/data/contracts'), { recursive: true });
    const c = contract ?? (() => {
      const d = draftContract(slug, 'legal-review');
      d.intent = 'фикстура: закрыть вопрос читателя';
      d.audience = ['владелец бизнеса'];
      /* Профиль правового обзора требует officialGuidance; у фикстуры
       * доказательство одно и оно `norm`. Требовать второй источник от
       * теста про порядок выпуска — лишний повод его переписывать. */
      /* Требуем те роли, которые в отчёте фикстуры действительно есть.
       * Иначе тест про порядок выпуска падал бы на бумажном требовании,
       * а не на том, что проверяет. В живом корпусе роли задаёт
       * редакция — там это осмысленное решение, здесь нет. */
      const roles = [...new Set((data?.claims || [])
        .flatMap((c) => (c.evidence || []).map((e) => e?.sourceRole)).filter(Boolean))];
      d.requiredSources = roles.length ? roles : ['norm'];
      d.mustCover = d.mustCover.map((x) => ({ ...x, detect: '.' }));
      return d;
    })();
    writeFileSync(join(root, 'src/data/contracts', `${slug}.json`), JSON.stringify(c, null, 2) + '\n');
  }
  if (!existsSync(join(root, 'src/data/factcheck/facts.json'))) {
    mkdirSync(join(root, 'src/data/factcheck'), { recursive: true });
    writeFileSync(join(root, 'src/data/factcheck/facts.json'), JSON.stringify({ facts: [] }));
  }

  const outcome = data ? computeOutcome(data.claims) : null;
  mkdirSync(join(root, '.claude/factchecked'), { recursive: true });
  const marker = {
    schemaVersion,
    date,
    hash: articleHash(hashOf ?? raw),
    result: result !== undefined ? result : (outcome ? outcomeToResult(outcome) : null),
    criticalMismatches: criticalMismatches !== undefined ? criticalMismatches : (outcome ? outcome.criticalIssues : null),
    policyVersion,
    ...(text ? { reportHash: reportHash(text), claimsHash: claimsHash(data.claims) } : {}),
    ...(reportLink ? { report: rel } : {}),
  };
  writeFileSync(join(root, '.claude/factchecked', slug), JSON.stringify(marker));
  return { marker, report: data };
}
