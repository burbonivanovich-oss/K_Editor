/**
 * Снимок первоисточника: отпечаток и сверка цитаты.
 *
 * Последнее звено доказательной цепочки, и оно же самое проверяемое на
 * себе. Поле `snapshotHash` существовало с D-02, но взять отпечаток было
 * нечем: инструмент загрузки страниц возвращает пересказ, а не текст.
 * Когда снапшоттер появился и записи реестра прогнали через него, ни
 * одна из пяти цитат не нашлась на своей странице — все пять были
 * пересказами. Одна из них к тому же указывала на пункт 16 ПП № 1944
 * («ожидание полторы секунды») вместо пункта 17, и эта ошибка успела
 * попасть в три статьи.
 *
 * Сеть здесь не нужна: `fetchImpl` подменяется, и проверяется разбор,
 * а не доступность чужих сайтов.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  htmlToText, normalizeQuote, snapshotHash, quoteInSnapshot, fetchSnapshot,
} from './snapshot.mjs';

const res = (body, { status = 200, type = 'text/html; charset=utf-8' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
  arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')),
});

const page = (text) => `<html><head><title>x</title><style>.a{color:red}</style></head>`
  + `<body><script>var q="фальшивая цитата";</script><p>${text}</p></body></html>`;

test('текст страницы — без скриптов и стилей', () => {
  /* Иначе цитата «находится» в коде: скрипт с текстом внутри подтвердил
   * бы что угодно. */
  const t = htmlToText(page('Настоящий текст нормы.'));
  assert.match(t, /Настоящий текст нормы/);
  assert.ok(!/фальшивая цитата/.test(t));
  assert.ok(!/color:red/.test(t));
});

test('сущности и кавычки разворачиваются', () => {
  assert.match(htmlToText('<p>&laquo;приход&raquo;&nbsp;&mdash; 10&nbsp;000&nbsp;&#8381;</p>'), /«приход» — 10 000/);
});

test('отпечаток устойчив к вёрстке и меняется от текста', () => {
  const a = snapshotHash('Норма   действует\nс 01.10.2026');
  const b = snapshotHash('Норма действует с 01.10.2026');
  const c = snapshotHash('Норма действует с 01.01.2027');
  assert.equal(a, b, 'пробелы и переносы не должны менять отпечаток');
  assert.notEqual(a, c, 'смена даты обязана менять отпечаток');
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('цитата сверяется без придирок к кавычкам и тире', () => {
  const text = 'штраф «не менее» 10 000 ₽ — для должностных лиц';
  assert.equal(quoteInSnapshot(text, 'штраф "не менее" 10 000 ₽ - для должностных лиц').found, true);
  assert.equal(normalizeQuote('«а» — б').includes('"а" - б'), true);
});

test('выдуманная цитата не проходит и говорит, насколько промахнулась', () => {
  const text = 'крупным размером признаются стоимость в сумме, превышающей три миллиона пятьсот тысяч рублей';
  const r = quoteInSnapshot(text, 'крупным размером признаётся стоимость свыше двух миллионов');
  assert.equal(r.found, false);
  assert.match(r.reason, /совпало подряд \d+ слов/);

  const alien = quoteInSnapshot(text, 'совершенно посторонняя фраза');
  assert.equal(alien.found, false);
  assert.match(alien.reason, /не с этой страницы/);
});

test('windows-1251 читается, а не превращается в кракозябры', () => {
  /* Правовые базы до сих пор отдают 1251 и не всегда объявляют это в
   * заголовке. Прочитанная как UTF-8 страница даёт настоящий отпечаток
   * нечитаемого текста, и любая цитата в нём «не находится» — отличить
   * это от выдумки по сообщению невозможно. */
  const cp1251 = Buffer.from(
    Array.from('<html><body><p>запрет розничной продажи товаров не действует</p></body></html>')
      .map((ch) => {
        const c = ch.codePointAt(0);
        if (c < 128) return c;
        if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0;
        if (c === 0x451) return 0xb8;
        return 0x3f;
      }),
  );
  const s = { ...res(cp1251, { type: 'text/html; charset=windows-1251' }) };
  return fetchSnapshot('https://пример/', { fetchImpl: async () => s }).then((snap) => {
    assert.match(snap.text, /запрет розничной продажи товаров не действует/);
  });
});

test('пустая страница при коде 200 снимком не считается', () => {
  /* Заглушка или защита от роботов: отпечаток пустоты «подтвердил» бы
   * что угодно, чего в нём нет. */
  return fetchSnapshot('https://пример/', { fetchImpl: async () => res('<html><body>ок</body></html>') })
    .then((snap) => {
      assert.equal(snap.ok, false);
      assert.match(snap.error, /заглушка|пустая/);
    });
});

test('403 повторяется, а не считается отказом источника', () => {
  /* У правовых баз 403 чаще значит «слишком часто», чем «нельзя», и
   * отказ от первоисточника в пользу пересказа — плохой размен. */
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return calls < 3 ? res('', { status: 403 }) : res(page('Текст нормы достаточной длины. '.repeat(20)));
  };
  return fetchSnapshot('https://пример/', { fetchImpl: impl, retries: 3 }).then((snap) => {
    assert.equal(snap.ok, true);
    assert.equal(calls, 3);
  });
});

test('сеть упала — честная ошибка, а не пустой снимок', () => {
  return fetchSnapshot('https://пример/', { fetchImpl: async () => { throw new Error('ECONNRESET'); } })
    .then((snap) => {
      assert.equal(snap.ok, false);
      assert.equal(snap.hash, null);
      assert.match(snap.error, /ECONNRESET/);
    });
});

test('PDF узнаётся по сигнатуре, а не только по заголовку', () => {
  /* Методические рекомендации ФНС отдаются с content-type, которому
   * верить нельзя; сигнатура %PDF надёжнее. */
  const notPdf = Buffer.from('<html><body>' + 'текст '.repeat(60) + '</body></html>', 'utf8');
  return fetchSnapshot('https://пример/', { fetchImpl: async () => res(notPdf, { type: 'application/octet-stream' }) })
    .then((snap) => {
      assert.equal(snap.ok, true, 'HTML под чужим content-type должен разбираться как HTML');
      assert.match(snap.text, /текст/);
    });
});
