// Тесты хелпера isMain: скрипт понимает, что запущен как команда.
//
// Проверка нужна не ради самой функции в три строки, а потому что её
// предшественник — ручная сборка `file://${process.argv[1]}` — молча
// ломался на пробеле в пути. Рабочий каталог редакции лежит в
// «Claude Local», и девять чекеров годами завершались кодом 0, ничего
// не проверив. Пустой вывод читался как «нарушений нет».
//
// Поэтому здесь каждый случай — про путь: пробел, кириллица, иероглифы,
// процент, относительный вызов, симлинк. И отдельно — доказательство,
// что старое условие на этих же путях ложно: иначе тест ничего не стоит.
//
// Запуск: node --test scripts/lib/is-main.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, cpSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = dirname(fileURLToPath(import.meta.url));

/* Зонд печатает «CLI», когда считает себя точкой входа, и «MODULE»,
 * когда нет. Молчание — третий, недопустимый исход: именно так вёл себя
 * сломанный guard. */
const PROBE = `import { isMain } from './is-main.mjs';
export const marker = 'imported';
if (isMain(import.meta.url)) console.log('CLI');
else console.log('MODULE');
`;

/* То же решение старым способом — для доказательства, что случай
 * действительно был сломан, а не просто «теперь работает». */
const LEGACY = `console.log(import.meta.url === \`file://\${process.argv[1]}\` ? 'CLI' : 'MODULE');
`;

/** Каталог с зондом внутри; `name` — имя подкаталога, которое и есть случай.
 *
 * realpathSync здесь обязателен: на macOS os.tmpdir() — это симлинк
 * (/var → /private/var). Node разворачивает его для import.meta.url, но
 * не для argv[1], и без realpath каждый случай ломался бы по двум
 * причинам сразу — не понять, какую именно ловит тест. */
function withProbe(name, fn) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'is-main-')));
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(LIB, 'is-main.mjs'), join(dir, 'is-main.mjs'));
  writeFileSync(join(dir, 'probe.mjs'), PROBE);
  writeFileSync(join(dir, 'legacy.mjs'), LEGACY);
  try { return fn(dir, base); } finally { rmSync(base, { recursive: true, force: true }); }
}

const run = (args, opts = {}) =>
  execFileSync('node', args, { encoding: 'utf8', timeout: 20000, ...opts }).trim();

/* Пробел — тот самый случай «Claude Local». Остальные из того же
 * семейства: всё, что URL обязан кодировать, ломало старое сравнение. */
const CASES = {
  'обычный путь': 'plain',
  'пробел в пути': 'Claude Local',
  'кириллица': 'Контур редакция',
  'иероглифы': '編集 テスト',
  'процент и решётка': 'a%20b #1',
  'два пробела подряд': 'a  b',
};

for (const [title, name] of Object.entries(CASES)) {
  test(`запуск как команда распознан: ${title}`, () => {
    withProbe(name, (dir) => {
      assert.equal(run([join(dir, 'probe.mjs')]), 'CLI');
    });
  });
}

test('старое условие на пути с пробелом ложно — случай был сломан по-настоящему', () => {
  withProbe('Claude Local', (dir) => {
    assert.equal(run([join(dir, 'legacy.mjs')]), 'MODULE',
      'если здесь CLI — тест перестал доказывать исходную поломку');
  });
  withProbe('plain', (dir) => {
    assert.equal(run([join(dir, 'legacy.mjs')]), 'CLI',
      'старое условие работало только на путях без спецсимволов');
  });
});

test('относительный путь запуска — тоже команда', () => {
  withProbe('Claude Local', (dir, base) => {
    assert.equal(run(['./probe.mjs'], { cwd: dir }), 'CLI');
    assert.equal(run([join('Claude Local', 'probe.mjs')], { cwd: base }), 'CLI');
    assert.equal(run([relative(base, join(dir, 'probe.mjs'))], { cwd: base }), 'CLI');
  });
});

test('запуск через симлинк — тоже команда', () => {
  withProbe('Claude Local', (dir, base) => {
    const link = join(base, 'ссылка на probe.mjs');
    symlinkSync(join(dir, 'probe.mjs'), link);
    assert.equal(run([link]), 'CLI');
  });
});

test('импорт модуля не запускает CLI', () => {
  withProbe('Claude Local', (dir) => {
    const host = join(dir, 'host.mjs');
    writeFileSync(host, "import { marker } from './probe.mjs';\nconsole.log(marker);\n");
    assert.equal(run([host]), 'MODULE\nimported');
  });
});

test('без argv[1] (код из -e) модуль не считает себя командой', () => {
  withProbe('Claude Local', (dir) => {
    const url = `file://${encodeURI(join(dir, 'probe.mjs')).replace(/#/g, '%23')}`;
    const out = run(['-e', `import('${join(dir, 'is-main.mjs')}').then(m => console.log(m.isMain('${url}')))`]);
    assert.equal(out, 'false');
  });
});
