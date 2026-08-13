/**
 * Разбор ячейки «Тема» на задачу.
 *
 * Колонка «Тема» задумывалась как заголовок будущей статьи, но редакция
 * пишет в неё задачу целиком. 13.08.2026 в таблице оказались:
 *
 *   «Актуализировать статью https://kontur.ru/market/spravka/38077-…
 *    Не менять в тексте то, что еще актуально, только предложить новые
 *    правки. Предложить места, куда вставить промо Маркета…»
 *
 *   «Заголовок: Ошибки при работе с ТС ПИоТ… Использовать не только
 *    общую информацию, но и конкретно как это работает в Маркете, по
 *    инструкции https://support.kontur.ru/market/84217-…»
 *
 * Обе строки состояние приняло за заголовки. Файлы статей получили имена
 * вида `2026-08-13-aktualizirovat-statyu-https-kontur-ru-…`, а инструкция
 * редактора — «не менять актуальное, только предложить правки» — не
 * дошла до пайплайна вообще: по первой задаче написали новую статью
 * вместо разбора правок к существующей.
 *
 * Здесь ячейка разбирается на четыре разные вещи:
 *   kind      — что делать: писать новое или актуализировать чужой текст;
 *   sourceUrl — какую статью актуализируем (для kind='update');
 *   refUrls   — на что опереться (инструкции поддержки, справка);
 *   brief     — что именно просил редактор, дословно;
 *   title     — только заголовок, без задачи.
 *
 * Разбор детерминированный и без ИИ: он не понимает смысл, он отделяет
 * ссылки от текста и директиву от заголовка. Понимание — дальше, в
 * `.claude/commands/update-article.md`.
 */

/* Директивы, с которых редактор начинает задачу на актуализацию.
 * `\b` и `\w` по кириллице не работают (ASCII-онли), поэтому границы
 * задаются явными классами — та же ловушка, что съела 11 проверок в
 * check-ai-markers.mjs. */
const NO_LETTER_BEFORE = '(?<![а-яёА-ЯЁa-zA-Z])';
const UPDATE_DIRECTIVE = new RegExp(
  NO_LETTER_BEFORE +
  '(актуализ\\p{L}*|обнов\\p{L}*\\s+стать\\p{L}*|переработа\\p{L}*\\s+стать\\p{L}*|освеж\\p{L}*\\s+стать\\p{L}*)',
  'iu',
);
const TITLE_DIRECTIVE = new RegExp(NO_LETTER_BEFORE + 'заголовок\\s*[:—-]\\s*', 'iu');

/** Ссылки на инструкции и справку — опора, а не объект работы. */
const REFERENCE_HOSTS = [/^support\./i, /^help\./i, /^docs\./i];

const URL_RE = /https?:\/\/[^\s<>"'()]+/gi;

/** Хвостовая пунктуация прилипает к ссылке при копировании из письма. */
function cleanUrl(raw) {
  return raw.replace(/[.,;:!?»)\]]+$/, '');
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

const isReference = (url) => {
  const host = hostOf(url);
  return REFERENCE_HOSTS.some((re) => re.test(host));
};

/**
 * Числовой идентификатор материала Маркета: `/spravka/38077-kak_rabotat…`
 * Ключ стабильнее полного URL — у одной и той же статьи встречаются
 * варианты со слэшем на конце, с utm-хвостом и с http вместо https.
 */
export function marketArticleId(url) {
  if (!url) return null;
  try {
    const path = new URL(url).pathname;
    return path.match(/\/(\d{3,})[-/]/)?.[1] ?? path.match(/\/(\d{3,})$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Заголовок из директивы «Заголовок: …».
 *
 * Заголовок кончается там, где начинается инструкция. Признак —
 * точка с пробелом перед заглавной буквой: «…и что означают коды.
 * Использовать не только…». Двоеточие внутри заголовка при этом
 * сохраняется, оно у нас в каждом втором заголовке.
 */
function splitTitleAndRest(text) {
  const m = text.match(/^(.+?[^.])\.\s+(?=[А-ЯЁA-Z])(.+)$/s);
  if (m) return { title: m[1].trim(), rest: m[2].trim() };
  return { title: text.replace(/\.\s*$/, '').trim(), rest: '' };
}

/**
 * Человекочитаемое имя из URL — запасной вариант, когда статьи нет в
 * каталоге Маркета: `38077-kak_rabotat_v_egais` → «Как работать в егаис».
 * Транслитерацию обратно не делаем: это подпорка для строки таблицы,
 * настоящий заголовок подставит команда актуализации, прочитав саму статью.
 */
function nameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    const words = last.replace(/^\d+[-_]/, '').replace(/[-_]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : url;
  } catch {
    return url;
  }
}

/**
 * Разобрать ячейку «Тема».
 *
 * @param {string} cell — текст ячейки как есть
 * @param {{catalog?: Array<{url: string, title: string, viewsTotal?: number}>}} opts
 *        каталог Маркета для подстановки настоящего заголовка статьи
 * @returns {{kind: 'new'|'update', title: string, brief: string,
 *            sourceUrl: string|null, sourceTitle: string|null,
 *            refUrls: string[], raw: string}}
 */
export function parseTopicCell(cell, opts = {}) {
  const raw = String(cell ?? '').trim();
  const empty = {
    kind: 'new', title: '', brief: '', sourceUrl: null, sourceTitle: null,
    refUrls: [], raw,
  };
  if (!raw) return empty;

  const urls = [...raw.matchAll(URL_RE)].map((m) => cleanUrl(m[0]));

  /* Уже разобранный заголовок разбирается второй раз без изменений.
   *
   * На выходе разбора получается «Актуализация: <название статьи>» — и
   * эта же строка потом приходит обратно: из очереди актуализации, из
   * ячейки таблицы, из состояния цикла. Ссылки в ней уже нет, поэтому
   * второй проход выдавал «Актуализация: статья без ссылки» и терял
   * название. Разбор обязан быть идемпотентным: parse(parse(x)) === parse(x). */
  const alreadyParsed = !urls.length && /^актуализация:\s*\S/iu.test(raw);
  if (alreadyParsed) {
    return { ...empty, kind: 'update', title: raw, sourceTitle: raw.replace(/^актуализация:\s*/iu, '') };
  }

  const isUpdate = UPDATE_DIRECTIVE.test(raw);

  /* Объект работы — первая ссылка, которая не инструкция поддержки.
   * Порядок важнее хоста: редактор пишет «актуализировать <статью>»,
   * а опоры перечисляет после. */
  const sourceUrl = isUpdate ? (urls.find((u) => !isReference(u)) ?? urls[0] ?? null) : null;
  const refUrls = urls.filter((u) => u !== sourceUrl);

  /* Текст без ссылок и без директивы — это и есть просьба редактора.
   * Она не выбрасывается и не пересказывается: по ней потом сверяют,
   * что задача выполнена так, как просили. */
  let text = raw;
  for (const u of urls) text = text.split(u).join(' ');
  text = text.replace(/\s{2,}/g, ' ').trim();

  if (isUpdate) {
    const brief = text.replace(UPDATE_DIRECTIVE, '')
      .replace(new RegExp('^\\s*стать\\p{L}*\\s*', 'iu'), '')
      .replace(/^[\s.,:;—-]+/, '')
      .trim();
    const fromCatalog = sourceUrl ? lookupCatalog(sourceUrl, opts.catalog) : null;
    const sourceTitle = fromCatalog?.title ?? null;
    return {
      kind: 'update',
      title: `Актуализация: ${sourceTitle || (sourceUrl ? nameFromUrl(sourceUrl) : 'статья без ссылки')}`,
      brief,
      sourceUrl,
      sourceTitle,
      refUrls,
      raw,
    };
  }

  const titleMatch = text.match(TITLE_DIRECTIVE);
  const body = titleMatch ? text.slice(titleMatch.index + titleMatch[0].length).trim() : text;
  const { title, rest } = splitTitleAndRest(body);

  return { kind: 'new', title, brief: rest, sourceUrl: null, sourceTitle: null, refUrls, raw };
}

/** Статья Маркета по URL — сверяем по числовому id, а не по строке целиком. */
export function lookupCatalog(url, catalog) {
  if (!catalog?.length) return null;
  const id = marketArticleId(url);
  if (!id) return null;
  const hit = catalog.find((a) => marketArticleId(a.url) === id);
  if (!hit) return null;
  /* В выгрузке Метрики заголовок продублирован дважды подряд («Как
   * работать в ЕГАИС Как работать в ЕГАИС») — артефакт экспорта, а не
   * название статьи. Схлопываем: ровно две одинаковые половины через
   * пробел, длиной хотя бы 8 символов, чтобы не съесть настоящий
   * повтор вроде «Чек за чек».
   *
   * Перед сравнением выравниваем пробелы. В выгрузке стоят неразрывные
   * (U+00A0) — «в 2026 году», — и в двух половинах они встают
   * по-разному: посимвольно половины не совпадают, обратная ссылка не
   * срабатывает, и в таблицу редактора уезжает двойной заголовок. */
  const title = String(hit.title || '').replace(/[    ]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const dedup = title.match(/^(.{8,}?)\s+\1$/)?.[1] ?? title;
  return { ...hit, title: dedup };
}
