#!/usr/bin/env node
/**
 * Снимок страницы первоисточника: отпечаток и сверка цитаты.
 *
 * Последнее недостающее звено доказательной цепочки. D-02 ввёл поле
 * `snapshotHash` — «отпечаток полученного текста, иначе цитату не с чем
 * сверить», — но взять этот отпечаток было нечем: инструмент загрузки
 * страниц возвращает пересказ, а не текст, и пересказ каждый раз разный.
 * Поле было в контракте и не заполнялось ничем, кроме веры.
 *
 * Здесь страница забирается целиком, приводится к тексту и хешируется.
 * Два следствия, оба важные:
 *
 *   1. Цитата сверяется с настоящим текстом страницы, а не с памятью
 *      того, кто её выписывал. Выдуманная цитата не проходит.
 *   2. Отпечаток воспроизводим: тот же URL при неизменившейся странице
 *      даёт тот же хеш, а изменившаяся норма — другой, и `watch-sources`
 *      собирает очередь перепроверки (J-04).
 *
 * Нормализация нужна ровно для второго: без неё хеш менялся бы от
 * счётчика посещений, рекламного блока и даты в подвале — то есть
 * каждый день, и «источник изменился» перестало бы что-либо значить.
 * Вырезаются скрипты, стили, разметка и повторяющиеся пробелы; остаётся
 * видимый текст.
 *
 * Использование:
 *   node scripts/factcheck/snapshot.mjs <url>
 *   node scripts/factcheck/snapshot.mjs <url> --quote "дословная цитата"
 *   node scripts/factcheck/snapshot.mjs <url> --json
 */
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';

/**
 * Кодировка страницы.
 *
 * Часть правовых сайтов до сих пор отдаёт windows-1251 и не всегда
 * объявляет это в заголовке. `res.text()` в таком случае молча читает
 * байты как UTF-8, и снимок получается из «кракозябр»: отпечаток
 * настоящий, а текст нечитаемый, и любая цитата в нём «не находится».
 * Отличить это от выдуманной цитаты по сообщению невозможно — значит,
 * кодировку надо определять, а не предполагать.
 */
function decode(buf, contentType) {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType || '')?.[1];
  const head = new TextDecoder('latin1').decode(buf.slice(0, 4096));
  const fromMeta = /charset=["']?([\w-]+)/i.exec(head)?.[1];
  const enc = (fromHeader || fromMeta || 'utf-8').toLowerCase();
  const known = ['utf-8', 'utf8', 'windows-1251', 'cp1251', 'koi8-r', 'iso-8859-5'];
  try {
    return new TextDecoder(known.includes(enc) ? enc : 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/**
 * Текст PDF через `pdftotext`.
 *
 * Внешняя утилита, а не библиотека: разбор PDF — отдельное ремесло, и
 * тащить его в репозиторий ради нескольких документов не стоит. Нет
 * утилиты — честная ошибка, а не молчаливый пустой снимок.
 */
function pdfToText(buf) {
  const tmp = join(tmpdir(), `snap-${randomUUID()}.pdf`);
  try {
    writeFileSync(tmp, buf);
    return execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', tmp, '-'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }).replace(/[\t\r ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  } catch (e) {
    throw new Error(`PDF не разобран (нужен pdftotext): ${e.message}`);
  } finally {
    try { unlinkSync(tmp); } catch { /* уже нет */ }
  }
}

/** Браузерный UA: часть первоисточников отдаёт 403 всему остальному. */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * Видимый текст страницы.
 *
 * Порядок важен: сначала выбрасываем содержимое script/style/noscript
 * целиком, иначе их текст попадёт в снимок и цитата будет «находиться»
 * в коде.
 */
export function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&laquo;/gi, '«')
    .replace(/&raquo;/gi, '»')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    /* Шестнадцатеричные ссылки на символы.
     *
     * pravo.gov.ru — официальный источник опубликования — отдаёт
     * кириллицу именно так: `&#x41F;&#x440;…`. Без этой строки снимок
     * официальной публикации сохранялся набором сущностей, цитата в нём
     * не находилась никогда, и единственным доказуемым источником нормы
     * оставались коммерческие базы. Хуже того, снимок выглядел
     * сохранённым: файл есть, хеш сходится, а искать в нём нечего. */
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Текст для сравнения цитаты: без разницы в кавычках, тире и пробелах. */
export const normalizeQuote = (s) => String(s ?? '')
  .replace(/[  ]/g, ' ')
  .replace(/[«»“”„"]/g, '"')
  .replace(/[–—-]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/** Отпечаток снимка. */
export const snapshotHash = (text) => createHash('sha256')
  .update(normalizeQuote(text)).digest('hex');

/**
 * Забрать страницу и посчитать отпечаток.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, fetchImpl?: Function}} [opts]
 * @returns {Promise<{ok, status, url, text, hash, bytes, error?}>}
 */
export async function fetchSnapshot(url, { timeoutMs = 30000, fetchImpl = fetch, retries = 2 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    for (let attempt = 0; ; attempt += 1) {
      res = await fetchImpl(url, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          'user-agent': UA,
          /* PDF в списке обязателен: методические рекомендации ФНС и
           * часть приказов публикуются только им, а `accept`, где его
           * нет, честно получает 406 — и выглядит это как «источник
           * недоступен», хотя недоступен он ровно из-за заголовка. */
          accept: 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8',
          'accept-language': 'ru,en;q=0.8',
        },
      });
      /* 403 и 429 у правовых баз чаще означают «слишком часто», а не
       * «нельзя»: пауза дешевле, чем отказ от первоисточника в пользу
       * пересказа. */
      if (![403, 429, 503].includes(res.status) || attempt >= retries) break;
      await new Promise((r) => { setTimeout(r, 2000 * (attempt + 1)); });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ctype = res.headers.get('content-type') || '';
    /* Методические рекомендации ФНС и часть приказов публикуются PDF-ом.
     * Отказываться от них значит отказываться от официального
     * разъяснения в пользу пересказа — то есть ровно от того, ради чего
     * весь контур. Текст достаём pdftotext, остальное как у HTML. */
    const isPdf = /application\/pdf/i.test(ctype) || buf.slice(0, 4).toString('latin1') === '%PDF';
    const text = isPdf ? pdfToText(buf) : htmlToText(decode(buf, ctype));
    return {
      ok: res.ok && text.length > 200,
      status: res.status,
      url,
      text,
      bytes: buf.length,
      hash: snapshotHash(text),
      /* Пустая или крошечная страница при коде 200 — это заглушка или
       * защита от роботов, а не документ. Считать её снимком значит
       * получить отпечаток пустоты и «подтвердить» им что угодно. */
      error: res.ok && text.length <= 200 ? 'страница пустая — вероятно заглушка или защита от роботов' : undefined,
    };
  } catch (e) {
    return { ok: false, status: 0, url, text: '', bytes: 0, hash: null, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Есть ли цитата в снимке.
 *
 * Сравнение по нормализованному тексту: кавычки-ёлочки, длинное тире и
 * неразрывный пробел в живых документах ставят как придётся, и требовать
 * побайтового совпадения значит отвергать честные цитаты.
 */
export function quoteInSnapshot(text, quote) {
  const t = normalizeQuote(text);
  const q = normalizeQuote(quote);
  if (!q) return { found: false, reason: 'пустая цитата' };
  if (t.includes(q)) return { found: true };

  /* Не нашлась целиком — скажем, насколько близко. Обрыв на середине
   * фразы обычно означает вёрстку между словами, а не выдумку; полное
   * отсутствие начала — что цитата не с этой страницы. */
  const words = q.split(' ');
  let longest = 0;
  for (let i = 0; i < words.length; i += 1) {
    for (let j = words.length; j > i + longest; j -= 1) {
      if (t.includes(words.slice(i, j).join(' '))) { longest = Math.max(longest, j - i); break; }
    }
  }
  return {
    found: false,
    reason: longest
      ? `совпало подряд ${longest} слов из ${words.length} — цитата оборвана или перефразирована`
      : 'ни одного совпадения — цитата не с этой страницы',
  };
}

/* ── Хранилище снимков ──────────────────────────────────────────────── */

/**
 * Снимки лежат по адресу собственного содержимого: имя файла — его хеш.
 *
 * До этого `snapshotHash` был числом в отчёте и ничем больше. Валидатор
 * проверял, что строка похожа на sha256, — то есть принимал любые 64
 * шестнадцатеричных символа. Поле, которое нельзя не пройти, ничего не
 * доказывает: «отпечаток страницы» существовал ровно как обещание.
 *
 * Со снимком на диске проверка становится настоящей и, что важнее,
 * офлайновой: CI не ходит в сеть, а пересчитывает хеш сохранённого
 * текста и ищет в нём цитату. Подменить отпечаток теперь мало — надо
 * подменить файл, который под него хешируется, а это и есть содержимое
 * первоисточника.
 */
export const SNAPSHOT_DIR = 'src/data/factcheck/snapshots';

export const snapshotFile = (root, hash) => join(root, SNAPSHOT_DIR, `${hash}.txt`);

/** Сохранить снимок. Возвращает хеш — он же имя файла. */
export function saveSnapshot(root, text) {
  const hash = snapshotHash(text);
  const dir = join(root, SNAPSHOT_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${hash}.txt`), text);
  return hash;
}

/**
 * Прочитать снимок и убедиться, что он действительно этот.
 *
 * Пересчёт обязателен: файл, положенный под чужим именем, — ровно тот
 * способ обойти проверку, ради которого хранилище и заводится.
 */
export function loadSnapshot(root, hash) {
  const p = snapshotFile(root, hash);
  if (!existsSync(p)) return { ok: false, reason: 'снимка нет в хранилище' };
  const text = readFileSync(p, 'utf8');
  const actual = snapshotHash(text);
  if (actual !== hash) {
    return { ok: false, reason: `файл снимка не соответствует имени: хеш содержимого ${actual.slice(0, 12)}…` };
  }
  return { ok: true, text };
}

/**
 * Доказательство подтверждено сохранённым снимком.
 *
 * Три вопроса подряд, и каждый следующий имеет смысл только после
 * предыдущего: есть ли снимок, тот ли это снимок, есть ли в нём цитата.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function verifyEvidenceSnapshot(root, evidence) {
  const hash = String(evidence?.snapshotHash ?? '');
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'нет snapshotHash' };
  const snap = loadSnapshot(root, hash);
  if (!snap.ok) return snap;
  const q = quoteInSnapshot(snap.text, evidence.quote);
  return q.found ? { ok: true } : { ok: false, reason: `цитаты нет в снимке: ${q.reason}` };
}

/* ── CLI ────────────────────────────────────────────────────────────── */

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith('--'));
  const qi = args.indexOf('--quote');
  const quote = qi === -1 || qi === args.length - 1 ? null : args[qi + 1];

  if (!url) {
    console.error('Использование: snapshot.mjs <url> [--quote "дословная цитата"] [--json]');
    process.exit(2);
  }

  const snap = await fetchSnapshot(url);
  if (!snap.ok) {
    console.error(`✖ ${url}\n  ${snap.error ?? `код ${snap.status}`}`);
    process.exit(1);
  }

  /* --save кладёт снимок в хранилище: без него отпечаток остаётся
   * числом, которое нечем перепроверить. */
  if (args.includes('--save')) {
    const root = process.env.FACTCHECK_ROOT
      || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    saveSnapshot(root, snap.text);
    console.log(`  снимок сохранён: ${SNAPSHOT_DIR}/${snap.hash}.txt`);
  }

  const check = quote ? quoteInSnapshot(snap.text, quote) : null;
  if (args.includes('--json')) {
    console.log(JSON.stringify({
      url, snapshotHash: snap.hash, retrievedAt: new Date().toISOString().slice(0, 10),
      chars: snap.text.length, quoteFound: check ? check.found : null,
    }, null, 2));
    process.exit(check && !check.found ? 1 : 0);
  }

  console.log(`✓ ${url}`);
  console.log(`  снимок: ${snap.text.length} символов, отпечаток ${snap.hash}`);
  if (check) {
    console.log(check.found
      ? '  ✓ цитата найдена в тексте страницы'
      : `  ✖ цитаты в тексте нет: ${check.reason}`);
  }
  process.exit(check && !check.found ? 1 : 0);
}
