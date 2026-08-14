#!/usr/bin/env node
/**
 * Гейт на доказательство факта, а не на вердикт проверяющего.
 *
 * 13.08.2026 редактор прислала разбор статьи «Ошибки ТС ПИоТ», сделанный
 * сторонней моделью: шесть существенных фактических ошибок. Наш факчек
 * на этой же статье стоял `passed`, `criticalMismatches: 0`, 35 из 38
 * утверждений «совпало».
 *
 * Разбор отчёта показал два независимых дефекта, и оба структурные.
 *
 * ПЕРВЫЙ: единица проверки — токен, а не утверждение. Из текста
 * извлекалось `raw: "54-ФЗ"` или `raw: "400 000 ₽"`, и проверялось
 * существование нормы или наличие числа где-нибудь в источнике. Само
 * утверждение статьи — «ФФД 1.2 нужен для тега 1162», «крупный размер по
 * ст. 171.1 УК для продовольственных — от 400 000 ₽» — не проверялось
 * никогда. Первое неверно (нужны теги 1300–1309/1320–1325), второе
 * занижено почти в полтора раза. Оба стояли «match» с уверенностью
 * 0.85 и 0.8.
 *
 * ВТОРОЙ: уверенность ни на что не влияла. «Таблица кодов ошибок» —
 * match при 0.55. «Модуль обязан сверять код до пробития чека» — match
 * при 0.6. Оба оказались неверны. Число рядом со статусом было
 * украшением: ни одно правило его не читало.
 *
 * Отсюда устройство гейта. Он не спрашивает «проверяющий уверен?» — он
 * требует предъявить то, что можно проверить механически:
 *
 *   1. Что именно утверждает статья (`statement`), а не какой токен из
 *      неё выдернут. Утверждение обязано содержать проверяемое значение.
 *   2. Дословную цитату из первоисточника (`quote`), в которой это
 *      значение есть. Не пересказ, не «подтверждено поиском» — цитату,
 *      внутри которой скрипт находит то же число или ту же норму.
 *   3. Ссылку на первоисточник, а не на пересказ. Инструкция поддержки
 *      и отраслевой портал — не основание для порога уголовной
 *      ответственности.
 *   4. Уверенность, согласованную со статусом: критическое утверждение
 *      ниже порога не может быть «совпало».
 *
 * Пункт 2 — главный. Проверяющий, который не может привести цитату с
 * числом, не проверил число: именно так «400 000 ₽» и прошло. Цитату
 * подделать можно, но это уже осознанный подлог, а не незамеченный
 * пропуск, и он виден при первом же взгляде на отчёт.
 *
 * Запуск:
 *   node scripts/factcheck/check-report.mjs <slug>
 *   node scripts/factcheck/check-report.mjs --all
 *
 * Коды: 0 — доказательства на месте, 1 — нет, 2 — отчёта нет.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.FACTCHECK_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'src/data/factcheck/results');

/** Типы, где ошибка в значении — это последствие в реальном мире. */
export const HIGH_RISK_TYPES = ['MONEY', 'NPA_UK', 'NPA_KOAP', 'DURATION', 'LEGAL_CLAIM'];

/**
 * Первоисточники. Публикатор НПА, справочные системы с текстами норм,
 * сайты ведомств. Отраслевые порталы и инструкции поддержки сюда не
 * входят намеренно: они пересказывают норму, а порог ответственности
 * берётся из текста нормы.
 */
export const PRIMARY_DOMAINS = [
  'publication.pravo.gov.ru', 'pravo.gov.ru',
  'consultant.ru', 'garant.ru',
  'nalog.gov.ru', 'minfin.gov.ru', 'minpromtorg.gov.ru',
  'sudact.ru', 'vsrf.ru',
];

/** Минимальная уверенность, при которой статус «совпало» допустим. */
export const MIN_CONFIDENCE = { critical: 0.8, moderate: 0.7, minor: 0 };

const isPrimary = (url) => {
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
  return PRIMARY_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
};

/** Числа из текста в сравнимом виде: «2 250 000 ₽» и «2250000» — одно. */
export function numbersIn(text) {
  return (String(text ?? '').match(/\d[\d\s .,]*\d|\d/g) || [])
    .map((n) => n.replace(/[\s .,]/g, ''))
    .filter((n) => n.length >= 2);
}

/* Числительные прописью. В нормативных текстах суммы пишутся словами —
 * «превышающая четыреста тысяч рублей», — и требование найти в цитате
 * цифры делает гейт непроходимым для настоящей цитаты первоисточника.
 *
 * Это опаснее, чем кажется: невыполнимое требование не защищает, а
 * толкает подогнать цитату под проверку. Гейт, который нельзя пройти
 * честно, хуже отсутствующего. */
const WORD_UNITS = {
  ноль: 0, один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11,
  двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60,
  семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100, двести: 200,
  триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600,
  семьсот: 700, восемьсот: 800, девятьсот: 900,
};
const WORD_SCALES = [
  [/^тысяч/, 1000], [/^миллион/, 1000000], [/^миллиард/, 1000000000],
];

/** Все суммы, записанные прописью, как числа: «четыреста тысяч» → 400000. */
export function numeralWordsIn(text) {
  const words = String(text ?? '').toLowerCase().match(/[а-яё]+/g) || [];
  const out = [];
  let group = 0, total = 0, seen = false;
  const flush = () => {
    if (seen) out.push(total + group);
    group = 0; total = 0; seen = false;
  };
  for (const w of words) {
    if (w in WORD_UNITS) { group += WORD_UNITS[w]; seen = true; continue; }
    const scale = WORD_SCALES.find(([re]) => re.test(w));
    if (scale) {
      total += (group || 1) * scale[1];
      group = 0; seen = true;
      continue;
    }
    if (/^(рубл|и|целых)/.test(w)) continue;   // не разрывают число
    flush();
  }
  flush();
  return out.filter((n) => n > 0).map(String);
}

/** Ссылки на нормы в сравнимом виде: «ст. 171.1 УК» → «171.1». */
export function normRefsIn(text) {
  return (String(text ?? '').match(/\d+(?:\.\d+)?/g) || []);
}

/* Технические идентификаторы: номер тега, реквизита, кода, версии ФФД.
 * Ошибка в такой цифре стоит столько же, сколько ошибка в пороге
 * ответственности, — касса просто не примет чек. */
const TECH_ID = /(тег|реквизит|ффд|код\s+(ошибки|товара|маркировки)|версия\s+формата)\D{0,20}\d{3,}/iu;
const LIABILITY = /(штраф|порог|крупн\p{L}*\s+размер|ответственност|конфискац|наказ)/iu;

/**
 * Опасное утверждение определяем по содержанию, а не по объявленной
 * важности.
 *
 * Severity в отчёте ставит тот же проверяющий, который проверяет, — и
 * ровно эта самооценка подвела: утверждение «ФФД 1.2 нужен для тега
 * 1162» стояло как `minor`, хотя номер тега неверен и касса по нему
 * работать не будет. Доверять полю, которое заполняет проверяемая
 * сторона, в гейте нельзя.
 */
const isHighRisk = (c) => {
  if (HIGH_RISK_TYPES.includes(c.type) || c.severity === 'critical') return true;
  const text = `${c.raw ?? ''} ${c.expectedValue ?? ''} ${c.statement ?? ''}`;
  return TECH_ID.test(text) || LIABILITY.test(text);
};

export function checkReport(report, name = 'отчёт') {
  const problems = [];
  const add = (id, problem) => problems.push({ name, id, problem });

  if (!report || typeof report !== 'object') return [{ name, problem: 'отчёт не разбирается' }];
  const claims = Array.isArray(report.claims) ? report.claims : null;
  if (!claims) return [{ name, problem: 'в отчёте нет списка claims' }];
  if (!claims.length) return [{ name, problem: 'список утверждений пуст — проверять было нечего?' }];

  for (const c of claims) {
    const id = c.id || c.raw || '?';
    const conf = Number(c.confidence);
    const sev = c.severity || 'minor';

    /* Уверенность, согласованная со статусом. Число рядом со статусом
     * должно что-то решать, иначе это украшение. */
    if (c.status === 'match' && Number.isFinite(conf)) {
      const need = MIN_CONFIDENCE[sev] ?? 0;
      if (conf < need) {
        add(id, `«совпало» при уверенности ${conf} — для «${sev}» нужно от ${need}, иначе это «неясно»`);
      }
    }

    if (!isHighRisk(c) || c.status !== 'match') continue;

    /* Что именно утверждает статья. Токен «400 000 ₽» сам по себе
     * ничего не утверждает, и проверить его нельзя. */
    const statement = String(c.statement || '').trim();
    if (!statement) {
      add(id, `нет поля statement — что именно проверяли? «${String(c.raw).slice(0, 40)}» это токен, а не утверждение`);
    } else if (statement.length <= String(c.raw || '').length + 10) {
      add(id, 'statement не длиннее токена — утверждение не сформулировано');
    }

    /* Дословная цитата первоисточника со значением внутри. Главное
     * правило: не можешь привести цитату с числом — не проверил число. */
    const quote = String(c.quote || '').trim();
    if (!quote) {
      add(id, 'нет дословной цитаты первоисточника — «подтверждено поиском» доказательством не является');
    } else {
      const isAmount = c.type === 'MONEY' || c.type === 'DURATION';
      const wanted = isAmount ? numbersIn(c.raw) : normRefsIn(c.raw);
      // Суммы в цитате ищем и цифрами, и прописью: НПА пишет словами.
      const inQuote = isAmount
        ? [...numbersIn(quote), ...numeralWordsIn(quote)]
        : [...normRefsIn(quote), ...numeralWordsIn(quote)];
      if (wanted.length && !wanted.some((w) => inQuote.includes(w))) {
        add(id, `в цитате нет значения «${String(c.raw).slice(0, 30)}» — цитата не подтверждает именно это число`);
      }
    }

    const sources = Array.isArray(c.sources) ? c.sources : [];
    if (!sources.some(isPrimary)) {
      add(id, sources.length
        ? 'нет ссылки на первоисточник — пересказ нормы не подтверждает порог'
        : 'нет ни одного источника');
    }
  }

  /* Итог отчёта обязан следовать из утверждений, а не объявляться.
   * write-marker копирует summary как есть, поэтому проверяем здесь. */
  const blocking = claims.filter(
    (c) => ['critical', 'moderate'].includes(c.severity) && c.status !== 'match',
  );
  const overall = report.summary?.overallStatus;
  if (blocking.length && overall && overall !== 'needs-rewrite') {
    add('summary', `${blocking.length} значимых утверждений не подтверждены, а overallStatus «${overall}»`);
  }
  const declared = Number(report.summary?.criticalIssues ?? 0);
  const actual = claims.filter((c) => c.severity === 'critical' && c.status !== 'match').length;
  if (declared !== actual) {
    add('summary', `criticalIssues заявлено ${declared}, по утверждениям выходит ${actual}`);
  }

  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let files;
  if (args.includes('--all')) {
    files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => join(DIR, f)) : [];
    if (!files.length) { console.log('Отчётов факчека нет.'); process.exit(0); }
  } else {
    const slug = args.find((a) => !a.startsWith('--'));
    if (!slug) { console.error('Использование: check-report.mjs <slug> | --all'); process.exit(2); }
    const p = slug.endsWith('.json') ? slug : join(DIR, `${slug}.json`);
    if (!existsSync(p)) { console.error(`✖ Нет отчёта ${p}`); process.exit(2); }
    files = [p];
  }

  let bad = 0;
  for (const f of files) {
    let data;
    try { data = JSON.parse(readFileSync(f, 'utf8')); } catch (e) {
      console.log(`✖ ${basename(f)} — не разбирается: ${e.message}`); bad++; continue;
    }
    const problems = checkReport(data, basename(f));
    if (!problems.length) { console.log(`✓ ${basename(f)}`); continue; }
    bad++;
    console.log(`✖ ${basename(f)} — ${problems.length} замечаний:`);
    const shown = problems.slice(0, 8);
    for (const p of shown) console.log(`    [${p.id ?? '—'}] ${p.problem}`);
    if (problems.length > shown.length) console.log(`    … и ещё ${problems.length - shown.length}`);
  }
  process.exit(bad ? 1 : 0);
}
