/**
 * Запись отчёта-артефакта без ложных изменений.
 *
 * Аудиты складывают результат в JSON рядом с данными и ставят в него
 * отметку времени. Из-за отметки файл менялся при каждом запуске, даже
 * когда в отчёте не поменялось ни одной цифры: посмотрел граф ссылок —
 * получил «изменён файл» в рабочем дереве.
 *
 * Мешает это в первую очередь агенту. Он запускает аудит, чтобы что-то
 * проверить, и дерево становится грязным на ровном месте: приходится
 * решать, коммитить это или откатывать, а в CI стоит отдельная проверка
 * «тесты не меняют рабочее дерево», которая на такие записи и ругается.
 * Человеку это тоже мешает — в diff'е ревью видит строку с датой и
 * ничего больше.
 *
 * Поэтому сравниваем содержимое без отметки времени: совпало — файл не
 * трогаем вовсе, отметка остаётся от прошлого настоящего изменения.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @param {string} path      куда писать
 * @param {object} report    полный объект отчёта, включая отметку времени
 * @param {string} stampKey  ключ отметки времени, который не считается изменением
 * @returns {boolean}        true, если файл действительно перезаписан
 */
export function writeReportIfChanged(path, report, stampKey = 'generatedAt') {
  const next = JSON.stringify(report, null, 2) + '\n';

  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, 'utf8'));
      const strip = (o) => {
        const { [stampKey]: _ignored, ...rest } = o;
        return JSON.stringify(rest);
      };
      if (strip(prev) === strip(report)) return false;
    } catch {
      /* повреждённый прошлый отчёт — просто перезаписываем */
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return true;
}
