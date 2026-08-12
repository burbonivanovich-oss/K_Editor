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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

Что делать, если код не читается.
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

test('нет блока вопросов — блокер: он критичен для нейровыдачи', () => {
  const r = run(article({ body: GOOD_BODY.replace('## Вопрос-ответ', '## Итоги') }));
  assert.equal(r.code, 1);
  assert.match(r.out, /Нет FAQ-блока/);
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
