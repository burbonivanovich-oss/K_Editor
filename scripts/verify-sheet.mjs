#!/usr/bin/env node
/**
 * Сверка таблицы редакции с состоянием цикла.
 *
 * Зачем это есть. 11.08.2026 за один день нашлось четыре поломки на стыке
 * кода и Google Sheets, и все — молчаливые: чтение бэклога со сдвигом на
 * две колонки, запись статусов в чужие колонки по зашитым буквам, пустая
 * колонка ID (все темы цикла числились пропавшими), потеря ссылок на доки
 * при переносе месяца. Ни одна не ловится юнит-тестами: те проверяют
 * машину состояний, а не то, что реально лежит в таблице. Все четыре
 * нашлись только прогоном на живых данных — глазами.
 *
 * Проверка делает это за человека: читает таблицу обратно и сверяет с
 * src/data/editorial-cycle.json. Расхождение — не «предупреждение», а
 * ненулевой код возврата: молчаливая порча данных дороже упавшего шага.
 *
 * Использование:
 *   node scripts/verify-sheet.mjs --sheet-id <id> [--tab "Темы и статьи 2026-08"]
 *   node scripts/verify-sheet.mjs --pull /tmp/pull.json      # уже прочитанное
 *
 * Второй вариант нужен и в рутинах (не читать таблицу дважды), и в тестах.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORK_COLS, RU_STATUS, isPriority } from './lib/sheet-columns.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.CYCLE_STATE_PATH || join(__dir, '..', 'src/data/editorial-cycle.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}

/** Сравнение таблицы с состоянием. Чистая функция — её и проверяют тесты. */
export function compare(state, pull) {
  const problems = [];
  const add = (kind, detail) => problems.push({ kind, detail });

  /* 1. Раскладка колонок. Проверяем первой: если заголовки разъехались,
        все остальные расхождения — следствие, и чинить надо не их. */
  const expected = WORK_COLS.map((c) => c.title);
  const actual = (pull.columns || []).map((h) => String(h || '').trim());
  if (!actual.length) {
    add('нет заголовков', 'строка заголовков пуста — таблица не размечена');
  } else {
    expected.forEach((title, i) => {
      const got = actual[i] || '';
      if (got.toLowerCase() !== title.toLowerCase()) {
        add('колонка не на месте', `${i + 1}-я колонка: ожидали «${title}», в таблице «${got || 'пусто'}»`);
      }
    });
  }

  /* 2. Строки. Сопоставляем по slug — по нему же работает apply-decisions,
        и если он не сходится, решения редактора не применятся ни к чему. */
  const bySlug = new Map((pull.items || []).map((i) => [i.slug, i]));
  const live = (state.plan || []).filter((t) => t.status !== 'dropped');

  for (const t of live) {
    const row = bySlug.get(t.slug);
    if (!row) {
      add('темы нет в таблице', `«${t.title}» (${t.slug}) есть в состоянии, но не в таблице`);
      continue;
    }
    const wantStatus = RU_STATUS[t.status] || t.status;
    // Статус в таблице может нести хвост «· 3 дн.» — это подпись возраста,
    // её дописывает sheet-sync, и на сравнение она влиять не должна.
    const gotStatus = String(row.status || '').split('·')[0].trim();
    if (gotStatus !== wantStatus) {
      add('статус разошёлся', `«${t.title}»: в состоянии «${wantStatus}», в таблице «${gotStatus || 'пусто'}»`);
    }
    if (t.docUrl && !String(row.doc || '').includes(t.docId || t.docUrl)) {
      add('нет ссылки на док', `«${t.title}»: док есть в состоянии, в таблице колонка «Документ» пуста или другая`);
    }
    if (row.priority && !isPriority(row.priority)) {
      add('приоритет не из набора', `«${t.title}»: в таблице «${row.priority}», допустимо P0/P1/P2`);
    }
  }

  // Строки без ID — это не ошибка: так редактор добавляет свою тему, и
  // ближайший прогон заведёт ей slug. Пустой темы в таблице быть не может
  // (readWork такие строки пропускает), поэтому проверять нечего.
  const known = new Set(live.map((t) => t.slug));
  const orphans = (pull.items || []).filter((i) => i.slug && !known.has(i.slug));
  for (const o of orphans) {
    add('лишняя строка', `«${o.topic}» (${o.slug}) есть в таблице, но не в состоянии цикла`);
  }

  return problems;
}

/* ------------------------------------------------------------------ CLI */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : { plan: [] };

  let pull;
  const pullPath = arg('pull');
  if (pullPath) {
    if (!existsSync(pullPath)) { console.error(`✖ нет файла ${pullPath}`); process.exit(1); }
    pull = JSON.parse(readFileSync(pullPath, 'utf8'));
  } else {
    const sheetId = arg('sheet-id') || state.drive?.sheetId;
    if (!sheetId) { console.error('✖ нужен --sheet-id или --pull <файл>'); process.exit(1); }
    const args = ['pull', '--sheet-id', sheetId];
    const tab = arg('tab');
    if (tab) args.push('--tab', tab);
    pull = JSON.parse(execFileSync('node', [join(__dir, 'drive-sync.mjs'), ...args], { encoding: 'utf8' }));
  }

  const problems = compare(state, pull);
  if (!problems.length) {
    console.log(`✓ Таблица и состояние сходятся: ${(pull.items || []).length} строк, вкладка «${pull.tab}»`);
    process.exit(0);
  }
  console.error(`✖ Расхождений: ${problems.length}\n`);
  for (const p of problems) console.error(`  [${p.kind}] ${p.detail}`);
  console.error('\nЧинить с колонок: если разъехалась раскладка, остальное — следствие.');
  process.exit(1);
}
