#!/usr/bin/env node
/**
 * Память об отказах редактора по темам.
 *
 * Без неё отклонённая тема всплывает в следующем же прогоне бэклога:
 * Wordstat не знает, что её уже смотрели и сказали «нет». Редактор тратит
 * время на один и тот же отказ раз за разом.
 *
 * Причины отказа делятся на две категории, и ведут себя они по-разному:
 *
 *   core   — «категорически не наше ядро». Тема глушится на 90 дней
 *            вместе с похожими. Порог согласован с окном
 *            /monitor-competitors → competitor-trends.md.
 *   angle  — «не можем подать под таким углом». Глушится сама
 *            формулировка, но не тема: генератор обязан в том же прогоне
 *            предложить другой ракурс. Окно короткое — 30 дней.
 *
 * Запуск:
 *   node scripts/topics/suppressions.mjs list
 *   node scripts/topics/suppressions.mjs check "<тема>"     # 0 чисто, 1 заглушена, 2 пограничная
 *   node scripts/topics/suppressions.mjs add "<тема>" --reason core --cluster kkt --note "..."
 *   node scripts/topics/suppressions.mjs prune
 *
 * Файл src/data/topic-suppressions.json руками не редактируется.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Путь переопределяется в тестах: проверять поведение на живом файле
// отказов — значит зависеть от того, что редакция сняла на этой неделе.
const FILE = process.env.SUPPRESSIONS_PATH || join(ROOT, "src", "data", "topic-suppressions.json");

const WINDOWS = { core: 90, angle: 30 };

// Подобрано по живым примерам: перефразировка той же темы даёт ~0.4,
// разные темы одного кластера («маркировка обуви» против «маркировки
// молочки») — около 0.17. Выше порог — отказы обходятся синонимами,
// ниже — глушатся соседние темы кластера.
const SIMILARITY_THRESHOLD = 0.4;
/* Нижняя граница «пограничной зоны».
 *
 * Между 0.25 и 0.4 счётчик слов не может ответить честно. «Интернет-
 * эквайринг для онлайн-магазина: как выбрать банк и тариф» заглушён, а
 * «интернет-эквайринг» проходит как другая тема: общих слов мало,
 * длины разные, а для человека это одно и то же. Раньше такие пары
 * молча проходили дальше, и редактор отказывал второй раз.
 *
 * Теперь они не проходят и не глушатся, а помечаются: решение по ним
 * принимает сессия, читая обе формулировки. Скрипт сужает, ИИ судит. */
const BORDERLINE_THRESHOLD = 0.25;

/** Одна тема, записанная по-разному, — это одна тема. */
export function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'(),.:;!?—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set([
  "и", "в", "во", "на", "с", "со", "для", "по", "от", "до", "из", "за", "к",
  "о", "об", "у", "при", "как", "что", "это", "или", "а", "но", "же", "ли",
  "год", "года", "году", "новый", "новые", "новая",
]);

/**
 * Обрезка до основы. Русская морфология иначе обходит память об отказах
 * простой сменой падежа: «молочной» и «молочки» — разные строки, но одна
 * и та же тема. Пять символов достаточно, чтобы склеить словоформы и не
 * склеить разные слова («маркировка» и «маркетплейс» дают разные основы).
 */
function stem(word) {
  return word.length > 5 ? word.slice(0, 5) : word;
}

function tokens(text) {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map(stem),
  );
}

/**
 * Похожесть по общим значимым словам (Жаккар). Нужна, чтобы отказ
 * «категорически не наше» глушил не только дословную формулировку:
 * Wordstat на следующей неделе принесёт ту же тему другими словами.
 */
export function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const w of ta) if (tb.has(w)) common++;
  return common / (ta.size + tb.size - common);
}

export function load() {
  if (!existsSync(FILE)) return { schemaVersion: 1, suppressions: [] };
  return JSON.parse(readFileSync(FILE, "utf8"));
}

function save(data) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n");
}

const today = () => new Date().toISOString().slice(0, 10);

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Активные — те, у кого срок ещё не вышел. */
export function active(data = load(), onDate = today()) {
  return data.suppressions.filter((s) => s.suppressUntil > onDate);
}

/**
 * Заглушена ли тема. Для core сравниваем по похожести, для angle — только
 * точное совпадение формулировки: угол отклонили, а не саму тему.
 */
export function isSuppressed(topic, data = load(), onDate = today()) {
  const norm = normalize(topic);
  for (const s of active(data, onDate)) {
    if (s.reason === "core") {
      if (similarity(topic, s.topic) >= (s.threshold ?? SIMILARITY_THRESHOLD)) return s;
    } else if (normalize(s.topic) === norm) {
      return s;
    }
  }
  return null;
}

/**
 * Пограничные пары: похоже, но недостаточно, чтобы глушить автоматически.
 *
 * Возвращает список { topic, suppressed, score } — по каждой сессия
 * решает сама: та же тема или другая. Заглушённые сюда не попадают, они
 * уже отсеяны isSuppressed.
 */
export function borderline(topic, data = load(), onDate = today()) {
  if (isSuppressed(topic, data, onDate)) return [];
  const out = [];
  for (const s of active(data, onDate)) {
    if (s.reason !== "core") continue;
    const score = similarity(topic, s.topic);
    const upper = s.threshold ?? SIMILARITY_THRESHOLD;
    if (score >= BORDERLINE_THRESHOLD && score < upper) {
      out.push({ topic, suppressed: s.topic, score: Number(score.toFixed(2)), note: s.note || "" });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export function add({ topic, reason, cluster, note, onDate = today() }) {
  if (!topic) throw new Error("нужна тема");
  if (!WINDOWS[reason]) {
    throw new Error(`reason должен быть core или angle, получено: ${reason}`);
  }
  const data = load();
  const suppressUntil = addDays(onDate, WINDOWS[reason]);

  // Повторный отказ по той же теме продлевает срок, а не плодит записи.
  const existing = data.suppressions.find(
    (s) => normalize(s.topic) === normalize(topic) && s.reason === reason,
  );
  if (existing) {
    existing.suppressUntil = suppressUntil;
    existing.note = note || existing.note;
    existing.hits = (existing.hits ?? 1) + 1;
  } else {
    data.suppressions.push({
      topic,
      reason,
      cluster: cluster || null,
      note: note || null,
      declinedAt: onDate,
      suppressUntil,
      hits: 1,
    });
  }
  save(data);
  return suppressUntil;
}

/* ─────────────────────────────────────────────────────────────── CLI ── */

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}

const isMain = process.argv[1] && process.argv[1].endsWith("suppressions.mjs");
if (isMain) {
  const cmd = process.argv[2];
  const positional = process.argv[3];

  if (cmd === "list") {
    const data = load();
    const act = active(data);
    console.log(`Заглушено тем: ${act.length} (всего записей: ${data.suppressions.length})`);
    for (const s of act.sort((a, b) => a.suppressUntil.localeCompare(b.suppressUntil))) {
      const label = s.reason === "core" ? "не наше ядро" : "не тот угол";
      console.log(`  до ${s.suppressUntil}  [${label}]  ${s.topic}`);
      if (s.note) console.log(`      ${s.note}`);
    }
  } else if (cmd === "check") {
    if (!positional) {
      console.error("нужна тема: check \"<тема>\"");
      process.exit(2);
    }
    const hit = isSuppressed(positional);
    if (hit) {
      console.log(`ЗАГЛУШЕНА до ${hit.suppressUntil} — ${hit.reason === "core" ? "не наше ядро" : "не тот угол"}`);
      console.log(`  совпало с: ${hit.topic}`);
      process.exit(1);
    }
    const near = borderline(positional);
    if (near.length) {
      console.log("ПОГРАНИЧНО — решает человек или сессия, автоматически не глушим:");
      for (const b of near) {
        console.log(`  ${b.score}  похоже на снятую: ${b.suppressed}`);
        if (b.note) console.log(`        причина отказа: ${b.note}`);
      }
      console.log("\nТа же тема — снять и записать отказ. Другая — брать в работу.");
      process.exit(2);
    }
    console.log("Не заглушена.");
  } else if (cmd === "add") {
    if (!positional) {
      console.error('нужна тема: add "<тема>" --reason core|angle');
      process.exit(2);
    }
    const until = add({
      topic: positional,
      reason: argOf("reason"),
      cluster: argOf("cluster"),
      note: argOf("note"),
    });
    console.log(`✓ заглушено до ${until}`);
  } else if (cmd === "prune") {
    // Истёкшие записи не удаляем: по ним видно, что тему уже приносили и
    // отклоняли — это полезно и после снятия блокировки. Команда только
    // показывает, что срок вышел.
    const data = load();
    const expired = data.suppressions.filter((s) => s.suppressUntil <= today());
    console.log(`Истёкших записей: ${expired.length} (хранятся как история отказов)`);
    for (const s of expired) console.log(`  ${s.suppressUntil}  ${s.topic}`);
  } else {
    console.log("Команды: list | check \"<тема>\" | add \"<тема>\" --reason core|angle | prune");
    process.exit(2);
  }
}
