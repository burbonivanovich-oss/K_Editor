#!/usr/bin/env node
/**
 * Недельная сводка для редактора.
 *
 * Рутины по дизайну молчат, когда ничего не произошло: слушатель
 * срабатывает около двадцати раз в неделю, и письмо на каждый проход
 * превратилось бы в шум. Но со стороны редактора у молчания нет разницы
 * между «всё спокойно» и «сломалось в понедельник»: неделя без писем
 * читается одинаково в обоих случаях.
 *
 * Сводка закрывает именно это — один раз в неделю, с тем, что редактору
 * нужно решить, и с явной строкой «ничего не произошло», если правда
 * ничего не произошло.
 *
 * Отдельный файл, а не комментарий в таблице, по практической причине:
 * письмо Google шлёт при выдаче доступа к НОВОМУ файлу (drive-sync.mjs,
 * notify). Новый док каждую неделю — единственный способ дотянуться до
 * почты повторно, не выпрашивая у Google того, чего он не делает.
 *
 * Запуск:
 *   node scripts/weekly-digest.mjs            # markdown в stdout
 *   node scripts/weekly-digest.mjs --json      # то же машиночитаемо
 *   node scripts/weekly-digest.mjs --out /tmp/digest.md
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Переопределяется в тестах: сводка считается по состоянию цикла, и
// проверять её на живом состоянии — значит проверять сегодняшний день.
const ROOT = process.env.DIGEST_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, 'src', 'data', 'editorial-cycle.json');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;

if (!existsSync(STATE)) {
  console.error('Нет src/data/editorial-cycle.json — цикл ещё не запускался.');
  process.exit(1);
}
const s = JSON.parse(readFileSync(STATE, 'utf8'));

const today = new Date().toISOString().slice(0, 10);
const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const days = (from) => (from ? Math.max(0, Math.round((Date.parse(today) - Date.parse(from)) / 86400000)) : 0);
const byStatus = (st) => s.plan.filter((t) => t.status === st);

const rank = { P0: 0, P1: 1, P2: 2 };
const waiting = byStatus('review')
  .sort((a, b) => days(b.reviewSince) - days(a.reviewSince) || (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1));

/* За неделю: события лога, а не пересчёт статусов. Статус показывает, где
   тема сейчас, а редактору важно, что изменилось с прошлой сводки. */
const events = (s.log ?? []).filter((e) => (e.at ?? '').slice(0, 10) >= weekAgo);
const happened = {
  released: byStatus('released').filter((t) => days(t.reviewSince) <= 7).length,
  accepted: byStatus('accepted').length,
  writing: byStatus('writing').length,
  planned: s.plan.filter((t) => t.status === 'planned' && t.owner === 'bot').length,
  ownTopics: s.plan.filter((t) => t.owner === 'editor' && !['released', 'dropped'].includes(t.status)).length,
  dropped: byStatus('dropped').length,
};

const occupied = happened.writing + waiting.length;
const paused = s.pausedUntil && s.pausedUntil >= today ? s.pausedUntil : null;

const data = {
  generatedAt: today,
  cycleId: s.cycleId,
  state: s.state,
  pausedUntil: paused,
  queue: { occupied, max: s.maxInReview },
  waiting: waiting.map((t) => ({
    title: t.title, priority: t.priority || 'P1', days: days(t.reviewSince), docUrl: t.docUrl || null,
  })),
  counts: happened,
  eventsThisWeek: events.length,
};

if (asJson) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

const lines = [];
lines.push(`# Сводка редакции за неделю — ${today}`);
lines.push('');

if (paused) {
  lines.push(`**Пауза до ${paused}.** Новые статьи не пишутся. Снять — вернуть «ОДОБРЕН» в ячейку B2 таблицы плана.`);
  lines.push('');
}

if (['idle', 'done'].includes(s.state)) {
  // Отдельная ветка: очередь пуста не потому, что вы всё разобрали, а
  // потому что активного цикла нет. Не сказать об этом — значит показать
  // редактору бодрую сводку про пустую очередь в момент, когда план
  // просто не создан.
  lines.push(s.state === 'idle'
    ? 'Активного цикла сейчас нет: контент-план на месяц ещё не создан. Он появится 1-го числа, отдельной таблицей в этой же папке.'
    : 'Цикл завершён: все темы этого месяца выпущены или сняты. Следующий план придёт 1-го числа.');
} else if (!waiting.length && !happened.writing && !events.length) {
  lines.push('За неделю ничего не изменилось: новых статей не было, решений в таблице тоже.');
  lines.push('');
  lines.push(
    s.state === 'awaiting_review'
      ? 'Причина: план ждёт согласования — поставьте «ОДОБРЕН» в ячейке B2, до этого статьи не пишутся.'
      : 'Если это не то, чего вы ожидали, — напишите тому, кто ведёт проект: возможно, что-то встало.',
  );
} else {
  lines.push('## Ждёт вас');
  lines.push('');
  if (!waiting.length) {
    lines.push('Ничего. Очередь вычитки пуста.');
  } else {
    lines.push(`${waiting.length} ${waiting.length === 1 ? 'статья' : 'статей'} на вычитке. Разбирать сверху вниз — первыми те, что ждут дольше:`);
    lines.push('');
    for (const t of waiting) {
      const url = t.docUrl ? ` — [документ](${t.docUrl})` : '';
      lines.push(`- **${t.title}** (${t.priority || 'P1'}, ждёт ${days(t.reviewSince)} дн.)${url}`);
    }
  }
  lines.push('');
  lines.push('## Что происходит');
  lines.push('');
  lines.push(`- Очередь: ${occupied} из ${s.maxInReview}${occupied >= s.maxInReview ? ' — новые статьи не придут, пока не разберёте' : ''}`);
  if (happened.writing) lines.push(`- Пишется прямо сейчас: ${happened.writing}`);
  if (happened.accepted) lines.push(`- Принято вами, ждёт выпуска: ${happened.accepted}`);
  if (happened.planned) lines.push(`- Тем в плане, до которых очередь ещё не дошла: ${happened.planned}`);
  if (happened.ownTopics) lines.push(`- Тем «пишем сами» за вами: ${happened.ownTopics}`);
}

lines.push('');
lines.push('---');
lines.push('');
lines.push('Решения ставятся в таблице плана, колонка «Решение». Инструкция — документ «Инструкция редактора» в той же папке.');

const md = lines.join('\n') + '\n';
if (outPath) {
  writeFileSync(outPath, md);
  console.log(`✅ Сводка: ${outPath}`);
} else {
  process.stdout.write(md);
}
