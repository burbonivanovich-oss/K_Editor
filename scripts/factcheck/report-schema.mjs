/**
 * Схема отчёта факчека: закрытые enum, обязательные поля, итог из claims.
 *
 * Раньше схемы не было вовсе. `check-report.mjs` проверял доказательства
 * у высокорисковых утверждений, но не проверял, что отчёт вообще имеет
 * форму отчёта: отсутствующий `confidence` проходил, незнакомый статус
 * проходил, опечатка в имени поля («stateent») проходила — поле просто
 * не читалось, и требование к нему считалось выполненным. Это fail-open:
 * чем хуже заполнен отчёт, тем меньше к нему претензий.
 *
 * Второе: итог отчёта объявлялся, а не выводился. `write-marker.mjs`
 * считал успехом любой `overallStatus`, кроме точного «needs-rewrite», —
 * то есть проверяющий сам себе ставил оценку, а маркер её переписывал.
 * Здесь итог считается из самих утверждений, и объявленный итог сверяется
 * с посчитанным.
 *
 * Enum закрытые намеренно. Открытый список статусов означает, что любая
 * строка — валидный статус, а «валидный статус» — это то, что не
 * блокирует. Незнакомое значение обязано быть ошибкой, а не тихо
 * считаться неопасным.
 */

/** Версия контракта артефактов факчека (отчёт + маркер). */
export const SCHEMA_VERSION = 2;

/**
 * Версия набора проверок — отдельно от версии формы артефактов.
 *
 * `SCHEMA_VERSION` отвечает за то, какие поля есть у отчёта. Он не
 * менялся, когда проверки становились строже: за один день к ним
 * добавились замкнутость реестра, классификация текста, сверка снимков
 * и согласованность вердикта с правкой. Отчёт прежней формы проходил
 * форму и молча числился проверенным по нынешним правилам.
 *
 * Число поднимается, когда меняется, что именно требуется доказать.
 * Отчёт с меньшим числом — не «почти хороший», а разобранный по более
 * слабым правилам, и это надо видеть.
 */
export const CONTRACT_VERSION = 3;

/* ── Закрытые словари ──────────────────────────────────────────────── */

/** Исход проверки одного утверждения. */
export const CLAIM_STATUSES = [
  'match',          // подтверждено первоисточником
  'mismatch',       // расходится с первоисточником
  'uncertain',      // источник не даёт однозначного ответа
  'missing',        // первоисточника в статье нет (например, нет ссылки)
  'needs-decision', // случай не покрыт редполитикой — решает редактор
  'skip',           // не проверяем по классу C редполитики
];

/** Утверждения, подтверждающие себя. Всё остальное — незакрытый вопрос. */
export const CONFIRMED_STATUSES = ['match', 'skip'];

export const SEVERITIES = ['critical', 'moderate', 'minor'];

/** Типы утверждений — то, что умеет извлекать extract-claims.mjs. */
export const CLAIM_TYPES = [
  /* MONEY_RANGE выдаёт извлечение («предупреждение или 1500–3000 ₽»),
   * а схема о нём не знала: законно извлечённое утверждение нельзя
   * было разобрать в отчёте вовсе. Словарь извлечения и словарь схемы
   * обязаны совпадать — иначе часть текста непроверяема по построению. */
  'MONEY', 'MONEY_WORDS', 'MONEY_RANGE', 'PERCENT', 'QUANTITY', 'DURATION',
  'DATE_DMY', 'DATE_TEXT', 'DATE_YEAR', 'DATE_CONTEXT',
  'NPA_FZ', 'NPA_FZ_FULL', 'NPA_PP_NUMBERED', 'NPA_PRIKAZ', 'NPA_NK',
  'NPA_KOAP', 'NPA_UK', 'NPA_PUNKT',
  'LEGAL_CLAIM', 'LEGAL_RULE', 'TECH', 'TAG', 'LINK', 'TOPIC', 'CLAIM', 'FACT',
];

/** Тип правки — из docs/factcheck.md, «Severity и action». */
export const ACTIONS = [
  'keep', 'rewrite-lede', 'rewrite-bullet', 'expand-bullet',
  'add-references', 'add-disclaimer',
];

/**
 * H-02. Какие правки совместимы с каким исходом проверки.
 *
 * Вердикт и правка — два ответа на один вопрос «что со статьёй», и они
 * обязаны сходиться. До этой таблицы не сходились: в корпусе нашлось
 * десять утверждений со `status: match` и правкой (`rewrite-bullet` ×5,
 * `add-references` ×3, `expand-bullet` ×2), из них три критических.
 * Самое показательное — c1 в отчёте по коррекции чека: `match`, а в
 * `explanation` дословно «это центральный технический факт статьи и он
 * перевёрнут». `computeOutcome` считает `match` закрытым, поэтому такой
 * claim тянул итог к `ok`, а маркер — к `passed`.
 *
 * Правило простое: `keep` — это утверждение «в тексте менять нечего», и
 * оно совместимо только с исходом, который текст подтверждает. Всё
 * остальное обязано назвать правку. Обратное тоже: если правка нужна,
 * исход не может быть `match`.
 */
export const ACTIONS_BY_STATUS = {
  match: ['keep'],
  skip: ['keep'],
  mismatch: ACTIONS.filter((a) => a !== 'keep'),
  uncertain: ACTIONS.filter((a) => a !== 'keep'),
  missing: ACTIONS.filter((a) => a !== 'keep'),
  'needs-decision': ACTIONS.filter((a) => a !== 'keep'),
};

/**
 * Сходятся ли вердикт и правка у одного утверждения.
 *
 * Отдельная функция, потому что нужна дважды: в проверке формы (как
 * замечание с объяснением) и в подсчёте итога (как причина считать
 * утверждение незакрытым). Второе — защита на случай, если отчёт попал
 * в подсчёт мимо проверки формы: противоречивый claim не должен
 * улучшать итог ни при каких обстоятельствах.
 */
export function actionMatchesStatus(claim) {
  const allowed = ACTIONS_BY_STATUS[claim?.status];
  if (!allowed) return true;            // незнакомый статус ловит проверка enum
  if (claim?.action === undefined) return false;
  return allowed.includes(claim.action);
}

/** Итог отчёта. Считается из claims, не объявляется. */
export const OVERALL_STATUSES = ['ok', 'needs-fixes', 'needs-rewrite'];

/** Поля утверждения. Всё, чего здесь нет, — опечатка либо самодеятельность. */
const CLAIM_FIELDS = new Set([
  /* `id` — адрес внутри отчёта. `claimId` — ссылка в реестр извлечения
   * (H-01). Это разные пространства имён, и разными полями они названы
   * именно поэтому: пока ссылкой служил `id`, 159 утверждений корпуса
   * резолвились в чужое место просто потому, что нумерации совпали. */
  'id', 'claimId', 'type', 'raw', 'statement', 'status', 'severity', 'confidence',
  'quote', 'sources', 'evidence', 'expectedValue', 'explanation', 'action', 'actionDetail',
  /* K-03. Разбор утверждения на части.
   *
   * `statement` — формулировка целиком, и её достаточно человеку. Машине
   * недостаточно: чтобы сверить утверждение с местом статьи, нужно знать
   * отдельно, кто субъект, что утверждается, при каких условиях и с
   * какой даты. Пока этих полей не было, покрытие сверяло числа, а
   * знак и модальность приходилось угадывать по тексту.
   *
   * Поля необязательны намеренно: требовать их от всех 303 утверждений
   * корпуса сразу значит остановить работу. Обязательны они там, где
   * решают, — это проверяет `check-report.mjs` по классу риска. */
  'span', 'subject', 'predicate', 'conditions', 'modality', 'negated', 'effectiveFrom', 'effectiveTo',
]);

/** Что утверждение делает с читателем. Согласовано с semantics.mjs. */
export const MODALITIES = ['obligation', 'permission', 'prohibition', 'statement'];

/**
 * Откуда взято доказательство.
 *
 * `primary` — страница первоисточника, которую действительно открывали:
 * есть локатор внутри документа, дата обращения, дата, на которую норма
 * действует, и отпечаток полученного текста.
 * `snippet` — выдача поиска. Она говорит, что такая строка где-то
 * встречается, и не говорит, что она есть на этой странице и в этой
 * редакции. Для значимых утверждений это не доказательство.
 */
export const EVIDENCE_KINDS = ['primary', 'snippet'];

/**
 * H-06. Чем источник является по существу — отдельно от того, как его
 * получили.
 *
 * `kind` отвечает на вопрос «страницу открывали или это выдача поиска».
 * Этого мало: обзорная статья, открытая целиком, — по-прежнему обзорная
 * статья. Ровно так прошёл срок формирования чека в статье про
 * эквайринг: отсрочку из п. 5.3 подтвердили разборами на klerk.ru и
 * forus.ru, оба открыты, оба вторичные, и ни один не показывает, что
 * норма относится к другому случаю, чем описан в статье.
 *
 * Порядок в списке — по убыванию силы. Для строгого класса `secondary`
 * даёт максимум `uncertain`, как и сниппет: вторичный материал помогает
 * понять норму, но не закрывает утверждение вместо первоисточника.
 */
export const SOURCE_ROLES = [
  'norm',             // текст самой нормы
  'officialGuidance', // официальное разъяснение применения (ФНС, Минпромторг)
  'vendorDoc',        // документация владельца системы (ЦРПТ, ОФД, вендор ККТ)
  'vendorTerms',      // тариф или условия поставщика
  'secondary',        // вторичное объяснение: обзор, блог, статья в СМИ
];

/** Роли, которых достаточно строгому классу утверждений. */
export const AUTHORITATIVE_ROLES = ['norm', 'officialGuidance', 'vendorDoc', 'vendorTerms'];

/**
 * Область действия доказательства: к кому, к чему и когда оно относится.
 *
 * Без неё «цитата с этой страницы» доказывает только существование
 * цитаты. Утверждение про ИП, подтверждённое цитатой про юрлицо, и
 * правило для ФФД 1.05, подтверждённое документом про 1.2, проходили
 * одинаково с настоящим подтверждением.
 */
const SCOPE_FIELDS = new Set(['subject', 'product', 'version', 'situation']);

const EVIDENCE_FIELDS = new Set([
  'kind', 'sourceRole', 'url', 'locator', 'retrievedAt',
  'effectiveAsOf', 'effectiveTo', 'snapshotHash', 'quote', 'scope',
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Поля отчёта верхнего уровня. */
const REPORT_FIELDS = new Set([
  'schemaVersion', 'articleHash', 'articleNormHash', 'policyVersion',
  /* `ledger` — решения по извлечённым утверждениям, которые отчёт не
   * разбирает: skipped с причиной и duplicateOf. Лежат здесь, а не в
   * файле извлечения: тот машинный и перезаписывается прогоном. */
  /* `units` — классификация единиц текста (K-02): что факт, что
   * указание к действию, а что переход и оформление. Лежит в
   * отчёте, потому что это решение проверяющего, а не свойство
   * файла статьи. */
  /* L-06. Кто проверял и кто подтверждал. Для материалов высокого
   * риска это обязаны быть разные роли: автор не подтверждает
   * собственные критические утверждения — не из недоверия, а
   * потому что он читает текст глазами того, кто его писал, и
   * видит там задуманное, а не написанное. */
  'checkedAt', 'claims', 'summary', 'ledger', 'units', 'checkedBy', 'reviewedBy',
  /* Отпечаток редполитики и версия набора проверок: по какой версии
   * правил и какой строгостью разбирали. Дату можно поднять не
   * перепроверяя, отпечаток — нет. */
  'policyHash', 'contractVersion',
  /* Журнал принятых расхождений редполитики. Пишется только через
   * `write-marker --accept-policy "<причина>"` и только растёт: каждая
   * запись говорит, что правила изменились после разбора, а разбор
   * оставили прежним — и почему. Поле существует ровно затем, чтобы
   * такое решение нельзя было принять молча. */
  'policyReview',
]);

const SUMMARY_FIELDS = new Set(['overallStatus', 'criticalIssues', 'moderateIssues', 'openIssues']);

/* ── Итог из утверждений ───────────────────────────────────────────── */

/**
 * Что следует из claims — независимо от того, что написано в summary.
 *
 * `skip` считается закрытым: класс C редполитики мы сознательно не
 * проверяем. Всё остальное, кроме `match`, — незакрытый вопрос, и вес
 * ему даёт severity.
 */
export function computeOutcome(claims) {
  /* Незакрыто всё, что не подтвердило себя статусом, — и отдельно всё,
   * где вердикт спорит с правкой (H-02). «Значение верное, но текст
   * надо переписать» — это не закрытый вопрос, каким бы ни был статус. */
  const open = (claims || []).filter(
    (c) => !CONFIRMED_STATUSES.includes(c?.status) || !actionMatchesStatus(c),
  );
  const criticalIssues = open.filter((c) => c?.severity === 'critical').length;
  const moderate = open.filter((c) => c?.severity === 'moderate').length;
  const overallStatus = criticalIssues ? 'needs-rewrite' : (open.length ? 'needs-fixes' : 'ok');
  return { overallStatus, criticalIssues, moderateIssues: moderate, openIssues: open.length };
}

/** Маркер выписывается только по итогу, который отчёт доказывает. */
export const outcomeToResult = (outcome) => (outcome.overallStatus === 'ok' ? 'passed' : 'failed');

/* ── Проверка формы ────────────────────────────────────────────────── */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Форма отчёта. Возвращает список замечаний в том же виде, что и
 * checkReport(): `{ name, id, problem }`.
 *
 * @param {object} report
 * @param {string} name — имя файла для сообщений.
 * @param {{requireVersioned?: boolean}} [opts] — требовать поля контракта
 *   C-01 (schemaVersion, articleHash, articleNormHash, policyVersion).
 *   Выключается только для проверки отчёта до миграции.
 */
export function validateReportSchema(report, name = 'отчёт', { requireVersioned = true } = {}) {
  const problems = [];
  const add = (id, problem) => problems.push({ name, id, problem });

  if (!isPlainObject(report)) return [{ name, problem: 'отчёт не разбирается' }];

  for (const k of Object.keys(report)) {
    if (!REPORT_FIELDS.has(k)) add('схема', `неизвестное поле отчёта «${k}» — опечатка или самодеятельность`);
  }

  if (requireVersioned) {
    if (report.schemaVersion !== SCHEMA_VERSION) {
      add('схема', `schemaVersion ${report.schemaVersion ?? 'нет'} — контракт ${SCHEMA_VERSION}, отчёт нужно перепроверить (migrate-bundle.mjs скажет, чего в нём не хватает)`);
    }
    for (const f of ['articleHash', 'articleNormHash', 'policyVersion']) {
      if (!report[f]) add('схема', `нет поля ${f} — отчёт не привязан к версии текста и редполитики`);
    }
  }

  const claims = Array.isArray(report.claims) ? report.claims : null;
  if (!claims) return [...problems, { name, problem: 'в отчёте нет списка claims' }];
  if (!claims.length) return [...problems, { name, problem: 'список утверждений пуст — проверять было нечего?' }];

  const seen = new Set();
  claims.forEach((c, i) => {
    const id = c?.id || `#${i + 1}`;
    if (!isPlainObject(c)) { add(id, 'утверждение не объект'); return; }

    for (const k of Object.keys(c)) {
      if (!CLAIM_FIELDS.has(k)) add(id, `неизвестное поле «${k}» — опечатка молча отменяет требование к полю`);
    }

    /* id обязателен и уникален: без него замечание не на что повесить, а
     * ссылки на утверждение из аудитов и правок не переживают
     * пересортировку списка. */
    if (!c.id || typeof c.id !== 'string') add(id, 'нет id');
    else if (seen.has(c.id)) add(id, 'id повторяется — утверждения перестают быть различимы');
    else seen.add(c.id);

    if (!CLAIM_TYPES.includes(c.type)) add(id, `тип «${c.type ?? 'нет'}» не из списка (${CLAIM_TYPES.length} известных)`);
    if (!c.raw || typeof c.raw !== 'string') add(id, 'нет raw — что именно из текста проверяли');
    if (!CLAIM_STATUSES.includes(c.status)) add(id, `статус «${c.status ?? 'нет'}» не из списка: ${CLAIM_STATUSES.join(', ')}`);
    if (!SEVERITIES.includes(c.severity)) add(id, `severity «${c.severity ?? 'нет'}» не из списка: ${SEVERITIES.join(', ')}`);

    /* Уверенность обязательна. Раньше её отсутствие означало «правило про
     * согласованность уверенности со статусом не применяется» — то есть
     * не заполнить поле было выгоднее, чем заполнить честно. */
    const conf = c.confidence;
    if (typeof conf !== 'number' || !Number.isFinite(conf)) add(id, 'нет confidence — число обязательно');
    else if (conf < 0 || conf > 1) add(id, `confidence ${conf} вне диапазона 0…1`);

    /* H-02. action обязателен и обязан сходиться со статусом.
     *
     * Обязателен — потому что раньше был опциональным, и восемь
     * утверждений корпуса обошлись без него: «что делать с текстом» не
     * ответили вовсе, а отчёт при этом считался полным. Незаполненное
     * поле не должно быть выгоднее заполненного.
     *
     * Сходится — потому что `match` + `rewrite-bullet` это два
     * противоположных ответа в одном утверждении, и до сих пор
     * побеждал тот, что улучшал итог. */
    if (c.action === undefined) {
      add(id, 'нет action — что делать с этим местом в тексте? (keep, если менять нечего)');
    } else if (!ACTIONS.includes(c.action)) {
      add(id, `action «${c.action}» не из списка: ${ACTIONS.join(', ')}`);
    } else if (CLAIM_STATUSES.includes(c.status) && !actionMatchesStatus(c)) {
      const allowed = ACTIONS_BY_STATUS[c.status].join(', ');
      add(id, c.action === 'keep'
        ? `статус «${c.status}» с action «keep»: вопрос не закрыт, а правка не названа — допустимо ${allowed}`
        : `статус «${c.status}» с правкой «${c.action}»: если текст надо менять, значение не подтверждено — допустимо ${allowed}`);
    }

    /* Пропуск — тоже решение, и у него должна быть причина. Раньше
     * `skip` был единственным статусом, который ничего не требовал:
     * ни источника, ни объяснения. «Не проверяли» без «почему» — это
     * не класс C редполитики, а пропущенный шаг. */
    if (c.status === 'skip' && !String(c.explanation || '').trim()) {
      add(id, 'skip без объяснения — почему это утверждение не проверяли?');
    }

    /* K-03. Форма разбора утверждения. Наличие полей — вопрос класса
     * риска и проверяется отдельно; здесь только то, что заполненное
     * поле заполнено правильно. */
    if (c.modality !== undefined && !MODALITIES.includes(c.modality)) {
      add(id, `modality «${c.modality}» не из списка: ${MODALITIES.join(', ')}`);
    }
    if (c.negated !== undefined && typeof c.negated !== 'boolean') {
      add(id, 'negated обязан быть true или false — «не указано» это не третье значение');
    }
    if (c.conditions !== undefined) {
      if (!Array.isArray(c.conditions)) add(id, 'conditions обязан быть списком');
      else if (c.conditions.some((x) => typeof x !== 'string' || !x.trim())) {
        add(id, 'в conditions есть пустое условие');
      }
    }
    for (const f of ['effectiveFrom', 'effectiveTo']) {
      if (c[f] !== undefined && c[f] !== null && !ISO_DATE.test(String(c[f]))) {
        add(id, `${f} не в формате ГГГГ-ММ-ДД`);
      }
    }
    if (c.subject !== undefined && !String(c.subject).trim()) add(id, 'subject пустой — либо назовите субъект, либо не заводите поле');
    if (c.span !== undefined && !String(c.span).trim()) add(id, 'span пустой');

    /* Доказательства. Форму проверяем здесь, достаточность — в
     * check-report.mjs: она зависит от класса риска утверждения. */
    if (c.evidence !== undefined) {
      if (!Array.isArray(c.evidence)) add(id, 'evidence обязан быть списком');
      else c.evidence.forEach((e, j) => {
        const eid = `${id}/evidence[${j}]`;
        if (!isPlainObject(e)) { add(eid, 'доказательство не объект'); return; }
        for (const k of Object.keys(e)) {
          if (!EVIDENCE_FIELDS.has(k)) add(eid, `неизвестное поле «${k}»`);
        }
        if (!EVIDENCE_KINDS.includes(e.kind)) add(eid, `kind «${e.kind ?? 'нет'}» не из списка: ${EVIDENCE_KINDS.join(', ')}`);
        if (typeof e.url !== 'string' || !/^https?:\/\//.test(e.url)) add(eid, 'url обязателен и должен быть ссылкой');
        if (!String(e.quote || '').trim()) add(eid, 'нет цитаты — доказательство без текста ничего не доказывает');
        if (e.retrievedAt !== undefined && !ISO_DATE.test(String(e.retrievedAt))) add(eid, 'retrievedAt не в формате ГГГГ-ММ-ДД');
        if (e.effectiveAsOf !== undefined && !ISO_DATE.test(String(e.effectiveAsOf))) add(eid, 'effectiveAsOf не в формате ГГГГ-ММ-ДД');
        if (e.effectiveTo !== undefined && e.effectiveTo !== null && !ISO_DATE.test(String(e.effectiveTo))) {
          add(eid, 'effectiveTo не в формате ГГГГ-ММ-ДД (null — норма действует бессрочно)');
        }
        if (e.sourceRole !== undefined && !SOURCE_ROLES.includes(e.sourceRole)) {
          add(eid, `sourceRole «${e.sourceRole}» не из списка: ${SOURCE_ROLES.join(', ')}`);
        }
        if (e.scope !== undefined) {
          if (!isPlainObject(e.scope)) add(eid, 'scope обязан быть объектом');
          else for (const k of Object.keys(e.scope)) {
            if (!SCOPE_FIELDS.has(k)) add(`${eid}/scope`, `неизвестное поле «${k}» — есть ${[...SCOPE_FIELDS].join(', ')}`);
          }
        }
        if (e.snapshotHash !== undefined && !SHA256.test(String(e.snapshotHash))) add(eid, 'snapshotHash не похож на sha256');
      });
    }

    if (c.status !== 'skip') {
      if (!Array.isArray(c.sources)) add(id, 'sources обязателен списком (пустой список — тоже ответ, но осознанный)');
      else if (c.sources.some((s) => typeof s !== 'string' || !/^https?:\/\//.test(s))) {
        add(id, 'в sources есть значение, которое не похоже на ссылку');
      }
    }
  });

  /* Итог обязан следовать из утверждений. Проверяющий не оценивает сам
   * себя: summary сверяется с посчитанным, а не принимается на веру. */
  const summary = report.summary;
  if (!isPlainObject(summary)) {
    add('summary', 'нет summary');
  } else {
    for (const k of Object.keys(summary)) {
      if (!SUMMARY_FIELDS.has(k)) add('summary', `неизвестное поле summary «${k}»`);
    }
    const outcome = computeOutcome(claims);
    if (!OVERALL_STATUSES.includes(summary.overallStatus)) {
      add('summary', `overallStatus «${summary.overallStatus ?? 'нет'}» не из списка: ${OVERALL_STATUSES.join(', ')}`);
    } else if (summary.overallStatus !== outcome.overallStatus) {
      add('summary', `overallStatus «${summary.overallStatus}», а по утверждениям выходит «${outcome.overallStatus}»`);
    }
    if (Number(summary.criticalIssues ?? -1) !== outcome.criticalIssues) {
      add('summary', `criticalIssues заявлено ${summary.criticalIssues ?? 'нет'}, по утверждениям выходит ${outcome.criticalIssues}`);
    }
    /* Необязательные счётчики, но если они есть — тоже про эти claims. */
    for (const f of ['moderateIssues', 'openIssues']) {
      if (summary[f] !== undefined && Number(summary[f]) !== outcome[f]) {
        add('summary', `${f} заявлено ${summary[f]}, по утверждениям выходит ${outcome[f]}`);
      }
    }
  }

  return problems;
}
