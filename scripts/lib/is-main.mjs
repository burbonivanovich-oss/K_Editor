/**
 * «Этот модуль запущен как команда, а не импортирован?»
 *
 * Общий хелпер, а не строка в каждом скрипте, по конкретной причине.
 * Девять скриптов собирали URL руками — `import.meta.url === \`file://${process.argv[1]}\``.
 * Это верно только для путей без символов, которые URL обязан кодировать.
 * Рабочий каталог редакции лежит в «Claude Local»: пробел в пути даёт
 * `file:///.../Claude%20Local/...` слева и `file:///.../Claude Local/...`
 * справа. Условие ложно всегда — и `node scripts/gates.mjs` завершался
 * кодом 0, не выполнив ни одной проверки. Пустой вывод выглядел как
 * «нарушений нет»: no-op были локальные gates, AI-гейт внутри release,
 * проверка анализа, coverage, update-doc и редакторский журнал.
 *
 * Сравниваем пути, а не URL: `fileURLToPath` снимает процентное
 * кодирование, `resolve` разворачивает `argv[1]`, который node передаёт
 * как есть — относительным, если команду запустили относительным путём.
 *
 * Вариант «argv[1].endsWith('имя.mjs')», который тоже встречался, здесь
 * не годится: он срабатывает на любом одноимённом файле из другого
 * каталога.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

/** Путь без символических ссылок; если файла нет — исходный путь. */
const real = (p) => { try { return realpathSync(p); } catch { return p; } };

/**
 * @param {string} moduleUrl — всегда `import.meta.url` вызывающего модуля.
 * @returns {boolean}
 */
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return real(fileURLToPath(moduleUrl)) === real(resolve(entry));
}
