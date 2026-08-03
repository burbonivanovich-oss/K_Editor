#!/usr/bin/env node
// Запрашивает Wordstat (Yandex Cloud Search API v2) для приоритетных ключей
// и мерджит в кеш.
//
// ВАЖНО: старый api.wordstat.yandex.net/v1 с OAuth-токеном отключён. Wordstat
// теперь живёт внутри Yandex Search API (gRPC + protobuf, REST-обёртка).
// Авторизация — Api-Key сервисного аккаунта с ролью search-api.webSearch.user;
// в каждом теле запроса обязателен folderId (ID каталога, не облака).
//
// Окружение:
//   YC_API_KEY           — Api-Key сервисного аккаунта (обязательно, кроме DRY_RUN)
//   YC_FOLDER_ID         — ID каталога Yandex Cloud (b1ghs…, обязательно, кроме DRY_RUN)
//   DRY_RUN=1            — печатает план и выходит, без сетевых запросов
//   MAX_QUOTA=500        — потолок по квотам за прогон (1 запрос dynamics = 1 квота)
//   TOP_REQUESTS_LIMIT=50 — сколько самых приоритетных ключей также получают topRequests
//   REGION_ID=225        — Yandex region ID (225 = Россия)
//   FRESH_DAYS=7         — ключ считается актуальным, если обновлён не позднее N дней назад
//   REQUEST_DELAY_MS=200 — пауза между запросами
//
// Чтение:  src/data/wordstat/.candidates.json (генерит extract-keys.mjs)
//          src/data/wordstat/keys.json (если существует)
// Запись:  src/data/wordstat/keys.json
//          src/data/wordstat/snapshots/YYYY-MM-DD.json

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIR = join(ROOT, "src", "data", "wordstat");
const CANDIDATES = join(DATA_DIR, ".candidates.json");
const KEYS_FILE = join(DATA_DIR, "keys.json");
const SNAPSHOTS_DIR = join(DATA_DIR, "snapshots");

const API_BASE = "https://searchapi.api.cloud.yandex.net/v2/wordstat";
const API_KEY = process.env.YC_API_KEY || "";
const FOLDER_ID = process.env.YC_FOLDER_ID || "";
const DRY_RUN = process.env.DRY_RUN === "1";
const MAX_QUOTA = parseInt(process.env.MAX_QUOTA || "500", 10);
// Сколько P1-ключей получают /v1/topRequests. По умолчанию — все,
// потому что точная фраза часто даёт 0 (мы спрашиваем длинную формулировку
// типа «АТОЛ 27Ф обзор», а аудитория ищет «атол 27» или «атол 27 касса»).
// topRequests показывает реальные популярные вариации.
const TOP_REQUESTS_LIMIT = parseInt(
  process.env.TOP_REQUESTS_LIMIT || "1000",
  10,
);
const REGION_ID = String(process.env.REGION_ID || "225");
const FRESH_DAYS = parseInt(process.env.FRESH_DAYS || "7", 10);
const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || "200", 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pad(n) {
  return String(n).padStart(2, "0");
}

function isoDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function todayISO() {
  return isoDate(new Date());
}

function daysBetween(aIso, bIso) {
  return Math.abs((Date.parse(aIso) - Date.parse(bIso)) / 86400_000);
}

// Yandex Cloud отдаёт count строкой — приводим вручную, иначе арифметика молча
// ломается (конкатенация / NaN).
function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// RFC3339 с временем и Z — date-only Cloud отклоняет (Invalid time format).
function rfc3339FirstDayMonthsAgo(months) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function rfc3339FirstDayThisMonth() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function callApi(path, body, attempt = 1) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Api-Key ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ folderId: FOLDER_ID, ...body }),
  });
  const txt = await res.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    /* не-JSON — обработаем ниже как ошибку */
  }
  // gRPC-style ошибка: { code, message, details }. code 3 InvalidArgument,
  // 7 PermissionDenied, 13 Internal, 16 Unauthenticated.
  const grpcCode = data && typeof data.code === "number" ? data.code : null;
  const isError = !res.ok || grpcCode !== null;
  if (isError) {
    const code = grpcCode ?? res.status;
    const msg = (data && data.message) || txt.slice(0, 200);
    // Транзиентные: 13 (Internal), 429, 5xx — ретраим. 3/7/16 — фатальны.
    const transient = code === 13 || res.status === 429 || res.status >= 500;
    if (transient && attempt < 4) {
      const backoff = 1000 * 2 ** attempt;
      console.warn(`  ↻ retry ${path} after ${backoff}ms (code ${code})`);
      await sleep(backoff);
      return callApi(path, body, attempt + 1);
    }
    throw new Error(`API ${path} code ${code}: ${msg}`);
  }
  return data || {};
}

async function getDynamics(phrase) {
  const data = await callApi("/dynamics", {
    phrase,
    period: "PERIOD_MONTHLY",
    fromDate: rfc3339FirstDayMonthsAgo(12),
    toDate: rfc3339FirstDayThisMonth(),
    regions: [REGION_ID],
  });
  const arr = Array.isArray(data?.results) ? data.results : [];
  return arr.map((d) => ({
    date: typeof d.date === "string" ? d.date.slice(0, 7) : String(d.date),
    count: toInt(d.count),
  }));
}

async function getTopRequests(phrase) {
  const data = await callApi("/topRequests", {
    phrase,
    numPhrases: 30, // обязательное поле, диапазон 1..2000
    regions: [REGION_ID],
    devices: ["DEVICE_ALL"],
  });
  const arr = Array.isArray(data?.results) ? data.results : [];
  return arr.slice(0, 30).map((r) => ({
    phrase: String(r.phrase || ""),
    count: toInt(r.count),
  }));
}

function classifyTrend(history) {
  if (history.length < 6) return "unknown";
  const recent = history.slice(-3).reduce((s, p) => s + p.count, 0) / 3;
  const prev = history.slice(-6, -3).reduce((s, p) => s + p.count, 0) / 3;
  if (prev === 0) return recent > 0 ? "up" : "unknown";
  const ratio = recent / prev;
  if (ratio >= 1.2) return "up";
  if (ratio <= 0.8) return "down";
  return "stable";
}

function loadJSON(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

function isUsefulKey(norm) {
  if (!norm || norm.length < 3) return false;
  if (/^\d+$/.test(norm)) return false;
  const tokens = norm.split(/[\s-]+/).filter(Boolean);
  return tokens.length >= 2;
}

function pruneCache(cache) {
  let removed = 0;
  for (const k of Object.keys(cache.keys)) {
    if (!isUsefulKey(k)) {
      delete cache.keys[k];
      removed++;
    }
  }
  return removed;
}

function selectStaleKeys(candidates, cache) {
  const now = todayISO();
  const stale = [];
  for (const c of candidates.keys) {
    const entry = cache.keys[c.norm];
    const fetchedAt = entry?.fetchedAt;
    const ageDays = fetchedAt
      ? daysBetween(now, fetchedAt.slice(0, 10))
      : Infinity;
    const threshold = c.priority === 1 ? FRESH_DAYS : FRESH_DAYS * 4;
    if (ageDays >= threshold) {
      stale.push({ ...c, ageDays });
    }
  }
  // Сначала P1 (priority 1), внутри — самые устаревшие (или вообще не запрошенные)
  stale.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.ageDays - a.ageDays;
  });
  return stale;
}

async function main() {
  if (!existsSync(CANDIDATES)) {
    throw new Error(
      `${CANDIDATES} не найден — запустите сначала extract-keys.mjs`,
    );
  }
  if (!DRY_RUN && (!API_KEY || !FOLDER_ID)) {
    throw new Error(
      "YC_API_KEY и YC_FOLDER_ID обязательны. Задайте оба или запустите с DRY_RUN=1.",
    );
  }
  if (!DRY_RUN) {
    // Ключ не светим — только длину и хвост, чтобы видеть, что env прочитан.
    console.log(
      `[WORDSTAT] folder_id=${FOLDER_ID} api_key_len=${API_KEY.length} ` +
        `api_key_tail=${API_KEY.slice(-4)}`,
    );
  }
  const candidates = loadJSON(CANDIDATES, { keys: [] });
  const cache = loadJSON(KEYS_FILE, {
    schemaVersion: 1,
    lastFullUpdate: null,
    keys: {},
  });

  const pruned = pruneCache(cache);
  if (pruned > 0) {
    console.log(`prune: удалено ${pruned} устаревших по правилам ключей из кеша`);
  }

  const stale = selectStaleKeys(candidates, cache);

  // Бюджет: 1 квота на dynamics + 1 на topRequests (только для верхних P1).
  // Берём не больше, чем влезает в MAX_QUOTA.
  const plan = [];
  let quota = 0;
  for (const k of stale) {
    if (quota >= MAX_QUOTA) break;
    const wantsTop =
      k.priority === 1 && plan.filter((p) => p.top).length < TOP_REQUESTS_LIMIT;
    const cost = wantsTop ? 2 : 1;
    if (quota + cost > MAX_QUOTA) {
      if (quota + 1 <= MAX_QUOTA) {
        plan.push({ ...k, top: false });
        quota += 1;
      }
      continue;
    }
    plan.push({ ...k, top: wantsTop });
    quota += cost;
  }

  console.log(
    `fetch: ${candidates.keys.length} кандидатов, ` +
      `${stale.length} устаревших, в план попало ${plan.length} (квота: ${quota}/${MAX_QUOTA})`,
  );

  if (DRY_RUN) {
    console.log("DRY_RUN=1 — сетевые запросы пропущены. Первые 10 в плане:");
    for (const p of plan.slice(0, 10)) {
      console.log(
        `  [P${p.priority}${p.top ? "+top" : ""}] "${p.phrase}" (age ${
          p.ageDays === Infinity ? "∞" : Math.round(p.ageDays) + "d"
        })`,
      );
    }
    return;
  }

  let updated = 0;
  for (const p of plan) {
    try {
      const history = await getDynamics(p.phrase);
      await sleep(REQUEST_DELAY_MS);
      let related;
      if (p.top) {
        related = await getTopRequests(p.phrase);
        await sleep(REQUEST_DELAY_MS);
      }
      const last = history[history.length - 1];
      const shows = last ? last.count : 0;
      const topShows = related && related.length
        ? Math.max(...related.map((r) => r.count))
        : undefined;
      const entry = cache.keys[p.norm] || {};
      cache.keys[p.norm] = {
        ...entry,
        phrase: p.phrase,
        priority: p.priority,
        sources: p.sources,
        fetchedAt: new Date().toISOString(),
        history,
        shows,
        trend: classifyTrend(history),
        ...(related
          ? {
              related,
              topShows,
              // Если точная фраза молчит, а топ говорит — это сигнал
              // переформулировать целевой запрос. Скиллы это покажут.
              topPhrase: related[0]?.phrase,
              relatedFetchedAt: new Date().toISOString(),
            }
          : {}),
      };
      updated++;
      if (updated % 25 === 0) {
        console.log(`  …${updated}/${plan.length}`);
        // промежуточный сейв на случай прерывания
        writeFileSync(KEYS_FILE, JSON.stringify(cache, null, 2) + "\n");
      }
    } catch (err) {
      console.error(`  ✗ "${p.phrase}": ${err.message}`);
      // Не критично — идём дальше, токен может сломаться на одной фразе
      // (например, кириллица или редкий символ).
    }
  }

  cache.lastFullUpdate = todayISO();
  if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  writeFileSync(KEYS_FILE, JSON.stringify(cache, null, 2) + "\n");
  copyFileSync(KEYS_FILE, join(SNAPSHOTS_DIR, `${todayISO()}.json`));

  console.log(`fetch: обновлено ${updated} ключей → ${KEYS_FILE}`);
  console.log(`       snapshot → snapshots/${todayISO()}.json`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
