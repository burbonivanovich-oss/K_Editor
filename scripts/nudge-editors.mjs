#!/usr/bin/env node
/**
 * Напоминание редакции, когда очередь вычитки встала.
 *
 * Потолок в 6 статей защищает редактора от завала правками. У защиты есть
 * обратная сторона, и её назвали на встрече 12.08.2026: если про статью
 * просто забыли, новые не приходят — и цикл тихо останавливается. Никто не
 * виноват, никто не узнал.
 *
 * Строка состояния в шапке таблицы про это пишет прямым текстом, но видит
 * её только тот, кто таблицу открыл. А он её не открыл — в том и беда.
 *
 * Поэтому напоминание идёт наружу: комментарий в таблице с упоминанием
 * редактора. Упоминание Google рассылает письмом — проверено 11.08.2026 на
 * живом адресе. Не чаще раза в сутки: почасовой прогон превратил бы заботу
 * в спам, а спам начинают игнорировать вместе с полезным.
 *
 * Использование: node scripts/nudge-editors.mjs --sheet-id <id> [--days 3]
 * Адреса — в EDITOR_EMAILS (через запятую). Пусто — молча выходим: в
 * публичный репозиторий адреса не кладём.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
};
const run = (script, args) =>
  execFileSync('node', [join(__dir, script), ...args], { encoding: 'utf8' });

const sheetId = arg('sheet-id');
if (!sheetId) { console.error('✖ нужен --sheet-id'); process.exit(1); }

const editors = (process.env.EDITOR_EMAILS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (!editors.length) {
  console.log('EDITOR_EMAILS не задан — некому напоминать, выхожу.');
  process.exit(0);
}

const state = JSON.parse(run('cycle-state.mjs', ['stale-review', '--days', arg('days', '3')]));
if (!state.due) {
  console.log(
    state.lastNudge === new Date().toISOString().slice(0, 10)
      ? 'Сегодня уже напоминали — молчу.'
      : 'Очередь свободна, залежавшихся статей нет — напоминать не о чем.',
  );
  process.exit(0);
}

/* Текст пишем так, чтобы он был понятен из письма, без открывания таблицы:
   что случилось, сколько ждёт, с чего начать. */
const lines = [];
if (state.stale.length) {
  lines.push(
    `Статей ждёт вычитки: ${state.stale.length}. Дольше всех — «${state.stale[0].title}» ` +
    `(${state.stale[0].waited} дн.).`,
  );
}
if (state.queueFull) {
  lines.push(
    `Очередь заполнена (${state.occupied} из ${state.max}), поэтому новые статьи не приходят. ` +
    (state.blockedTopics ? `Ждут своей очереди тем: ${state.blockedTopics}.` : ''),
  );
}
lines.push('Поставьте «принято» в колонке «Решение» у готовых статей — очередь освободится сама.');

const text = lines.join(' ');
run('drive-sync.mjs', ['comment', '--file-id', sheetId, '--text', text, '--mention', editors[0]]);
run('cycle-state.mjs', ['mark-nudged']);
console.log(`✅ Напомнили: ${text}`);
