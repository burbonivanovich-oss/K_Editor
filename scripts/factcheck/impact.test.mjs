/**
 * H-07. Разбор правки: что сохранить, что перепроверить.
 *
 * Проверяется главное свойство — умолчание строгое. Любая правка, класс
 * которой определить не удалось, обязана требовать полного факчека, а не
 * считаться косметикой. И обратное: доказанно форматная правка не должна
 * тянуть за собой перепроверку статьи целиком, иначе гейт дешевле
 * обойти, чем выполнить.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impactOf } from './impact.mjs';

const article = (body, fm = 'draft: true') => `---\ntitle: "Проба"\n${fm}\n---\n\n${body}\n`;
const EXTRACTION = {
  claims: [
    { id: 'c1', raw: '10 000 ₽' },
    { id: 'c2', raw: '30 000 ₽' },
    { id: 'c3', raw: '01.10.2026' },
  ],
};

const TEXT = 'Организация обязана заплатить 10 000 ₽ штрафа при первом нарушении.\n\n'
  + 'Для юридического лица сумма другая — 30 000 ₽, и это отдельная норма.\n\n'
  + 'Срок подключения — 01.10.2026, продлений больше не будет.';

const run = (before, after) => impactOf({ before, after, extraction: EXTRACTION });

test('текст не менялся — preserve без разбора', () => {
  const a = article(TEXT);
  const r = run(a, a);
  assert.equal(r.decision, 'preserve');
  assert.equal(r.beforeHash, r.afterHash);
});

test('правка frontmatter — preserve, доказательства живут', () => {
  const r = run(article(TEXT, 'draft: true'), article(TEXT, 'draft: false'));
  assert.equal(r.class, 'style');
  assert.equal(r.decision, 'preserve');
  assert.deepEqual(r.affectedClaimIds, []);
});

test('правка суммы — invalidate, и названо какое утверждение', () => {
  const r = run(article(TEXT), article(TEXT.replace('10 000 ₽ штрафа', '100 000 ₽ штрафа')));
  assert.equal(r.class, 'fact');
  assert.equal(r.decision, 'invalidate');
  assert.ok(r.affectedClaimIds.includes('c1'), `не найдено c1: ${r.affectedClaimIds}`);
  assert.ok(!r.affectedClaimIds.includes('c3'), 'затронуто утверждение из нетронутого абзаца');
});

test('смена модальности — invalidate по области применимости', () => {
  const r = run(article(TEXT), article(TEXT.replace('обязана заплатить', 'вправе заплатить')));
  assert.equal(r.class, 'scope');
  assert.equal(r.decision, 'invalidate');
  assert.ok(r.affectedClaimIds.includes('c1'));
});

test('дописанный абзац — refactcheck: сравнивать не с чем', () => {
  /* В новом абзаце может быть новая сумма, новая норма, новое условие —
   * и ни одно из них не заметит сравнение с тем, чего раньше не было. */
  const r = run(article(TEXT), article(`${TEXT}\n\nНовый абзац про штраф 50 000 ₽ и новую норму.`));
  assert.equal(r.class, 'unknown');
  assert.equal(r.decision, 'refactcheck');
});

test('переписанный заголовок — refactcheck, а не «стиль»', () => {
  /* Заголовок задаёт обещание раздела; проверить его выполнение
   * сравнением слов нельзя. */
  const r = run(article(`## Как платить\n\n${TEXT}`), article(`## Когда можно не платить\n\n${TEXT}`));
  assert.equal(r.decision, 'refactcheck');
});

test('смысловая правка вне реестра сужать перепроверку не позволяет', () => {
  /* Утверждений реестра в этом месте нет — значит, неизвестно, что
   * именно пострадало, и «затронуто ноль» не равно «ничего не сломалось». */
  const before = article('Совсем другой абзац про 7 дней.');
  const after = article('Совсем другой абзац про 9 дней.');
  const r = impactOf({ before, after, extraction: { claims: [] } });
  assert.equal(r.class, 'fact');
  assert.equal(r.decision, 'refactcheck');
  assert.ok(r.reasons.some((x) => /сузить перепроверку не по чему/.test(x)));
});

test('худший класс правки решает за всю статью', () => {
  /* Одна форматная правка и одна фактическая — это фактическая правка. */
  const after = article(TEXT
    .replace('при первом нарушении', 'при нарушении впервые')     // стиль
    .replace('30 000 ₽', '300 000 ₽'));                            // факт
  const r = run(article(TEXT), after);
  assert.equal(r.class, 'fact');
  assert.equal(r.decision, 'invalidate');
  assert.ok(r.affectedClaimIds.includes('c2'));
});

test('исчезнувшая цитата попадает в затронутые', () => {
  const r = run(article(TEXT), article(TEXT.replace('10 000 ₽ штрафа', 'фиксированного штрафа')));
  assert.ok(r.affectedClaimIds.includes('c1'), 'утверждение, чья цитата исчезла, не попало в затронутые');
});
