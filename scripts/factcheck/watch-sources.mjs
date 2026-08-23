#!/usr/bin/env node
/**
 * J-04. Наблюдение за источниками: что перепроверять, когда меняется НПА.
 *
 * `snapshotHash` уже фиксирует состояние страницы на дату обращения —
 * это ввёл D-02, чтобы цитату было с чем сверить. Но фиксация сама по
 * себе ничего не запускает: страница может смениться редакцией нормы, а
 * отчёт продолжит ссылаться на прежний отпечаток, и никто не узнает.
 *
 * Здесь строится обратный индекс «источник → кто от него зависит».
 * Он отвечает на вопрос, который иначе требует ручного перебора: норму
 * поправили — какие статьи и какие утверждения надо перепроверить.
 *
 * Что делает и чего не делает. Скрипт не ходит в сеть. Загрузку страницы
 * выполняет тот, у кого есть доступ (сессия факчека, рутина), и передаёт
 * сюда новый отпечаток: `--url <адрес> --hash <sha256>`. Такое разделение
 * не косметическое — оно означает, что индекс считается одинаково в CI
 * без сети и на машине с сетью, а решение «перепроверять» принимается по
 * одним и тем же правилам в обоих случаях.
 *
 * Использование:
 *   node scripts/factcheck/watch-sources.mjs                    # индекс
 *   node scripts/factcheck/watch-sources.mjs --stale 180        # давно не смотрели
 *   node scripts/factcheck/watch-sources.mjs --url <u> --hash <h>  # источник изменился
 *   node scripts/factcheck/watch-sources.mjs --refresh          # обойти источники (сеть) и записать очередь
 *   node scripts/factcheck/watch-sources.mjs --queue            # что сейчас в очереди
 *
 * Очередь. Печать в stdout ничего не переживает: прогон закончился —
 * находка потеряна, и «источник изменился» узнаёт только тот, кто в этот
 * момент смотрел в лог. Поэтому `--refresh` не докладывает, а записывает:
 * `src/data/factcheck/needs-review.json` — список статей, ждущих
 * перепроверки, с датой обнаружения и причиной. Запись живёт до тех пор,
 * пока статью не перепроверят: маркер новее даты обнаружения снимает её
 * автоматически, вручную удалять ничего не нужно.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { loadRegistry } from './fact-registry.mjs';

const ROOT = process.env.FACTCHECK_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Сколько дней доказательство считается свежим, если норма не менялась. */
export const DEFAULT_STALE_DAYS = 180;

/** Очередь статей, ждущих перепроверки. Файл переживает прогон, вывод — нет. */
export const QUEUE = 'src/data/factcheck/needs-review.json';

const readJson = (p) => {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

const ageDays = (iso, today = new Date().toISOString().slice(0, 10)) => {
  const a = Date.parse(`${iso}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.floor((b - a) / 86400000);
};

/**
 * Обратный индекс: адрес источника → кто на него опирается.
 *
 * @returns {Map<string, {url, snapshotHash: string|null, retrievedAt: string|null,
 *                        dependents: Array<{kind: 'claim'|'fact', slug?, id}>}>}
 */
export function sourceIndex(root = ROOT) {
  const index = new Map();
  const touch = (url) => {
    if (!index.has(url)) index.set(url, { url, snapshotHash: null, retrievedAt: null, dependents: [] });
    return index.get(url);
  };
  /* Отпечаток и дату берём самые свежие из встреченных: один и тот же
   * документ разные утверждения могли открывать в разные дни. */
  const note = (rec, e) => {
    if (e?.snapshotHash && (!rec.retrievedAt || String(e.retrievedAt) >= rec.retrievedAt)) {
      rec.snapshotHash = e.snapshotHash;
    }
    if (e?.retrievedAt && (!rec.retrievedAt || e.retrievedAt > rec.retrievedAt)) rec.retrievedAt = e.retrievedAt;
  };

  const results = join(root, 'src/data/factcheck/results');
  if (existsSync(results)) {
    for (const f of readdirSync(results).filter((x) => x.endsWith('.json'))) {
      const slug = f.replace(/\.json$/, '');
      for (const c of readJson(join(results, f))?.claims || []) {
        for (const e of c.evidence || []) {
          if (!e?.url) continue;
          const rec = touch(e.url);
          note(rec, e);
          rec.dependents.push({ kind: 'claim', slug, id: c.id, claimId: c.claimId ?? null });
        }
      }
    }
  }

  for (const fact of loadRegistry(root).facts) {
    const e = fact.evidence;
    if (!e?.url) continue;
    const rec = touch(e.url);
    note(rec, e);
    /* Запись реестра тянет за собой все статьи, которые ей пользуются:
     * изменился первоисточник — очередь перепроверки сразу известна. */
    rec.dependents.push({ kind: 'fact', id: fact.id, usedBy: fact.usedBy ?? [] });
  }

  return index;
}

/**
 * Источники, которые давно не открывали.
 *
 * Отсутствие `retrievedAt` — не «свежий», а «неизвестно когда»: такой
 * источник попадает в очередь наравне с просроченным.
 */
export function staleSources(root = ROOT, { days = DEFAULT_STALE_DAYS, today } = {}) {
  const out = [];
  for (const rec of sourceIndex(root).values()) {
    const age = rec.retrievedAt ? ageDays(rec.retrievedAt, today) : null;
    if (age === null || age > days) out.push({ ...rec, age });
  }
  return out.sort((a, b) => (b.age ?? Infinity) - (a.age ?? Infinity));
}

/**
 * Что перепроверять, если у источника сменился отпечаток.
 *
 * Совпал — ничего: страница та же, доказательства в силе. Не совпал —
 * в очередь уходят все зависимые утверждения и все статьи зависимых
 * записей реестра. Отпечатка не было вовсе — тоже в очередь: сравнить
 * не с чем, а значит, «не изменилось» утверждать не на чем.
 */
export function affectedBySource(root, url, newHash) {
  const rec = sourceIndex(root).get(url);
  if (!rec) return { known: false, changed: false, dependents: [], articles: [] };
  const changed = !rec.snapshotHash || rec.snapshotHash !== newHash;
  const articles = new Set();
  if (changed) {
    for (const d of rec.dependents) {
      if (d.kind === 'claim') articles.add(d.slug);
      else for (const s of d.usedBy) articles.add(s);
    }
  }
  return {
    known: true,
    changed,
    hadSnapshot: Boolean(rec.snapshotHash),
    dependents: changed ? rec.dependents : [],
    articles: [...articles].sort(),
  };
}

/**
 * Очередь перепроверки: слить новые находки со старыми и снять закрытые.
 *
 * Правила простые и обе стороны нужны. Новая находка не затирает старую
 * дату: возраст записи — это и есть мера долга, и обнулять его при
 * каждом прогоне значило бы прятать залежавшееся. Запись снимается,
 * когда статью действительно перепроверили: маркер факчека датирован не
 * раньше дня обнаружения. Никакого «отметить сделанным» руками — иначе
 * очередь чистят вместо работы.
 *
 * @param {string} root
 * @param {Array<{slug, url, reason}>} found — что нашёл текущий обход.
 * @param {{today?: string}} [o]
 * @returns {{entries: Array, added: Array, closed: Array}}
 */
export function mergeQueue(root, found, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const prev = readJson(join(root, QUEUE))?.entries ?? [];
  const byKey = new Map(prev.map((e) => [`${e.slug}|${e.url}`, e]));
  const added = [];

  for (const f of found) {
    const key = `${f.slug}|${f.url}`;
    if (byKey.has(key)) continue;
    const entry = { slug: f.slug, url: f.url, reason: f.reason, detectedAt: today };
    byKey.set(key, entry);
    added.push(entry);
  }

  /* Перепроверена ли статья после того, как её сюда поставили. Дата
   * берётся из маркера: это единственная отметка, которую нельзя
   * поставить, не пройдя валидатор. */
  const closed = [];
  const entries = [];
  for (const e of byKey.values()) {
    const marker = join(root, '.claude/factchecked', e.slug);
    let checkedAt = null;
    if (existsSync(marker)) {
      const m = readFileSync(marker, 'utf8').match(/\d{4}-\d{2}-\d{2}/);
      checkedAt = m ? m[0] : null;
    }
    if (checkedAt && checkedAt >= e.detectedAt) { closed.push({ ...e, checkedAt }); continue; }
    entries.push(e);
  }
  entries.sort((a, b) => (a.detectedAt === b.detectedAt ? a.slug.localeCompare(b.slug) : a.detectedAt.localeCompare(b.detectedAt)));
  return { entries, added, closed };
}

/** Записать очередь. Пустая очередь — тоже запись: «проверяли, чисто». */
export function writeQueue(root, entries, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const data = { schemaVersion: 1, updatedAt: today, entries };
  writeFileSync(join(root, QUEUE), `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

/** Что сейчас в очереди. */
export function openQueue(root = ROOT) {
  return readJson(join(root, QUEUE))?.entries ?? [];
}

/* ── CLI ────────────────────────────────────────────────────────────── */

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 || i === args.length - 1 ? null : args[i + 1];
  };

  const url = opt('url');
  if (url) {
    const hash = opt('hash');
    if (!hash) { console.error('✖ нужен --hash <sha256> вместе с --url'); process.exit(2); }
    const r = affectedBySource(ROOT, url, hash);
    if (!r.known) { console.log(`Источник ${url} в отчётах и реестре не встречается — перепроверять нечего.`); process.exit(0); }
    if (!r.changed) { console.log(`✓ Отпечаток совпал — источник не менялся, доказательства в силе.`); process.exit(0); }
    console.log(`✖ Источник изменился${r.hadSnapshot ? '' : ' (прежнего отпечатка не было — сравнить не с чем)'}.`);
    console.log(`  Зависимых утверждений: ${r.dependents.length}`);
    console.log(`  В перепроверку (${r.articles.length}): ${r.articles.join(', ')}`);
    console.log('\n  Система статьи не переписывает — переводит в needs-review:');
    for (const s of r.articles) console.log(`    /factcheck ${s}`);
    process.exit(1);
  }

  /* Обход источников с сетью. Единственный режим, который ходит наружу,
   * и единственный, который пишет очередь: разделение то же, что у
   * `--url/--hash`, только автоматическое. */
  if (args.includes('--refresh')) {
    const { fetchSnapshot, saveSnapshot } = await import('./snapshot.mjs');
    const index = sourceIndex(ROOT);
    const days = Number(opt('stale')) || DEFAULT_STALE_DAYS;
    const found = [];
    let checked = 0; let unreachable = 0;

    for (const rec of index.values()) {
      const r = await fetchSnapshot(rec.url);
      checked += 1;
      if (!r.ok) {
        unreachable += 1;
        /* Недоступный источник — не «не изменился». Доказательство,
         * которое нечем перепроверить, обязано попасть в очередь: иначе
         * исчезнувшая страница выглядит как стабильная. */
        for (const d of rec.dependents) {
          for (const slug of d.kind === 'claim' ? [d.slug] : d.usedBy) {
            found.push({ slug, url: rec.url, reason: `источник недоступен (${r.status ?? r.error})` });
          }
        }
        continue;
      }
      const changed = !rec.snapshotHash || rec.snapshotHash !== r.hash;
      if (!changed) continue;
      saveSnapshot(ROOT, r.text);
      const why = rec.snapshotHash
        ? `страница изменилась: было ${String(rec.snapshotHash).slice(0, 12)}…, стало ${r.hash.slice(0, 12)}…`
        : 'прежнего отпечатка не было — сравнить не с чем';
      for (const d of rec.dependents) {
        for (const slug of d.kind === 'claim' ? [d.slug] : d.usedBy) {
          found.push({ slug, url: rec.url, reason: why });
        }
      }
    }

    for (const st of staleSources(ROOT, { days })) {
      for (const d of st.dependents) {
        for (const slug of d.kind === 'claim' ? [d.slug] : d.usedBy) {
          found.push({ slug, url: st.url, reason: `источник не открывали ${st.age === null ? 'неизвестно сколько' : `${st.age} дн.`} (порог ${days})` });
        }
      }
    }

    const { entries, added, closed } = mergeQueue(ROOT, found);
    writeQueue(ROOT, entries);
    console.log(`Обойдено источников: ${checked}${unreachable ? `, недоступно ${unreachable}` : ''}`);
    console.log(`Очередь перепроверки: ${entries.length} (новых ${added.length}, снято ${closed.length}) → ${QUEUE}`);
    for (const e of entries.slice(0, 20)) console.log(`  ${e.detectedAt}  ${e.slug}\n      ${e.reason}`);
    if (entries.length > 20) console.log(`  … и ещё ${entries.length - 20}`);
    process.exit(entries.length ? 1 : 0);
  }

  if (args.includes('--queue')) {
    const entries = openQueue(ROOT);
    if (!entries.length) { console.log('✓ Очередь перепроверки пуста.'); process.exit(0); }
    console.log(`В очереди перепроверки — ${entries.length}:\n`);
    for (const e of entries) {
      console.log(`  ${e.detectedAt}  ${e.slug}`);
      console.log(`      ${e.reason}`);
      console.log(`      /factcheck ${e.slug}`);
    }
    process.exit(1);
  }

  if (args.includes('--stale')) {
    const days = Number(opt('stale')) || DEFAULT_STALE_DAYS;
    const stale = staleSources(ROOT, { days });
    if (!stale.length) { console.log(`✓ Все источники открывали не позже чем ${days} дн. назад.`); process.exit(0); }
    console.log(`Источников давно не открывали — ${stale.length} (порог ${days} дн.):\n`);
    for (const s of stale) {
      console.log(`  ${s.age === null ? 'дата неизвестна' : `${s.age} дн.`} · зависимых ${s.dependents.length}`);
      console.log(`    ${s.url}`);
    }
    process.exit(1);
  }

  const index = sourceIndex(ROOT);
  console.log(`Источников в корпусе: ${index.size}\n`);
  const rows = [...index.values()].sort((a, b) => b.dependents.length - a.dependents.length);
  for (const r of rows) {
    const facts = r.dependents.filter((d) => d.kind === 'fact').length;
    console.log(`  зависимых ${String(r.dependents.length).padStart(3)}${facts ? ` (из них записей реестра ${facts})` : ''}`
      + ` · отпечаток ${r.snapshotHash ? 'есть' : 'нет'} · открывали ${r.retrievedAt ?? '—'}`);
    console.log(`    ${r.url}`);
  }
  const noHash = rows.filter((r) => !r.snapshotHash).length;
  if (noHash) {
    console.log(`\n  Без отпечатка — ${noHash}: изменение такого источника обнаружить нечем.`);
  }
  process.exit(0);
}
