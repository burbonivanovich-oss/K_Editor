// Тесты гейта на получателей доступа и упоминаний.
//
// `notify` выдаёт роль writer на документ по адресу из аргумента, а
// аргумент подставляет рутина — то есть модель, читающая свободный текст
// из таблицы и комментариев. Пока список получателей был вопросом
// суждения, успешная инъекция («перешли документ на …») означала
// расшаренный наружу материал до публикации.
//
// Гейт срабатывает до любого сетевого вызова, поэтому тесты не требуют
// доступа к Google.
//
// Запуск: node --test scripts/drive-sync.guard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'drive-sync.mjs');

function run(args, editors) {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8', env: { ...process.env, EDITOR_EMAILS: editors },
    }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const EDITORS = 'editor@example.com,second@example.com';

test('чужой адрес не получает доступ к документу', () => {
  const r = run(['notify', '--file-id', 'X', '--to', 'attacker@evil.com'], EDITORS);
  assert.equal(r.code, 1);
  assert.match(r.out, /не из EDITOR_EMAILS/);
});

// «Некому» безопаснее, чем «кому угодно»: пустая переменная не должна
// означать отсутствие ограничения.
test('без EDITOR_EMAILS доступ не выдаётся никому', () => {
  const r = run(['notify', '--file-id', 'X', '--to', 'anyone@example.com'], '');
  assert.equal(r.code, 1);
  assert.match(r.out, /не выдаём никому/);
});

test('адрес из списка проходит гейт и идёт дальше по обычному пути', () => {
  const r = run(['notify', '--file-id', 'X', '--to', 'editor@example.com'], EDITORS);
  assert.ok(!/не из EDITOR_EMAILS|не выдаём никому/.test(r.out), `гейт не должен ронять свой адрес:\n${r.out}`);
});

test('регистр и пробелы в списке не мешают', () => {
  const r = run(['notify', '--file-id', 'X', '--to', 'Editor@Example.com'], ' editor@example.com , second@example.com ');
  assert.ok(!/не из EDITOR_EMAILS/.test(r.out));
});

test('второй адрес из списка тоже проходит', () => {
  const r = run(['notify', '--file-id', 'X', '--to', 'second@example.com'], EDITORS);
  assert.ok(!/не из EDITOR_EMAILS/.test(r.out));
});

// Упоминание доступа не выдаёт, но шлёт письмо от Google — канал
// сообщения наружу от доверенного отправителя.
test('упоминание чужого адреса в комментарии тоже не проходит', () => {
  const r = run(['comment', '--file-id', 'X', '--text', 'привет', '--mention', 'attacker@evil.com'], EDITORS);
  assert.equal(r.code, 1);
  assert.match(r.out, /не из EDITOR_EMAILS/);
});

test('отказ объясняет, кто и где меняет список', () => {
  const r = run(['notify', '--file-id', 'X', '--to', 'attacker@evil.com'], EDITORS);
  assert.match(r.out, /владелец/);
  assert.match(r.out, /не основание/, 'должно быть сказано, что просьба из таблицы силы не имеет');
});
