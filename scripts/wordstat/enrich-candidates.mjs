#!/usr/bin/env node
// Достаёт помесячную динамику для кандидатов из свежей выгрузки.
//
// Зачем: рост темы обычно считают diff-ом двух недельных снапшотов, но
// второй снапшот появляется только через неделю, а topRequests не умеет
// отдавать срез задним числом — у него нет параметра даты. Зато /dynamics
// отдаёт 12 месяцев истории на любую фразу прямо сейчас. Так рост
// считается в первый же день и по более длинному окну, чем неделя.
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
//
// Запись: src/data/wordstat/candidate-dynamics.json

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isInformational } from "./relevance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DISC_DIR = join(ROOT, "src", "data", "wordstat", "discoveries");
const OUT = join(ROOT, "src", "data", "wordstat", "candidate-dynamics.json");

const API_BASE = "https://searchapi.api.cloud.yandex.net/v2/wordstat";
const API_KEY = process.env.YC_API_KEY || "";
const FOLDER_ID = process.env.YC_FOLDER_ID || "";
const DRY_RUN = process.env.DRY_RUN === "1";
const TOP_N = parseInt(process.env.TOP_N || "120", 10);
const MIN_COUNT = parseInt(process.env.MIN_COUNT || "500", 10);
const MIN_WORDS = parseInt(process.env.MIN_WORDS || "3", 10);
const REGION_ID = String(process.env.REGION_ID || "225");
const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || "200", 10);
// Через сколько дней измерение считается протухшим. Помесячная динамика
// меняется раз в месяц, чаще мерить нечего.
const REMEASURE_DAYS = parseInt(process.env.REMEASURE_DAYS || "30", 10);

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
        const key = p.phrase.toLowerCase().trim();
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

// Правый край периода — последний день прошлого месяца: текущий не
// закончился, его частотность неполная. Требование API: ровно последний
// день месяца, иначе InvalidArgument.
function rfc3339(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
function periodTo() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(0);
  return rfc3339(d);
}
function periodFrom(months) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMonth(d.getUTCMonth() - months);
  return rfc3339(d);
}

async function getDynamics(phrase) {
  const res = await fetch(`${API_BASE}/dynamics`, {
    method: "POST",
    headers: {
      "Authorization": `Api-Key ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      folderId: FOLDER_ID,
      phrase,
      period: "PERIOD_MONTHLY",
      fromDate: periodFrom(12),
      toDate: periodTo(),
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
  return (Array.isArray(data?.results) ? data.results : []).map((d) => ({
    date: typeof d.date === "string" ? d.date.slice(0, 7) : String(d.date),
    count: parseInt(d.count, 10) || 0,
  }));
}

/** Рост последних трёх месяцев к трём предыдущим. */
function growth(history) {
  if (history.length < 6) return null;
  const recent = history.slice(-3).reduce((s, p) => s + p.count, 0) / 3;
  const prev = history.slice(-6, -3).reduce((s, p) => s + p.count, 0) / 3;
  if (prev === 0) return recent > 0 ? { ratio: Infinity, recent, prev } : null;
  return { ratio: recent / prev, recent, prev };
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
  for (const p of all) {
    const seen = known.get(p.phrase.toLowerCase().trim());
    if (!seen) fresh.push(p);
    else if (ageDays(seen.measuredAt) >= REMEASURE_DAYS) stale.push({ ...p, prevMeasuredAt: seen.measuredAt });
  }
  stale.sort((a, b) => String(a.prevMeasuredAt).localeCompare(String(b.prevMeasuredAt)));

  const plan = [...fresh, ...stale].slice(0, TOP_N);

  console.log(
    `enrich: ${all.length} тематических фраз от ${MIN_COUNT} показов; ` +
      `уже измерено ${known.size}, не измерено ${fresh.length}, ` +
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
      out.push({
        ...p,
        history,
        growth: g ? Number(g.ratio.toFixed(2)) : null,
        recent: g?.recent ?? null,
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

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        period: { from: periodFrom(12), to: periodTo() },
        coverage: { measured: merged.size, pool: all.length },
        items: [...merged.values()],
      },
      null,
      2,
    ) + "\n",
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

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
