// Тесты извлечения промпта рутины.
//
// Тест на реальных файлах в конце — не формальность: он ловит случай,
// когда кто-то поправил docs/routines/*.md и снёс разделитель `---`.
// Без разделителя скрипт молча отдал бы пустой промпт, а рутина в
// Actions запустилась бы вообще без задания.
//
// Запуск: node --test scripts/routine-prompt.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRoutine, routinePrompt, ROUTINES } from './routine-prompt.mjs';

const SAMPLE = `# Рутина X

- **Триггер:** \`trig_123\`
- **Расписание:** \`0 7 * * 1\`
- **Окружение:** Editor

---

Тело промпта.

Вторая строка.
`;

test('паспорт и промпт делятся по разделителю', () => {
  const { meta, prompt } = splitRoutine(SAMPLE);
  assert.equal(meta['Триггер'], 'trig_123');
  assert.equal(meta['Расписание'], '0 7 * * 1');
  assert.equal(meta['Окружение'], 'Editor');
  assert.ok(prompt.startsWith('Тело промпта.'));
  assert.ok(!prompt.includes('trig_123'), 'идентификатор платформы не должен попадать в промпт');
});

test('многострочное значение паспорта не ломает разбор', () => {
  const { meta } = splitRoutine('- **Расписание:** понедельник, 10:00\n  продолжение строки\n\n---\n\nтело\n');
  assert.equal(meta['Расписание'], 'понедельник, 10:00');
});

test('неизвестная рутина — понятная ошибка со списком', () => {
  assert.throws(() => routinePrompt('zzz'), /неизвестная рутина/);
});

test('все четыре рутины отдают непустой промпт', () => {
  for (const key of Object.keys(ROUTINES)) {
    const { prompt, meta } = routinePrompt(key);
    assert.ok(prompt.trim().length > 200, `${key}: промпт подозрительно короткий`);
    assert.ok(meta['Расписание'], `${key}: в паспорте нет расписания`);
    assert.ok(!prompt.includes('**Триггер:**'), `${key}: паспорт протёк в промпт`);
  }
});
