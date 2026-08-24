#!/usr/bin/env node
/**
 * Содержательная ли дельта состояния цикла — или только отметки времени.
 *
 * Рутина `watch-sheet` опрашивает таблицу 11 раз в будний день и каждый
 * раз коммитила результат: `git diff --cached --quiet || git commit`.
 * Условие выполнялось всегда, потому что каждый прогон двигает
 * `updatedAt` и прокручивает кольцевой журнал `log`, даже когда решений
 * редактора не было.
 *
 * Замер 24.08.2026: 56 записей `apply-decisions` за 18–22 августа, из них
 * «0 снято, 0 „пишем сами“, 0 правок» — **все 56**. В истории это 81
 * коммит «watch-sheet: решения редактора применены», содержимое каждого —
 * сдвиг таймстампа. Файл на 26 КБ занял 4,7 МБ git-истории, а осмысленные
 * коммиты утонули: по журналу изменений стало нельзя понять, что
 * происходило.
 *
 * Что считается несодержательным (и только это):
 *
 *   updatedAt — время прогона, а не событие;
 *   log       — кольцевой журнал прогонов.
 *
 * `lastNudgeAt` намеренно НЕ в списке. Он выглядит такой же отметкой
 * времени, но по нему `nudge-editors.mjs` решает, отправлять ли
 * напоминание сегодня. Не закоммитить его — значит потерять дедупликацию
 * и слать редакции напоминание каждый прогон: 11 писем в день вместо
 * одного. Отметка времени, от которой зависит поведение, — это
 * состояние, а не шум.
 *
 * Запуск:
 *   node scripts/cycle-churn.mjs <путь>              # сравнить с HEAD
 *   node scripts/cycle-churn.mjs --before a --after b
 *
 * Печатает `significant` или `churn`. Ненулевой код — ошибка разбора,
 * а не вердикт: рутина обязана в этом случае упасть, а не «на всякий
 * случай не коммитить».
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isMain } from './lib/is-main.mjs';

/** Поля, которые двигает сам прогон, а не событие в редакции. */
export const CHURN_FIELDS = ['updatedAt', 'log'];

const strip = (state) => {
  const copy = { ...(state ?? {}) };
  for (const k of CHURN_FIELDS) delete copy[k];
  return copy;
};

/**
 * Отличаются ли два состояния чем-нибудь, кроме отметок прогона.
 *
 * Ключи сортируются перед сравнением: переставленные поля — это
 * переформатирование JSON, а не изменение состояния.
 *
 * @returns {boolean} true — есть содержательная разница
 */
export function isSignificant(before, after) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
    }
    return v;
  };
  return JSON.stringify(canon(strip(before))) !== JSON.stringify(canon(strip(after)));
}

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? null : process.argv[i + 1];
};

if (isMain(import.meta.url)) {
  const parse = (text, what) => {
    try {
      return JSON.parse(text);
    } catch (e) {
      console.error(`✖ ${what} не разбирается как JSON: ${e.message}`);
      process.exit(1);
    }
  };

  const beforePath = arg('before');
  const afterPath = arg('after');
  let before, after;

  if (beforePath || afterPath) {
    if (!beforePath || !afterPath) {
      console.error('✖ нужны оба: --before <файл> --after <файл>');
      process.exit(1);
    }
    before = parse(readFileSync(beforePath, 'utf8'), beforePath);
    after = parse(readFileSync(afterPath, 'utf8'), afterPath);
  } else {
    const path = process.argv[2];
    if (!path || path.startsWith('--')) {
      console.error('Использование: node scripts/cycle-churn.mjs <путь> | --before <a> --after <b>');
      process.exit(1);
    }
    after = parse(readFileSync(path, 'utf8'), path);
    /* Файла может не быть в HEAD — первый коммит состояния. Это
     * содержательная дельта, а не churn. */
    let head = null;
    try {
      head = execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8' });
    } catch {
      console.log('significant');
      process.exit(0);
    }
    before = parse(head, `HEAD:${path}`);
  }

  console.log(isSignificant(before, after) ? 'significant' : 'churn');
}
