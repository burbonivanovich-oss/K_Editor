// Тесты журнала прямых правок редакции.
//
// Случай со встречи 12.08.2026: редактор исправляет текст прямо в доке,
// а не комментарием, и ждёт, что в следующей статье бот учтёт. Без
// журнала правка уезжала в репозиторий и забывалась.
//
// Запуск: node --test scripts/editor-edits.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffParagraphs } from './editor-edits.mjs';

const P1 = 'Разрешительный режим работает так: касса отправляет код маркировки в систему и ждёт ответа, продавать товар или нет.';
const P2 = 'Норматив ответа — полторы секунды. Кассир видит результат до того, как пробьёт чек, и это принципиально для очереди.';

test('текст не трогали — правок нет', () => {
  const t = `${P1}\n\n${P2}`;
  assert.deepEqual(diffParagraphs(t, t), []);
});

test('переписанный абзац виден целиком, с «было» рядом', () => {
  const after = `${P1}\n\nНорматив ответа — полторы секунды, и кассир видит результат до чека. Для очереди на кассе это принципиально.`;
  const edits = diffParagraphs(`${P1}\n\n${P2}`, after);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].kind, 'изменён');
  assert.match(edits[0].before, /Кассир видит результат/);
  assert.match(edits[0].after, /Для очереди на кассе/);
});

test('дописанный абзац отличается от переписанного', () => {
  const extra = 'Если ответа нет дольше норматива, касса действует по офлайн-правилу и продажа не блокируется на неопределённый срок.';
  const edits = diffParagraphs(`${P1}\n\n${P2}`, `${P1}\n\n${P2}\n\n${extra}`);
  assert.deepEqual(edits.map((e) => e.kind), ['добавлен']);
  assert.equal(edits[0].before, null);
});

test('удалённый абзац тоже попадает в журнал', () => {
  const edits = diffParagraphs(`${P1}\n\n${P2}`, P1);
  assert.deepEqual(edits.map((e) => e.kind), ['удалён']);
  assert.match(edits[0].before, /Норматив ответа/);
});

// Замечание владельца 12.08.2026: заголовок редакция правит чаще всего,
// и это самая полезная обратная связь — она задаёт, как называть раздел
// в следующих статьях. Раньше заголовки отсекались фильтром длины.
test('переписанный заголовок попадает в журнал', () => {
  const before = `## Как это работает\n\n${P1}`;
  const after = `## Как всё устроено\n\n${P1}`;
  const edits = diffParagraphs(before, after);
  assert.deepEqual(edits.map((e) => e.kind), ['заголовок']);
  assert.equal(edits[0].before, 'Как это работает');
  assert.equal(edits[0].after, 'Как всё устроено');
});

test('добавленный и убранный раздел различаются', () => {
  const base = `## Первый\n\n${P1}`;
  const added = diffParagraphs(base, `${base}\n\n## Второй\n\n${P2}`);
  assert.equal(added.find((e) => e.kind === 'заголовок добавлен').after, 'Второй');
  const removed = diffParagraphs(`${base}\n\n## Второй\n\n${P2}`, base);
  assert.equal(removed.find((e) => e.kind === 'заголовок убран').before, 'Второй');
});

test('заголовок не трогали — правки только по тексту', () => {
  const before = `## Как это работает\n\n${P1}\n\n${P2}`;
  const after = `## Как это работает\n\n${P1}\n\nНорматив ответа — полторы секунды, и кассир видит результат до чека. Для очереди это принципиально.`;
  const edits = diffParagraphs(before, after);
  assert.deepEqual(edits.map((e) => e.kind), ['изменён']);
});

test('разница только в пробелах и переносах — не правка', () => {
  const before = `${P1}\n\n${P2}`;
  const after = `${P1.replace(/ /g, '  ')}\n\n${P2}\n`;
  assert.deepEqual(diffParagraphs(before, after), []);
});
