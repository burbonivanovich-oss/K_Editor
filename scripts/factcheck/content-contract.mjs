/**
 * K-01. Контракт материала: что статья обязана закрыть, решается до текста.
 *
 * Зачем. Все проверки репозитория смотрят на готовый текст и отвечают на
 * вопрос «нет ли здесь ошибки». Ни одна не отвечает на другой вопрос —
 * «сделано ли то, что обещано». Разница видна на живых материалах:
 * таблица кодов ошибок ТС ПИоТ сама признаёт, что единого справочника
 * кодов нет, и тут же выдаёт 401/500/453/514 как рабочие значения. Это
 * не ошибка факта — каждый код у кого-то из поставщиков действительно
 * такой. Это невыполненное обещание: материал, который берётся объяснить
 * ошибку на кассе, обязан назвать поставщика и версию, иначе читатель
 * действует по чужой таблице.
 *
 * Контракт заводится до черновика и говорит три вещи:
 *
 *   mustCover      — что обязано быть закрыто. Не «раздел с таким
 *                    заголовком», а содержание: причина, безопасное
 *                    действие, проверка результата, неуспешный сценарий;
 *   mustNotClaim   — чего утверждать нельзя. Тот самый случай с кодами;
 *   requiredSources — какие роли источников обязаны участвовать. Обзор
 *                    вместо разъяснения ФНС закрывает вопрос только на
 *                    вид, и это уже случалось.
 *
 * Каждый пункт `mustCover` и `mustNotClaim` несёт выражение, по которому
 * его проверяют. Пункт без выражения — не требование, а пожелание:
 * оно не проверяется, и полагаться на него нельзя. Поэтому контракт без
 * выражений не проходит форму.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.FACTCHECK_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const RISK_TIERS = ['high', 'medium', 'low'];

/**
 * Профили по типу материала.
 *
 * Минимум, ниже которого контракт этого типа опускаться не может. Автор
 * вправе потребовать больше — и не вправе меньше: если материал
 * называется инструкцией, читатель ждёт от него порядка действий, а не
 * рассуждения о предмете.
 */
export const PROFILES = {
  instruction: {
    title: 'Инструкция',
    riskTier: 'medium',
    /* Инструкция и разбор ошибок без продукта и версии — совет
     * «вообще»: ровно тот случай, из-за которого в корпусе появился
     * «универсальный справочник кодов». Такому материалу scope
     * обязателен. Правовому обзору и актуализации — нет: они про
     * норму, а не про модель кассы. */
    needsScope: true,
    mustCover: [
      { id: 'prerequisites', what: 'что нужно иметь до начала', detect: 'до\\s+начала|понадобится|потребуется|заранее|перед\\s+тем' },
      { id: 'role', what: 'кто выполняет действие', detect: 'кассир|администратор|бухгалтер|руководител|владелец|сотрудник' },
      { id: 'result', what: 'как убедиться, что получилось', detect: 'убедит|проверьте|появится|отобразится|результат' },
      { id: 'rollback', what: 'что делать, если не получилось', detect: 'не\\s+помогло|если\\s+ошибка|не\\s+получилось|откат|вернуть' },
      { id: 'escalation', what: 'к кому идти, если не решается', detect: 'поставщик|поддержк|обратитесь|уточняйте' },
    ],
  },
  troubleshooting: {
    title: 'Разбор ошибок',
    riskTier: 'high',
    /* Инструкция и разбор ошибок без продукта и версии — совет
     * «вообще»: ровно тот случай, из-за которого в корпусе появился
     * «универсальный справочник кодов». Такому материалу scope
     * обязателен. Правовому обзору и актуализации — нет: они про
     * норму, а не про модель кассы. */
    needsScope: true,
    mustCover: [
      { id: 'symptom', what: 'точный симптом, который видит читатель', detect: 'ошибк|сообщени|код|не\\s+проходит|блокиру' },
      { id: 'product-version', what: 'продукт и версия, к которым относится разбор', detect: 'ФФД\\s*1\\.\\d|версия|поставщик|модель' },
      { id: 'cause', what: 'причина, а не только симптом', detect: 'причина|потому\\s+что|из-за|означает' },
      { id: 'stop-condition', what: 'когда останавливаться и не продолжать', detect: 'нельзя|остановит|не\\s+продавайте|снять\\s+с\\s+продажи|прекрат' },
      { id: 'escalation', what: 'к кому идти, если не решается', detect: 'поставщик|поддержк|обратитесь|уточняйте' },
    ],
    mustNotClaim: [
      {
        id: 'universal-codes',
        what: 'коды ошибок как универсальный справочник, без поставщика и версии',
        detect: 'универсальн\\p{L}*\\s+справочник|одинаков\\p{L}*\\s+у\\s+всех\\s+касс',
      },
    ],
  },
  'legal-review': {
    title: 'Правовой обзор',
    riskTier: 'high',
    mustCover: [
      { id: 'norm', what: 'названа норма', detect: 'ст\\.|стать|пункт|п\\.\\s*\\d|постановлен|федеральн\\p{L}*\\s+закон' },
      { id: 'effective-dates', what: 'сказано, с какой даты требование действует', detect: 'с\\s+\\d{1,2}[.\\s]|действует\\s+с|вступ\\p{L}*\\s+в\\s+силу' },
      { id: 'who-applies', what: 'сказано, на кого распространяется', detect: 'ИП|юридическ|организац|предпринимател|распространя' },
      { id: 'exceptions', what: 'названы исключения', detect: 'исключен|кроме|не\\s+распространя|освобожда' },
      { id: 'consequences', what: 'названо, что бывает за нарушение', detect: 'штраф|ответственност|КоАП|санкц' },
    ],
  },
  comparison: {
    title: 'Сравнение',
    riskTier: 'medium',
    mustCover: [
      { id: 'assumptions', what: 'допущения расчёта названы', detect: 'допуск|исходим|при\\s+услови|для\\s+примера|условно' },
      { id: 'cost-example', what: 'есть пример с деньгами', detect: '₽|руб' },
      { id: 'scenarios', what: 'разобрано больше одного сценария', detect: 'если\\s+вы|для\\s+тех,\\s+кто|в\\s+случае' },
      { id: 'disqualifiers', what: 'сказано, кому вариант не подходит', detect: 'не\\s+подойд|не\\s+подходит|не\\s+стоит|откажитесь' },
    ],
  },
  update: {
    title: 'Актуализация',
    riskTier: 'high',
    mustCover: [
      { id: 'what-changed', what: 'что именно изменилось', detect: 'изменил|поменял|стало|теперь|вместо' },
      { id: 'what-stayed', what: 'что осталось прежним', detect: 'остал|не\\s+измен|по-прежнему|как\\s+и\\s+раньше' },
      { id: 'related', what: 'какие связанные материалы затронуты', detect: 'см\\.|также|связанн|смежн' },
    ],
  },
};

export const CONTENT_TYPES = Object.keys(PROFILES);

const CONTRACT_DIR = 'src/data/contracts';

export const contractPath = (slug, root = ROOT) => join(root, CONTRACT_DIR, `${slug}.json`);

export function loadContract(slug, root = ROOT) {
  const p = contractPath(slug, root);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { broken: true }; }
}

/** Заготовка контракта по типу — то, с чего начинают, а не то, чем заканчивают. */
export function draftContract(slug, contentType) {
  const profile = PROFILES[contentType];
  if (!profile) throw new Error(`неизвестный тип материала: ${contentType}`);
  return {
    slug,
    contentType,
    intent: '',
    audience: [],
    riskTier: profile.riskTier,
    scope: { products: [], versions: [], validAsOf: new Date().toISOString().slice(0, 10) },
    /* Копия, а не ссылка на профиль. Иначе первый же вызывающий,
     * дописавший пункт в свой контракт, меняет профиль для всех
     * последующих статей этого типа — в том же процессе и молча. */
    mustCover: structuredClone(profile.mustCover),
    mustNotClaim: structuredClone(profile.mustNotClaim ?? []),
    requiredSources: profile.riskTier === 'high' ? ['norm', 'officialGuidance'] : ['officialGuidance'],
  };
}

/** Форма контракта. */
export function validateContract(contract) {
  const problems = [];
  const add = (problem) => problems.push({ id: contract?.slug ?? '—', problem });

  if (!contract) return [{ id: '—', problem: 'контракта нет' }];
  if (contract.broken) return [{ id: '—', problem: 'контракт не разбирается' }];

  if (!CONTENT_TYPES.includes(contract.contentType)) {
    add(`contentType «${contract.contentType ?? 'нет'}» не из списка: ${CONTENT_TYPES.join(', ')}`);
  }
  if (!String(contract.intent || '').trim()) add('нет intent — чему статья должна помочь читателю');
  if (!Array.isArray(contract.audience) || !contract.audience.length) add('нет audience — кто это читает');
  if (!RISK_TIERS.includes(contract.riskTier)) add(`riskTier «${contract.riskTier ?? 'нет'}» не из списка: ${RISK_TIERS.join(', ')}`);
  if (!contract.scope?.validAsOf) add('нет scope.validAsOf — на какую дату материал верен');

  const profile = PROFILES[contract.contentType];
  if (profile) {
    /* Предметный scope там, где без него совет бессмыслен.
     *
     * Девять контрактов корпуса были формально валидны с пустыми
     * `products` и `versions`: форма их не требовала, и «что делать при
     * ошибке» относилось ко всем кассам сразу. Это та же болезнь, что
     * `mustNotClaim: universal-codes` запрещает в тексте, — только на
     * уровне контракта, где её никто не проверял. */
    if (profile.needsScope) {
      const named = [...(contract.scope?.products ?? []), ...(contract.scope?.versions ?? [])]
        .filter((x) => String(x ?? '').trim());
      if (!named.length) {
        add(`профиль «${profile.title}» без scope.products и scope.versions — `
          + 'совет без продукта и версии относится ко всему сразу, то есть ни к чему');
      }
    }

    /* Понижение уровня риска — решение, а не настройка.
     *
     * riskTier управляет силой проверок: на `high` нужны разные
     * `checkedBy` и `reviewedBy` и роль `norm` среди источников.
     * Опустить его в контракте значило ослабить проверки правкой одного
     * слова, и форма этого не замечала. Поднять можно свободно —
     * ужесточение в объяснении не нуждается. */
    const rank = (t) => RISK_TIERS.indexOf(t);
    if (rank(contract.riskTier) > rank(profile.riskTier)) {
      if (!String(contract.riskTierReason || '').trim()) {
        add(`riskTier «${contract.riskTier}» ниже профильного «${profile.riskTier}» без riskTierReason — `
          + 'понижение ослабляет проверки и обязано быть объяснено в самом контракте');
      }
    }
    const have = new Set((contract.mustCover || []).map((x) => x.id));
    const missing = profile.mustCover.filter((x) => !have.has(x.id)).map((x) => x.id);
    if (missing.length) add(`контракт слабее профиля «${profile.title}»: нет пунктов ${missing.join(', ')}`);
  }

  for (const list of ['mustCover', 'mustNotClaim']) {
    for (const [i, item] of (contract[list] || []).entries()) {
      const at = `${list}[${i}]`;
      if (!item?.id) add(`${at}: нет id`);
      if (!String(item?.what || '').trim()) add(`${at}: нет what — что именно требуется`);
      if (!item?.detect) {
        add(`${at} «${item?.id ?? '?'}»: нет detect — пункт без выражения не требование, а пожелание`);
        continue;
      }
      try { new RegExp(item.detect, 'iu'); } catch (e) { add(`${at}: выражение не разбирается — ${e.message}`); }
    }
  }

  if (!Array.isArray(contract.requiredSources) || !contract.requiredSources.length) {
    add('нет requiredSources — какие роли источников обязаны участвовать');
  }
  return problems;
}

/**
 * Выполняет ли статья свой контракт.
 *
 * @param {object} contract
 * @param {string} articleRaw
 * @param {object} [report] — чтобы сверить роли источников.
 * @returns {Array<{id, problem}>}
 */
export function checkContract(contract, articleRaw, report = null) {
  const problems = [];
  const add = (id, problem) => problems.push({ id, problem });
  if (!contract) return [{ id: '—', problem: 'нет контракта материала — непонятно, что статья обязана закрыть' }];

  const text = String(articleRaw ?? '');

  for (const item of contract.mustCover || []) {
    if (!item?.detect) continue;
    if (!new RegExp(item.detect, 'iu').test(text)) {
      add(item.id, `обещание не закрыто: ${item.what}`);
    }
  }

  for (const item of contract.mustNotClaim || []) {
    if (!item?.detect) continue;
    const m = text.match(new RegExp(item.detect, 'iu'));
    if (m) add(item.id, `запрещённое утверждение: ${item.what} — «${String(m[0]).slice(0, 50)}»`);
  }

  /* Роли источников. Проверяется наличие роли хотя бы у одного
   * доказательства: контракт говорит, что без разъяснения ФНС тему не
   * закрыть, а не что каждое утверждение обязано на него ссылаться.
   *
   * Роли сравниваются по силе, а не по совпадению названия. Требование
   * «нужно разъяснение ведомства» закрывается и самой нормой: норма
   * старше своего разъяснения, и требовать письмо ФНС при наличии
   * статьи закона — перевёрнутая иерархия. На корпусе это дало семь
   * красных статей, у которых доказательства были сильнее требуемых, а
   * единственным способом «починиться» было приписать источник послабее.
   * Гейт, который нельзя пройти честно, толкает пройти его нечестно.
   *
   * Обратной силы у правила нет: `vendorDoc` и `secondary` требование
   * `norm` не закрывают — это и есть та подмена, ради которой роли
   * заводились. */
  if (report && Array.isArray(contract.requiredSources)) {
    const roles = new Set(
      (report.claims || []).flatMap((c) => (c.evidence || []).map((e) => e?.sourceRole)).filter(Boolean),
    );
    const satisfies = (need) => roles.has(need)
      || (need === 'officialGuidance' && roles.has('norm'));
    for (const need of contract.requiredSources) {
      if (!satisfies(need)) add('requiredSources', `в отчёте нет ни одного источника роли «${need}»`);
    }
  }

  return problems;
}

/**
 * L-06. Независимость проверки по уровню риска.
 *
 * Для материалов `riskTier: high` критические утверждения обязан
 * подтвердить не тот, кто их проверял. Причина не в недоверии: автор
 * читает текст глазами того, кто его писал, и видит там задуманное, а не
 * написанное. Второй проход аудита — прямая иллюстрация: отчёт по
 * коррекции чека сам написал «центральный технический факт статьи
 * перевёрнут» и сам же поставил `match`.
 *
 * Для среднего и низкого риска достаточно одного прохода: цена ошибки
 * там другая, и требовать второго человека значит остановить поток.
 *
 * @returns {Array<{id, problem}>}
 */
export function checkIndependentReview(contract, report) {
  if (contract?.riskTier !== 'high') return [];
  const problems = [];
  const add = (problem) => problems.push({ id: 'review', problem });

  const checkedBy = String(report?.checkedBy || '').trim();
  const reviewedBy = String(report?.reviewedBy || '').trim();
  const critical = (report?.claims || []).filter((c) => c?.severity === 'critical');
  if (!critical.length) return [];

  if (!checkedBy) add('не записано, кто проверял (checkedBy) — независимость подтвердить нечем');
  if (!reviewedBy) {
    add(`riskTier high и ${critical.length} критических утверждений: нужен второй проверяющий (reviewedBy)`);
  } else if (checkedBy && reviewedBy.toLowerCase() === checkedBy.toLowerCase()) {
    add(`checkedBy и reviewedBy совпадают («${checkedBy}») — автор не подтверждает собственные критические утверждения`);
  }
  return problems;
}
