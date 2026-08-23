#!/usr/bin/env node
// Строит очередь аудита для /maintain-content — детерминированная часть
// шагов 1б и 2а-bis: сроки reviewDate/factcheck и классификация спроса
// по Wordstat.
//
// Раньше это была чисто текстовая инструкция: даты сравнивать руками,
// средние по истории считать в уме, пороги ×2/×0.5 применять на глаз.
// Арифметика, которую легко посчитать чуть иначе от прогона к прогону —
// то есть от неё зависит, какие статьи вообще попадут в очередь на
// вычитку, без гарантии, что два прогона на одних и тех же данных дадут
// одну и ту же очередь.
//
// Раньше же в тексте команды было два слегка разных определения «спрос
// растёт»: грубое — для отбора в очередь (trend='up' ИЛИ shows вырос
// ×2+ к среднему за 6 мес.), и точное — для классификации в отчёте
// (recent3/baseline6 ≥ 2 по 9-месячному окну). Здесь используется одно
// определение — точное — для обеих целей: отбора и классификации.
//
// Запуск:
//   node scripts/maintain-content-queue.mjs            # человекочитаемо
//   node scripts/maintain-content-queue.mjs --json      # для агента
//   node scripts/maintain-content-queue.mjs <slug>       # одна статья

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

// Переопределяется в тестах — не трогает реальный репозиторий.
const ROOT = process.env.MAINTAIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOG_DIR = join(ROOT, 'src/content/blog');
const MARKERS_DIR = join(ROOT, '.claude/factchecked');
const KEYS_PATH = join(ROOT, 'src/data/wordstat/keys.json');
const QUEUE_PATH = join(ROOT, 'src/content/wiki/maintain-queue.md');

const STALE_DAYS = 90;

export function ageDays(iso, now = new Date()) {
  return iso ? Math.floor((now - new Date(iso)) / 86400000) : null;
}

export function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*"?([^"#\n]*)"?\s*$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  const kwBlock = m[1].match(/seo:\s*\n((?:\s+\S[^\n]*\n?)+)/);
  fm._keywords = [];
  if (kwBlock) {
    const kwMatch = kwBlock[1].match(/keywords:\s*\n((?:\s+-\s+[^\n]+\n?)+)/);
    if (kwMatch) fm._keywords = kwMatch[1].match(/(?<=-\s)(.+)/g)?.map((s) => s.trim()) ?? [];
  }
  return fm;
}

/** Записи `- <slug> — <что добавить> (источник: <URL>)` из maintain-queue.md. */
export function parseMaintainQueue(text) {
  const out = new Map();
  if (!text) return out;
  const re = /^-\s*([a-z0-9][a-z0-9-]*)\s*—\s*(.+?)(?:\s*\(источник:\s*(\S+)\))?\s*$/gim;
  for (const m of text.matchAll(re)) {
    out.set(m[1], { note: m[2].trim(), source: m[3] || null });
  }
  return out;
}

/**
 * Единое определение «спрос растёт/падает»: recent3 (среднее по
 * последним 3 мес.) против baseline6 (среднее по предыдущим 6 мес.),
 * из 9-точечного окна истории. Короче 9 точек — используем trend
 * напрямую, у recent3/baseline6 не набирается статистики.
 */
export function classifyDemand(entry) {
  if (!entry) return null;
  const history = entry.history || [];
  let signal, recent3 = null, baseline6 = null;

  if (history.length >= 9) {
    const last9 = history.slice(-9);
    baseline6 = last9.slice(0, 6).reduce((s, p) => s + p.count, 0) / 6;
    recent3 = last9.slice(6).reduce((s, p) => s + p.count, 0) / 3;
    if (baseline6 === 0) signal = recent3 > 0 ? 'up' : 'stable';
    else if (recent3 / baseline6 >= 2) signal = 'up';
    else if (recent3 / baseline6 <= 0.5) signal = 'down';
    else signal = 'stable';
  } else {
    signal = entry.trend || null;
  }

  const narrowKeyword =
    entry.topShows && entry.shows && entry.topShows >= 3 * entry.shows ? entry.topPhrase : null;

  return { signal, recent3, baseline6, narrowKeyword };
}

/** Первый keyword статьи с записью в keys.json — тот же порядок, что и в frontmatter. */
export function demandForArticle(keys, keywords) {
  for (const kwRaw of keywords || []) {
    const kw = kwRaw.toLowerCase().replace(/["']/g, '').trim();
    const entry = keys[kw];
    if (!entry) continue;
    return { keyword: kw, ...classifyDemand(entry) };
  }
  return null;
}

export function buildQueue({ blogDir, markersDir, keys, queueEntries, now = new Date(), onlySlug = null }) {
  const today = now.toISOString().slice(0, 10);
  const files = existsSync(blogDir) ? readdirSync(blogDir).filter((f) => f.endsWith('.md') || f.endsWith('.mdx')) : [];
  const rows = [];

  for (const f of files) {
    const slug = f.replace(/\.(md|mdx)$/, '');
    if (onlySlug && slug !== onlySlug) continue;

    const text = readFileSync(join(blogDir, f), 'utf8');
    const fm = parseFrontmatter(text);
    if (!fm || fm.draft === 'true') continue;

    const markerPath = join(markersDir, slug);
    let factcheckedAt = null;
    if (existsSync(markerPath)) {
      try {
        factcheckedAt = JSON.parse(readFileSync(markerPath, 'utf8')).date || null;
      } catch {
        /* повреждённый или до-хешевый маркер — считаем отсутствующим */
      }
    }
    const factcheckAge = ageDays(factcheckedAt, now);
    const factcheckStale = factcheckAge === null || factcheckAge > STALE_DAYS;

    const reviewDate = fm.reviewDate || null;
    const reviewDue = Boolean(reviewDate) && reviewDate <= today;

    const inQueue = queueEntries.get(slug) || null;
    const demand = demandForArticle(keys, fm._keywords);
    const demandUp = demand?.signal === 'up';

    if (!(inQueue || reviewDue || factcheckStale || demandUp)) continue;

    const reason = inQueue
      ? 'maintain-queue'
      : !factcheckedAt
        ? 'no-factcheck'
        : factcheckStale
          ? 'stale-factcheck'
          : reviewDue
            ? 'review-due'
            : 'demand-up';

    rows.push({
      slug, reason,
      updatedDate: fm.updatedDate || null,
      reviewDate, reviewDue,
      factcheckedAt, factcheckAge, factcheckStale,
      demand,
      queueNote: inQueue?.note || null,
      querySource: inQueue?.source || null,
    });
  }

  const rank = { 'maintain-queue': 0, 'no-factcheck': 1, 'stale-factcheck': 2, 'review-due': 3, 'demand-up': 3 };
  rows.sort((a, b) => {
    const r = (rank[a.reason] ?? 9) - (rank[b.reason] ?? 9);
    if (r !== 0) return r;
    if (a.reason === 'stale-factcheck') return (b.factcheckAge ?? 0) - (a.factcheckAge ?? 0);
    return (a.reviewDate || '9999-99-99').localeCompare(b.reviewDate || '9999-99-99');
  });

  return rows;
}

// CLI — не выполняется при импорте (тесты импортируют функции напрямую).
if (isMain(import.meta.url)) {
  const AS_JSON = process.argv.includes('--json');
  const onlySlug = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;

  const keys = existsSync(KEYS_PATH)
    ? (() => { try { return JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys || {}; } catch { return {}; } })()
    : {};
  const queueEntries = parseMaintainQueue(existsSync(QUEUE_PATH) ? readFileSync(QUEUE_PATH, 'utf8') : '');

  const rows = buildQueue({ blogDir: BLOG_DIR, markersDir: MARKERS_DIR, keys, queueEntries, onlySlug });

  if (AS_JSON) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), queue: rows }, null, 2));
  } else {
    console.log(`Очередь аудита: ${rows.length} статей\n`);
    for (const r of rows) {
      const bits = [r.reason];
      if (r.demand?.signal === 'up') bits.push('📈 спрос растёт');
      if (r.demand?.signal === 'down') bits.push('📉 спрос падает');
      if (r.demand?.narrowKeyword) bits.push(`узкий ключ → «${r.demand.narrowKeyword}»`);
      console.log(`  ${r.slug} — ${bits.join(', ')}`);
    }
    if (!rows.length) console.log('  (пусто)');
  }
}
