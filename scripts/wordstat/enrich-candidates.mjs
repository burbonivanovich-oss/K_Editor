#!/usr/bin/env node
// Достаёт недельную динамику для кандидатов из свежей выгрузки.
//
// Зачем: рост темы обычно считают diff-ом двух недельных снапшотов, но
// второй снапшот появляется только через неделю, а topRequests не умеет
// отдавать срез задним числом — у него нет параметра даты. Зато /dynamics
// отдаёт историю на любую фразу прямо сейчас. Так рост виден в первый же
// день, а не через неделю ожидания.
//
// Гранулярность — недели, не месяцы. Помесячное сравнение (три последних
// месяца против трёх предыдущих) сглаживает ровно то, что нужно поймать:
// тему, которая тронулась две-три недели назад, тонет в квартальном
// среднем и всплывает как «рост» только когда уже полмесяца как растёт.
// PERIOD_WEEKLY даёт то же окно наблюдения — 2-3 недели, — какое нужно
// редактору для «почему именно сейчас».
//
// Отбор: из выгрузки берутся информационные фразы (навигационные и
// брендовые отсеиваются), верхние по частотности идут в API.
//
// Окружение:
//   YC_API_KEY, YC_FOLDER_ID — как у fetch.mjs
//   DRY_RUN=1                — показать отобранные фразы, без запросов
//   TOP_N=120                — сколько фраз отправить в /dynamics (= квоты)
//   MIN_COUNT=500            — нижний порог частотности фразы
//   MIN_WORDS=3              — минимум слов во фразе
//   RECENT_WEEKS=3           — короткое окно: последние N недель против
//                              предыдущих N (что тронулось только сейчас)
//   TREND_WEEKS=16            — длинное окно: последние N недель против
//                              предыдущих N (устойчивый структурный рост,
//                              который короткое окно смазывает шумом)
//
// Считаем оба разреза из одной истории — это по-прежнему 1 квота на
// фразу, глубина запроса просто взята с запасом на длинное окно.
//
// Запись: src/data/wordstat/candidate-dynamics.json

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isInformational, dedupeKey } from "./relevance.mjs";
import { isMain } from "../lib/is-main.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DISC_DIR = join(ROOT, "src", "data", "wordstat", "discoveries");
const OUT = join(ROOT, "src", "data", "wordstat", "candidate-dynamics.json");

/**
 * Кеш динамики — по одной фразе на строку.
 *
 * Файл писался с отступом в два пробела и весил 6,3 МБ при 2128 фразах;
 * коммитится он еженедельно, и к 24.08.2026 занял 16 МБ git-истории —
 * больше, чем весь остальной репозиторий вместе взятый. Это не текст,
 * который читают глазами: 2128 записей с недельными рядами.
 *
 * Компромисс вместо голого `JSON.stringify`: шапка (`generatedAt`,
 * `period`, `coverage`) остаётся читаемой, а `items` идут по строке на
 * фразу. Размер падает на 46 %, и заодно чинится дифф — изменившаяся
 * фраза становится одной изменённой строкой вместо десятка, а git лучше
 * жмёт такие дельты.
 *
 * Удалять файл из git нельзя: `REMEASURE_DAYS` и `cacheVersion` делают
 * его кешем платной квоты Wordstat. Без него каждый прогон перемерял бы
 * всё заново.
 */
export function serializeDynamics({ items = [], ...meta }) {
  const head = JSON.stringify(meta, null, 2).replace(/\n\}$/, "");
  if (!items.length) return `${head},\n  "items": []\n}\n`;
  const lines = items.map((it) => `    ${JSON.stringify(it)}`).join(",\n");
  return `${head},\n  "items": [\n${lines}\n  ]\n}\n`;
}

const API_BASE = "https://searchapi.api.cloud.yandex.net/v2/wordstat";
const API_KEY = process.env.YC_API_KEY || "";
const FOLDER_ID = process.env.YC_FOLDER_ID || "";
const DRY_RUN = process.env.DRY_RUN === "1";
const TOP_N = parseInt(process.env.TOP_N || "120", 10);
const MIN_COUNT = parseInt(process.env.MIN_COUNT || "500", 10);
const MIN_WORDS = parseInt(process.env.MIN_WORDS || "3", 10);
const REGION_ID = String(process.env.REGION_ID || "225");
const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || "200", 10);
const RECENT_WEEKS = parseInt(process.env.RECENT_WEEKS || "3", 10);
const TREND_WEEKS = parseInt(process.env.TREND_WEEKS || "16", 10);
// Через сколько дней измерение считается протухшим. Недельная динамика
// сдвигается каждую неделю — семи дней вполне достаточно, чтобы не мерить
// то же самое чаще, чем оно вообще может измениться.
const REMEASURE_DAYS = parseInt(process.env.REMEASURE_DAYS || "7", 10);

// Версия формата данных. Меняли period с месяцев на недели — старые записи
// хранят помесячную историю и растянутый на квартал growth; подмешать их к
// новым как есть значит показать в одном бэклоге «+192% за квартал» рядом
// с «+80% за 3 недели», где числа не сравнимы. Штамп в каждой записи не
// даёт таким записям пройти как «уже измеренные»: несовпадение версии
// приравнивается к отсутствию измерения, и следующий прогон их перемерит.
//
// Версия 3: история в записи стала глубже (под TREND_WEEKS), а вместе с
// growth появился growthTrend — версия 2 хранит только короткое окно и
// не даёт посчитать длинное задним числом без нового запроса к API.
const CACHE_VERSION = 3;

const ageDays = (iso) =>
  iso ? (Date.now() - Date.parse(iso)) / 86400000 : Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Фразы из последней датированной выгрузки по всем namespace. */
function collectPhrases() {
  const seen = new Map();
  if (!existsSync(DISC_DIR)) return [];

  const fromDir = (base, ns) => {
    const dated = readdirSync(base)
      .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))
      .sort();
    if (!dated.length) return;
    const dir = join(base, dated[dated.length - 1]);

    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      let payload;
      try {
        payload = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch {
        continue;
      }
      for (const p of payload.phrases ?? []) {
        if (p.count < MIN_COUNT || !isInformational(p.phrase, MIN_WORDS)) continue;
        // Схлопываем переформулировки одного запроса: иначе «может ли
        // самозанятый», «могут ли самозанятые» и «можно ли самозанятый»
        // съедят три квоты и три места в бэклоге вместо одного.
        const key = dedupeKey(p.phrase);
        // Один и тот же запрос приходит от разных сидов — оставляем
        // вариант с большей частотностью и первым встреченным кластером.
        const prev = seen.get(key);
        if (!prev || p.count > prev.count) {
          seen.set(key, {
            phrase: p.phrase,
            count: p.count,
            cluster: payload.cluster || prev?.cluster || null,
            seed: payload.seed,
            ns,
          });
        }
      }
    }
  };

  fromDir(DISC_DIR, null);
  for (const name of readdirSync(DISC_DIR)) {
    if (name === "diffs" || /^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    try {
      readdirSync(join(DISC_DIR, name));
      fromDir(join(DISC_DIR, name), name);
    } catch {
      /* не каталог */
    }
  }

  return [...seen.values()].sort((a, b) => b.count - a.count);
}

function rfc3339(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Неделя в Wordstat — понедельник–воскресенье (совпадает с ISO 8601).
// Правый край периода — последнее полностью закрытое воскресенье: текущая
// неделя не закончилась, её частотность неполная. По аналогии с
// PERIOD_MONTHLY, где toDate обязан быть последним днём месяца, для
// PERIOD_WEEKLY он обязан быть воскресеньем — иначе тот же InvalidArgument.
function lastClosedSunday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay(); // 0 = воскресенье
  // Сегодняшняя неделя ещё не закрыта, даже если сегодня воскресенье —
  // день не закончился. Всегда уходим минимум на прошлую неделю.
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 7 : day));
  return d;
}

// Левый край — понедельник N недель назад от toDate. API не документирует
// жёсткое требование к fromDate (в отличие от toDate), но выравниваем на
// понедельник для чистоты интервала — иначе первая неделя истории окажется
// обрублена с середины.
function weeksBeforeMonday(toDate, weeks) {
  const d = new Date(toDate);
  d.setUTCDate(d.getUTCDate() - weeks * 7 + 1);
  return d;
}

// Глубина истории должна перекрывать оба разреза разом: длинное окно
// сравнивает TREND_WEEKS против предыдущих TREND_WEEKS, значит нужно
// 2×TREND_WEEKS точек. Именно ради этого история и берётся с запасом —
// короткое окно (RECENT_WEEKS) в неё укладывается тем более.
const HISTORY_WEEKS = Math.max(TREND_WEEKS * 2, RECENT_WEEKS * 4, 12);

async function getDynamics(phrase) {
  const toDate = lastClosedSunday();
  const fromDate = weeksBeforeMonday(toDate, HISTORY_WEEKS);

  const res = await fetch(`${API_BASE}/dynamics`, {
    method: "POST",
    headers: {
      "Authorization": `Api-Key ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      folderId: FOLDER_ID,
      phrase,
      period: "PERIOD_WEEKLY",
      fromDate: rfc3339(fromDate),
      toDate: rfc3339(toDate),
      regions: [REGION_ID],
    }),
    signal: AbortSignal.timeout(30000),
  });
  const txt = await res.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    /* не-JSON — ниже как ошибка */
  }
  const grpcCode = data && typeof data.code === "number" ? data.code : null;
  if (!res.ok || grpcCode !== null) {
    throw new Error(`code ${grpcCode ?? res.status}: ${(data && data.message) || txt.slice(0, 160)}`);
  }
  // Дата недели не режем срезом (как резался месяц до "YYYY-MM") — формат
  // недельной точки не документирован так же чётко, и обрезка вслепую
  // рискует обрубить его неверно. Берём как есть, на growth() это не влияет.
  return (Array.isArray(data?.results) ? data.results : []).map((d) => ({
    date: typeof d.date === "string" ? d.date : String(d.date),
    count: parseInt(d.count, 10) || 0,
  }));
}

/** Рост последних N недель к предыдущим N — общая механика для обоих окон. */
function growthOver(history, weeks) {
  if (history.length < weeks * 2) return null;
  const recent = history.slice(-weeks).reduce((s, p) => s + p.count, 0) / weeks;
  const prev = history.slice(-weeks * 2, -weeks).reduce((s, p) => s + p.count, 0) / weeks;
  if (prev === 0) return recent > 0 ? { ratio: Infinity, recent, prev } : null;
  return { ratio: recent / prev, recent, prev };
}

// Короткое окно — «тронулось прямо сейчас»: разослали письмо ФНС, вышло
// разъяснение, наступил сезон отчётности. Длинное — «растёт весь квартал
// подряд»: то, что короткое окно смазывает шумом, потому что неделя-две
// спада внутри устойчивого роста на короткой дистанции выглядит как
// ничего не происходит. Тема с 5% роста в месяц три месяца подряд не даст
// ни одного недельного скачка — без длинного окна она не попадёт в
// бэклог никогда, хотя это ровно тот случай, где отставание от спроса
// накопилось дольше всего.
function growth(history) {
  return growthOver(history, RECENT_WEEKS);
}
function growthTrend(history) {
  return growthOver(history, TREND_WEEKS);
}

async function main() {
  if (!DRY_RUN && (!API_KEY || !FOLDER_ID)) {
    throw new Error("YC_API_KEY и YC_FOLDER_ID обязательны (или DRY_RUN=1).");
  }

  const all = collectPhrases();

  // Измерения накапливаются между прогонами. Тематических фраз тысячи, а
  // квота часовая: мерить каждый раз одни и те же верхние 120 значит
  // никогда не увидеть остальные. Поэтому берём сначала неизмеренные, а
  // из измеренных — самые давние.
  const prev = existsSync(OUT)
    ? (() => { try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return null; } })()
    : null;
  const known = new Map((prev?.items ?? []).map((it) => [it.phrase.toLowerCase().trim(), it]));

  const fresh = [];
  const stale = [];
  let outdated = 0;
  for (const p of all) {
    const seen = known.get(p.phrase.toLowerCase().trim());
    if (!seen || seen.cacheVersion !== CACHE_VERSION) {
      // Нет записи или она из старого формата (месяцы вместо недель) —
      // в обоих случаях фраза для текущей схемы не измерена ни разу.
      if (seen) outdated++;
      fresh.push(p);
    } else if (ageDays(seen.measuredAt) >= REMEASURE_DAYS) {
      stale.push({ ...p, prevMeasuredAt: seen.measuredAt });
    }
  }
  stale.sort((a, b) => String(a.prevMeasuredAt).localeCompare(String(b.prevMeasuredAt)));

  const plan = [...fresh, ...stale].slice(0, TOP_N);

  if (outdated) {
    console.log(
      `enrich: ${outdated} записей из прежнего формата (по месяцам) — ` +
        `считаю неизмеренными, буду перемерять по неделям.`,
    );
  }
  const validMeasured = known.size - outdated;
  console.log(
    `enrich: ${all.length} тематических фраз от ${MIN_COUNT} показов; ` +
      `в текущем формате измерено ${validMeasured}, не измерено ${fresh.length}, ` +
      `пора перемерить ${stale.length}`,
  );
  console.log(
    `        в /dynamics идут ${plan.length} (= столько же квот), ` +
      `покрытие станет ${Math.min(known.size + fresh.slice(0, TOP_N).length, all.length)}/${all.length}`,
  );

  if (DRY_RUN) {
    console.log("DRY_RUN=1 — запросов нет. Первые 15:");
    for (const p of plan.slice(0, 15)) {
      console.log(`  ${String(p.count).padStart(8)}  [${p.cluster ?? "—"}]  ${p.phrase}`);
    }
    return;
  }

  const out = [];
  const failures = new Map();
  for (const [i, p] of plan.entries()) {
    try {
      const history = await getDynamics(p.phrase);
      const g = growth(history);
      const t = growthTrend(history);
      out.push({
        ...p,
        history,
        growth: g ? Number(g.ratio.toFixed(2)) : null,
        recent: g?.recent ?? null,
        windowWeeks: RECENT_WEEKS,
        growthTrend: t ? Number(t.ratio.toFixed(2)) : null,
        recentTrend: t?.recent ?? null,
        trendWeeks: TREND_WEEKS,
        cacheVersion: CACHE_VERSION,
        measuredAt: new Date().toISOString(),
      });
      await sleep(REQUEST_DELAY_MS);
    } catch (err) {
      failures.set(err.message, (failures.get(err.message) || 0) + 1);
    }
    if ((i + 1) % 25 === 0) console.log(`  …${i + 1}/${plan.length}`);
  }

  if (failures.size) {
    console.error(`\nenrich: не удалось ${[...failures.values()].reduce((a, b) => a + b, 0)} запросов:`);
    for (const [msg, n] of [...failures].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.error(`  ${String(n).padStart(4)} × ${msg}`);
    }
  }

  // Мержим, а не перезаписываем: старые измерения — это накопленное
  // покрытие, ради которого ротация и затевалась.
  const merged = new Map(known);
  for (const it of out) merged.set(it.phrase.toLowerCase().trim(), it);

  const periodTo = lastClosedSunday();
  const periodFrom = weeksBeforeMonday(periodTo, HISTORY_WEEKS);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    serializeDynamics({
      generatedAt: new Date().toISOString(),
      period: { from: rfc3339(periodFrom), to: rfc3339(periodTo) },
      coverage: { measured: merged.size, pool: all.length },
      items: [...merged.values()],
    }),
  );
  console.log(
    `\n✓ измерено за прогон: ${out.length}; всего в базе ${merged.size} из ${all.length} ` +
      `→ ${OUT.replace(ROOT + "/", "")}`,
  );

  if (plan.length > 0 && out.length === 0) {
    console.error("enrich: ни одной фразы не обогащено — данные не записаны как валидные.");
    process.exitCode = 1;
  }
}

/* Запуск только как команда: без guard любой импорт (тест, соседний
 * скрипт) немедленно требовал YC_API_KEY и падал. Правило проекта —
 * docs/tools.md, «lib/is-main.mjs». */
if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
