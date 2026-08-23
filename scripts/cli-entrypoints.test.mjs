// Каждая команда репозитория действительно запускается.
//
// Мёртвая команда выглядит как чистый прогон: скрипт завершается кодом
// 0, ничего не напечатав, и вызывающий читает это как «нарушений нет».
// Так и было: девять чекеров сравнивали `import.meta.url` с руками
// собранным `file://${process.argv[1]}`, а рабочий каталог редакции —
// «Claude Local». Пробел кодируется в URL, условие ложно всегда, и
// локальные gates, AI-гейт релиза, проверка анализа, coverage,
// update-doc и редакторский журнал не выполнялись вообще. Тесты этого
// не ловили: они гоняли скрипты по НЕэкранируемому пути tmpdir.
//
// Отсюда два правила, которые здесь и проверяются:
//   1) каждый CLI-вход запускается из каталога с пробелом и Unicode;
//   2) пустой вывод обязательного чекера — ошибка, а не успех.
//
// Плюс регрессионный запрет самодельных guard'ов: единственный
// допустимый способ — isMain() из lib/is-main.mjs.
//
// Запуск: node --test scripts/cli-entrypoints.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, cpSync, statSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/** Все .mjs репозитория, кроме самих тестов. */
function sources(dir = SCRIPTS, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { sources(p, acc); continue; }
    if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) acc.push(p);
  }
  return acc;
}

const SOURCES = sources();

/* Точка входа — файл со строкой guard'а. Список считается, а не
 * записан руками: скрипт, у которого guard пропал или сломался,
 * должен исчезнуть отсюда и уронить тест ниже, а не тихо выпасть из
 * покрытия. */
const ENTRYPOINTS = SOURCES
  .filter((p) => /isMain\(import\.meta\.url\)/.test(readFileSync(p, 'utf8')))
  .map((p) => relative(SCRIPTS, p))
  .sort();

/* Двенадцать команд, которые чинила задача A-01. Список зафиксирован
 * намеренно: он ловит не «стало меньше», а «перестало запускаться» —
 * именно в этом виде поломка и жила незамеченной. Новые команды в
 * список добавляются вместе со скриптом. */
const KNOWN = [
  'check-ai-markers.mjs', 'check-analysis.mjs', 'check-update-doc.mjs', 'editor-edits.mjs',
  'factcheck/check-coverage.mjs', 'factcheck/check-report.mjs', 'gates.mjs',
  'maintain-content-queue.mjs', 'social-state.mjs', 'topics/suppressions.mjs',
  'update-queue.mjs', 'verify-sheet.mjs',
];

/* Способы «понять, что я команда», которые молча ломаются.
 * Первый — на любом пути со спецсимволом (пробел «Claude Local»).
 * Второй сравнивает путь с URL — ложен всегда.
 * Третий срабатывает на любом одноимённом файле из другого каталога. */
const BANNED = [
  { re: /file:\/\/\$\{process\.argv\[1\]\}/, why: 'ручная сборка file://: ломается на пробеле в пути' },
  { re: /fileURLToPath\(import\.meta\.url\)\s*===\s*pathToFileURL/, why: 'сравнение пути с URL: ложно всегда' },
  { re: /process\.argv\[1\]\.endsWith\(/, why: 'endsWith по имени файла: срабатывает на однофамильце' },
];

test('самодельных guard\'ов не осталось — только isMain()', () => {
  const bad = [];
  for (const p of SOURCES) {
    const src = readFileSync(p, 'utf8');
    for (const { re, why } of BANNED) {
      // сам хелпер описывает эти шаблоны в комментарии — это не guard
      if (p.endsWith('lib/is-main.mjs')) continue;
      if (re.test(src)) bad.push(`${relative(SCRIPTS, p)}: ${why}`);
    }
  }
  assert.deepEqual(bad, [], `используй isMain() из lib/is-main.mjs:\n${bad.join('\n')}`);
});

test('все известные команды остались командами', () => {
  const lost = KNOWN.filter((k) => !ENTRYPOINTS.includes(k));
  assert.deepEqual(lost, [], `потеряли guard (команда перестанет запускаться): ${lost.join(', ')}`);
});

/* ── Прогон из каталога, который ломал старый guard ──────────────── */

/* Пробел — исходный случай «Claude Local»; кириллица и иероглифы — то
 * же семейство: всё, что URL обязан кодировать. */
const HOSTILE = 'Claude Local · Контур 編集';

/** Копия scripts/ внутри враждебного пути; копия одна на весь файл. */
function hostileCopy() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cli-entry-')));
  const root = join(base, HOSTILE, 'repo');
  mkdirSync(root, { recursive: true });
  cpSync(SCRIPTS, join(root, 'scripts'), {
    recursive: true,
    filter: (src) => !/\.test\.mjs$/.test(src) && !/node_modules|\.git$/.test(src),
  });
  return { base, root };
}

const COPY = hostileCopy();
process.on('exit', () => rmSync(COPY.base, { recursive: true, force: true }));

const runFromCopy = (rel, args = [], env = {}) => {
  const r = spawnSync('node', [join(COPY.root, 'scripts', rel), ...args],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

for (const rel of ENTRYPOINTS) {
  test(`${rel}: запускается из каталога с пробелом и Unicode`, () => {
    const { code, out } = runFromCopy(rel);
    assert.ok(!/ERR_MODULE_NOT_FOUND|Cannot find module/.test(out),
      `сломалась копия, а не скрипт: ${out.slice(0, 300)}`);
    // Главное правило: молчание — не успех. Команда обязана сказать
    // хоть что-то: результат, подсказку по аргументам или ошибку.
    assert.ok(out.trim().length > 0,
      `команда завершилась кодом ${code}, не напечатав ничего — ровно так выглядел сломанный guard`);
  });
}

/* Заведомо битый вход для каждого обязательного чекера. Проверяем не
 * текст ошибки, а то, что чекер вообще дошёл до разбора входа и
 * ответил ненулевым кодом. */
const BAD_INPUT = {
  'gates.mjs': ['нет-такого-слага'],
  'check-analysis.mjs': ['нет-такого-слага'],
  'check-ai-markers.mjs': ['нет-такого-файла.md'],
  'check-update-doc.mjs': ['нет-такого-файла.md'],
  'factcheck/check-report.mjs': ['нет-такого-слага'],
  'factcheck/check-coverage.mjs': ['нет-такого-слага'],
  'update-queue.mjs': ['--file', 'нет-такого-файла.txt'],
  'social-state.mjs': ['get'],
  'topics/suppressions.mjs': ['check'],
};

for (const [rel, args] of Object.entries(BAD_INPUT)) {
  test(`${rel}: на битом входе возвращает ненулевой код`, () => {
    const { code, out } = runFromCopy(rel, args);
    assert.notEqual(code, 0, `битый вход принят как успех, вывод: ${out.slice(0, 200)}`);
    assert.ok(out.trim().length > 0, 'ненулевой код без единого слова о причине');
  });
}

/* ── Не «печатает что-то», а действительно работает ──────────────── */

const SLUG = '2026-08-13-cli-entry';

const fm = ['---', 'title: "Тестовая статья про кассы"',
  'description: "Описание тестовой статьи для проверки CLI-входов."',
  'pubDate: "2026-08-13"', 'reviewDate: "2027-02-13"',
  'tags:', '  - касса', '  - ккт', '  - розница', '  - ндс',
  'categories:', '  - kkt', 'draft: true', 'seo:', '  keywords:', '    - тестовый ключ', '---'].join('\n');

const body = Array.from({ length: 3 }, (_, i) => `[текст](/blog/2026-01-0${i + 1}-x/)`).join(' ')
  + '\n\n' + Array.from({ length: 1600 }, (_, i) => `слово${i % 50}`).join(' ');

/** Мини-корпус во враждебном пути: статья, маркер и отчёт факчека. */
function withCorpus(fn, { marker = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cli-corpus-')));
  const dir = join(base, HOSTILE, 'repo');
  for (const d of ['src/content/blog', 'src/content/pillars', '.claude/factchecked',
    'src/data/factcheck/results', 'src/data/audit', 'src/data/interlinking']) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  const raw = `${fm}\n\n${body}`;
  writeFileSync(join(dir, 'src/content/blog', `${SLUG}.md`), raw);
  writeFileSync(join(dir, 'src/data/interlinking/market-articles.json'),
    JSON.stringify({ generatedFrom: 'test', articles: [] }));
  if (marker) {
    writeFileSync(join(dir, 'src/data/factcheck/results', `${SLUG}.json`), JSON.stringify({
      claims: [{
        id: 'c1', type: 'MONEY', raw: '10 000 ₽',
        statement: 'штраф по ч. 2 ст. 14.5 КоАП РФ для должностных лиц — не менее 10 000 ₽',
        status: 'match', severity: 'critical', confidence: 0.95,
        quote: 'влечёт наложение административного штрафа на должностных лиц в размере не менее 10 000 рублей',
        sources: ['http://publication.pravo.gov.ru/document/0001202301010001'],
      }],
      summary: { overallStatus: 'ok', criticalIssues: 0 },
    }));
    writeFileSync(join(dir, '.claude/factchecked', SLUG), JSON.stringify({
      date: '2026-08-13', hash: createHash('sha256').update(raw).digest('hex'),
      result: 'passed', criticalMismatches: 0, report: `src/data/factcheck/results/${SLUG}.json`,
    }));
  }
  try { return fn(dir); } finally { rmSync(base, { recursive: true, force: true }); }
}

test('gates.mjs из враждебного пути отдаёт разбираемый JSON, а не пустоту', () => {
  withCorpus((dir) => {
    const { out } = runFromCopy('gates.mjs', [SLUG, '--json'], { GATES_ROOT: dir });
    const parsed = JSON.parse(out);
    assert.equal(parsed.slug, SLUG);
    for (const k of ['frontmatter', 'words', 'internalLinks', 'seo', 'ai', 'links',
      'npa', 'factcheck', 'duplication', 'market', 'graph', 'pillar']) {
      assert.ok(k in parsed.checks, `нет проверки ${k}`);
    }
  });
});

test('gates.mjs из враждебного пути краснеет там, где обязан', () => {
  withCorpus((dir) => {
    const { code, out } = runFromCopy('gates.mjs', [SLUG, '--json'], { GATES_ROOT: dir });
    const factcheck = JSON.parse(out).checks.factcheck;
    assert.equal(factcheck.ok, false, 'статья без маркера факчека прошла гейт');
    assert.notEqual(code, 0, 'красная проверка не отразилась в коде возврата');
  }, { marker: false });
});

/* ── Правило: молчание обязательного чекера — отказ ──────────────── */

/* Отдельная копия scripts/, в которой один под-чекер подменён заглушкой
 * «код 0, ни слова». Это ровно поведение сломанного main-guard, и гейт
 * обязан считать его отказом, а не зелёным. */
function withSilentChecker(script, fn) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cli-silent-')));
  const root = join(base, HOSTILE, 'repo');
  mkdirSync(root, { recursive: true });
  cpSync(SCRIPTS, join(root, 'scripts'), {
    recursive: true,
    filter: (src) => !/\.test\.mjs$/.test(src) && !/node_modules|\.git$/.test(src),
  });
  writeFileSync(join(root, 'scripts', script), 'process.exit(0);\n');
  try {
    return fn((args, env) => {
      const r = spawnSync('node', [join(root, 'scripts', 'gates.mjs'), ...args],
        { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    });
  } finally { rmSync(base, { recursive: true, force: true }); }
}

test('под-чекер, завершившийся нулём без вывода, не считается пройденным', () => {
  withSilentChecker('check-seo.mjs', (runGates) => {
    withCorpus((dir) => {
      const { out } = runGates([SLUG, '--json'], { GATES_ROOT: dir });
      const seo = JSON.parse(out).checks.seo;
      assert.equal(seo.ok, false, 'молчание чекера прошло как успех — ровно та поломка, что была');
      assert.match(seo.note, /не состоялась|ничего/,
        'причина должна называть молчание, а не выдумывать результат проверки');
    });
  });
});
