// Тесты SEO-проверки статьи.
//
// Скрипт стоит в трёх местах сразу: pre-commit хук, шаг выпуска и свод по
// корпусу в CI. До 12.08.2026 тестов у него не было вовсе, и выяснилось
// это ровно тогда, когда предупреждение «целевой ключ не найден в title»
// оказалось ложным на четырёх статьях из пяти: сравнивалась подстрока, а
// ключ из Wordstat приходит в именительном падеже и без дефисов.
//
// Запуск: node --test scripts/check-seo.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-seo.mjs');

const GOOD_FM = {
  title: 'Маркировка обуви в 2026 году: что обязана делать розница',
  description:
    'Маркировка обуви в рознице: какие коды проверять на кассе, что делать при отказе Честного знака и какие штрафы действуют в 2026 году для магазинов.',
  categories: ['markirovka'],
  tags: ['маркировка товаров', 'честный знак', 'онлайн-касса', 'розница'],
  keywords: ['маркировка обуви'],
};

const GOOD_BODY = `
Текст статьи со ссылкой [на другую тему](/category/kkt), вторая
[ссылка внутрь блога](/blog/chto-takoe-ts-piot/) и третья —
[в словарь](/slovar/kod-markirovki/).

## Как проверить код

Подробности проверки кода маркировки на кассе.

## Что делать при отказе

Порядок действий кассира.

## Какие штрафы

Суммы и статьи.

## Как подготовиться

План на неделю.

## Вопрос-ответ

**Что делать, если код не читается сканером?**
Проверить настройку сканера и очистить упаковку от плёнки.

**Нужно ли перепробивать чек при отказе?**
Нет, достаточно повторить продажу после устранения причины отказа.
`;

function article({ fm = {}, body = GOOD_BODY } = {}) {
  const f = { ...GOOD_FM, ...fm };
  const lines = ['---'];
  if (f.title !== null) lines.push(`title: "${f.title}"`);
  if (f.description !== null) lines.push(`description: "${f.description}"`);
  lines.push('pubDate: "2026-08-12"', 'draft: false');
  if (f.categories) lines.push('categories:', ...f.categories.map((c) => `  - ${c}`));
  if (f.tags) lines.push('tags:', ...f.tags.map((t) => `  - ${t}`));
  if (f.keywords) lines.push('seo:', '  keywords:', ...f.keywords.map((k) => `    - ${k}`));
  lines.push('---');
  return lines.join('\n') + '\n' + body;
}

function run(md, flags = []) {
  const dir = mkdtempSync(join(tmpdir(), 'check-seo-test-'));
  const file = join(dir, 'article.md');
  writeFileSync(file, md);
  try {
    const out = execFileSync('node', [SCRIPT, file, ...flags], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------- проходное */

test('корректная статья проходит без замечаний', () => {
  const r = run(article(), ['--p1']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SEO OK/);
});

/* ------------------------------------------------- блокирующие проверки */

test('нет заголовка — блокер', () => {
  const r = run(article({ fm: { title: null } }));
  assert.equal(r.code, 1);
  assert.match(r.out, /Нет поля title/);
});

test('слишком длинный заголовок — блокер: обрежется в выдаче', () => {
  const r = run(article({ fm: { title: 'Маркировка обуви в 2026 году: что обязана делать розница и как подготовиться заранее без ошибок' } }));
  assert.equal(r.code, 1);
  assert.match(r.out, /title слишком длинный/);
});

test('короткое и длинное описание — блокеры', () => {
  assert.match(run(article({ fm: { description: 'Слишком коротко.' } })).out, /слишком короткий/);
  assert.match(run(article({ fm: { description: 'о'.repeat(200) } })).out, /слишком длинный/);
});

test('мало тегов — блокер', () => {
  const r = run(article({ fm: { tags: ['маркировка'] } }));
  assert.equal(r.code, 1);
  assert.match(r.out, /Мало тегов/);
});

test('нет категории — блокер', () => {
  const r = run(article({ fm: { categories: null } }));
  assert.equal(r.code, 1);
  assert.match(r.out, /Не указана категория/);
});

test('нет целевого запроса — блокер', () => {
  const r = run(article({ fm: { keywords: null } }));
  assert.equal(r.code, 1);
  assert.match(r.out, /Нет seo\.keywords/);
});

test('нет внутренних ссылок — блокер', () => {
  const r = run(article({ body: GOOD_BODY.replace(/\[[^\]]+\]\(\/[^)]+\)/g, 'просто текст') }));
  assert.equal(r.code, 1);
  assert.match(r.out, /Нет ни одной внутренней ссылки/);
});

/* F-01. Раньше FAQ был обязателен без исключений, и требование
 * выполнялось буквально: блок появился во всех десяти статьях корпуса, в
 * большинстве — пересказом собственных H2. Обязательная секция, которую
 * нечем наполнить, наполняется повтором. */
test('FAQ не обязателен: статья без него — не блокер', () => {
  const r = run(article({ body: GOOD_BODY.replace('## Вопрос-ответ', '## Итоги') }), ['--p1']);
  assert.equal(r.code, 0);
  assert.ok(!/FAQ/.test(r.out), `про FAQ ругаться не должны: ${r.out}`);
});

test('FAQ из одного вопроса — предупреждение, а не украшение', () => {
  const body = GOOD_BODY.replace(
    /\*\*Нужно ли перепробивать чек при отказе\?\*\*[\s\S]*$/,
    '',
  );
  const r = run(article({ body }), ['--p1']);
  assert.match(r.out, /FAQ из 1 вопрос/);
});

/* Вопрос, повторяющий заголовок раздела, ответа не добавляет: читатель
 * уже прочитал этот раздел. */
test('FAQ, пересказывающий собственные H2, — предупреждение', () => {
  const body = GOOD_BODY.replace(
    /## Вопрос-ответ[\s\S]*$/,
    ['## Вопрос-ответ', '',
      '**Какие штрафы предусмотрены?**', 'Суммы и статьи.', '',
      '**Как подготовиться к переходу?**', 'План на неделю.', ''].join('\n'),
  );
  const r = run(article({ body }), ['--p1']);
  assert.match(r.out, /пересказывает собственные H2/);
});

/* Норма «ровно три промоблока» выполнялась в девяти статьях из десяти —
 * включая те, где третьей подводке не было места. */
test('промоблоков может не быть вовсе', () => {
  const r = run(article(), ['--p1']);
  assert.ok(!/промоблок/i.test(r.out), r.out);
});

test('больше трёх промоблоков — предупреждение', () => {
  const promos = ['8526', '8530', '8360', '8361']
    .map((id) => `Абзац подводки к блоку.\n\n[Промоблок: ${id}]`).join('\n\n');
  const r = run(article({ body: `${GOOD_BODY}\n\n${promos}\n` }), ['--p1']);
  assert.match(r.out, /больше трёх/);
});

/* ------------------------------------------------------- предупреждения */

// Регрессия 12.08.2026: сравнивалась подстрока, и ключ «личный кабинет
// онлайн кассы» не находился в заголовке «Личный кабинет онлайн-кассы:
// как войти» из-за дефиса. Предупреждение горело на 4 статьях из 5.
test('ключ отражён в заголовке в другой форме — не предупреждение', () => {
  const r = run(article({
    fm: {
      title: 'Личный кабинет онлайн-кассы: как войти и что настраивать',
      keywords: ['личный кабинет онлайн кассы'],
    },
  }), ['--p1']);
  assert.ok(!/Целевой ключ/.test(r.out), `ложное срабатывание: ${r.out}`);
});

test('падеж и предлог не считаются потерей ключа', () => {
  const r = run(article({
    fm: {
      title: 'Новая ставка НДС на кассе: как перейти на 22 % в 2026 году',
      keywords: ['новая ставка НДС касса'],
    },
  }), ['--p1']);
  assert.ok(!/Целевой ключ/.test(r.out), `ложное срабатывание: ${r.out}`);
});

test('слова ключа действительно нет в заголовке — предупреждение с указанием слова', () => {
  const r = run(article({
    fm: {
      title: 'Разрешительный режим: что проверяет касса',
      keywords: ['режим работы разрешительного'],
    },
  }), ['--p1']);
  assert.match(r.out, /Целевой ключ.*не отражён в title.*работы/s);
});

test('без --p1 предупреждения не показываются и не влияют на код', () => {
  const r = run(article({
    fm: { title: 'Разрешительный режим: что проверяет касса', keywords: ['режим работы разрешительного'] },
  }));
  assert.equal(r.code, 0);
  assert.ok(!/Целевой ключ/.test(r.out));
});

test('мало H2 — предупреждение, а не блокер', () => {
  const r = run(article({ body: '[ссылка](/category/kkt)\n\n## Вопрос-ответ\n\nОтвет.' }), ['--p1']);
  assert.equal(r.code, 0);
  assert.match(r.out, /Мало H2/);
});

/* ------------------------------------------------------------------ stdin */

test('чтение из stdin работает — на нём стоит pre-commit хук', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-seo-stdin-'));
  try {
    const out = execFileSync('node', [SCRIPT, '--label=staged.md'], {
      input: article(), encoding: 'utf8',
    });
    assert.match(out, /staged\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── агрегатор не доверяет молчанию ──────────────────────────────────── */

/* `check-seo-all.mjs` собирал вердикт из строк вывода дочернего
 * checker: есть строки с ⚠ или ✗ — грязно, нет — чисто. Пустой вывод
 * попадал во вторую ветку, и статья, на которой checker упал до первой
 * строки, считалась безупречной. Чем сильнее сломан checker, тем чище
 * отчёт — тот же fail-open, что уже закрыт в `gates.mjs`. */
test('агрегатор SEO: молчание дочернего checker — не «замечаний нет»', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'seoall-')));
  try {
    mkdirSync(join(root, 'src/content/blog'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'src/content/blog/a.md'), '---\ntitle: "Проба"\n---\n\nТекст.\n');
    /* Дочерний checker, который завершается успехом и молчит. */
    writeFileSync(join(root, 'scripts/check-seo.mjs'), 'process.exit(0);\n');

    const all = join(dirname(fileURLToPath(import.meta.url)), 'audit', 'check-seo-all.mjs');
    let out = '';
    let code = 0;
    try {
      out = execFileSync('node', [all], {
        encoding: 'utf8', env: { ...process.env, SEO_AUDIT_ROOT: root },
      });
    } catch (e) { code = e.status ?? 1; out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }

    assert.ok(!/Ни одного замечания/.test(out), 'молчание не должно читаться как чистота');
    assert.match(out, /проверка не состоялась/);
    assert.equal(code, 1, 'несостоявшаяся проверка обязана ронять прогон');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
