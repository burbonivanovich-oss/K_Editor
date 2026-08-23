/**
 * H-01. Закрытый реестр утверждений: у каждого извлечённого — свой исход.
 *
 * Что было. `claims/<slug>.json` (извлечение) и `results/<slug>.json`
 * (отчёт) — два независимых списка с независимой нумерацией. У обоих id
 * вида `c1…cN`, и они случайно пересекаются: отчётный `c1` в статье про
 * ТС ПИоТ — это «28.12.2025», а извлечённый `c1` — совсем другой токен.
 * Замер по корпусу 21.08.2026: из 303 утверждений отчётов корректно
 * резолвится 131, ещё 159 указывают на другое утверждение, 13 — в
 * никуда; 134 извлечённых утверждения не имеют следа в отчётах вовсе.
 *
 * 160 из этих ссылок появились не сами: миграция C-04 раздала
 * недостающие id по позиции (`c${i+1}`). До неё связи не было, после —
 * связь есть и она неверна. Это хуже: отсутствие видно, а неверная
 * ссылка резолвится молча.
 *
 * Отсюда два решения.
 *
 * 1. Разные пространства имён названы разными полями. `id` — адрес
 *    внутри отчёта, он и был локальным. `claimId` — ссылка в реестр
 *    извлечения. Переиспользовать `id` как ссылку нельзя: там, где
 *    нумерации случайно совпали, проверка молча признала бы коллизию
 *    правильной.
 *
 * 2. Реестр закрыт: у каждого извлечённого утверждения ровно один
 *    исход. `checked` — на него ссылается утверждение отчёта.
 *    `skipped` — решили не проверять, и написали почему. `duplicateOf`
 *    — то же самое место разбирает другое утверждение. Никакого
 *    четвёртого варианта «просто нет в отчёте» не существует:
 *    отсутствующее не оставляет следа, и ровно поэтому его не видно.
 *
 * Решения `skipped`/`duplicateOf` живут в отчёте (секция `ledger`), а
 * не в файле извлечения. Файл извлечения машинный и перезаписывается
 * прогоном `extract-claims`; решение человека, положенное туда,
 * стёрлось бы следующим прогоном — ровно та беда, которую чинит H-03.
 */

/**
 * Текст утверждения для сверки ссылки.
 *
 * Сравниваем не побайтово: regex извлекает токен («10 000 ₽»), а отчёт
 * разбирает предложение целиком. Совпадением считается вхождение
 * извлечённого токена в текст утверждения отчёта — этого достаточно,
 * чтобы отличить «это про то же место» от «id указал в чужую строку».
 */
export const normRaw = (s) => String(s ?? '')
  .replace(/[   ]/g, ' ')
  .replace(/[«»"“”„]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/** Ссылается ли утверждение отчёта на то же место статьи, что извлечённое. */
export function rawMatches(extractedRaw, reportRaw) {
  const a = normRaw(extractedRaw);
  const b = normRaw(reportRaw);
  if (!a || !b) return false;
  return a === b || b.includes(a) || a.includes(b);
}

/** Исходы, которые закрывают извлечённое утверждение. */
export const LEDGER_OUTCOMES = ['skipped', 'duplicateOf'];

/**
 * Подобрать `claimId` для утверждений отчёта по тексту.
 *
 * Нужна миграции и разбору: связь между двумя списками существует по
 * смыслу, её просто никогда не записывали. Кандидат считается
 * однозначным, только если подходит ровно одно извлечённое утверждение —
 * иначе выбор делает человек, а не позиция в файле.
 *
 * @returns {{linked: number, ambiguous: Array, unlinked: Array}}
 */
export function linkByRaw(extractionClaims, reportClaims, { repair = true } = {}) {
  /* stale-утверждения целью ссылки быть не могут: их цитаты в тексте
   * больше нет, и «разобрано» про них не бывает. */
  const pool = (extractionClaims || [])
    .filter((c) => !c.stale)
    .map((c) => ({ id: String(c.id), raw: c.raw }));
  const byId = new Map(pool.map((e) => [e.id, e]));
  const taken = new Set();
  let linked = 0;
  let repaired = 0;
  const ambiguous = [];
  const unlinked = [];

  /* Битая ссылка хуже отсутствующей: она резолвится и выглядит проверкой.
   * Поэтому перед подбором снимаем те, что указывают в никуда или в
   * чужое место. Ровно так корпус и приехал к 107 ложным ссылкам —
   * повторное извлечение переставило позиционные id, а ссылки остались
   * от прежней нумерации. */
  if (repair) {
    for (const rc of reportClaims || []) {
      if (!rc.claimId) continue;
      const t = byId.get(String(rc.claimId));
      if (!t || !rawMatches(t.raw, rc.raw)) { delete rc.claimId; repaired++; }
    }
  }

  for (const rc of reportClaims || []) {
    if (rc.claimId) { taken.add(String(rc.claimId)); continue; }
    const hits = pool.filter((e) => !taken.has(e.id) && rawMatches(e.raw, rc.raw));
    if (hits.length === 1) {
      rc.claimId = hits[0].id;
      taken.add(hits[0].id);
      linked++;
    } else if (hits.length > 1) {
      /* Несколько кандидатов. Два разных случая, и путать их нельзя.
       *
       * Кандидаты с разным текстом — «ст. 14.5» и «ч. 2 ст. 14.5» —
       * это выбор точности: берём самый длинный, он конкретнее.
       *
       * Кандидаты с одинаковым текстом — «1 октября 2026 года»,
       * встретившееся в статье трижды, — выбором не являются: какой
       * из трёх спанов ни возьми, разбирается один и тот же токен.
       * Здесь берём первый ещё не занятый, то есть пара складывается
       * в порядке появления в тексте.
       *
       * Разница с прежней раздачей по позиции принципиальная: там id
       * присваивался вообще без сверки текста и мог указать в чужую
       * строку. Здесь текст уже совпал — сверка `rawMatches` прошла до
       * этой ветки, — и выбирается только между одинаковыми. */
      const best = hits.slice().sort((a, b) => normRaw(b.raw).length - normRaw(a.raw).length);
      const top = normRaw(best[0].raw);
      const sameText = best.filter((h) => normRaw(h.raw) === top);
      if (sameText.length === best.length || top.length > normRaw(best[sameText.length].raw).length) {
        rc.claimId = sameText[0].id;
        taken.add(sameText[0].id);
        linked++;
      } else {
        ambiguous.push({ id: rc.id, raw: rc.raw, candidates: hits.map((h) => h.id) });
      }
    } else {
      unlinked.push({ id: rc.id, raw: rc.raw });
    }
  }
  return { linked, repaired, ambiguous, unlinked };
}

/**
 * Проверить замкнутость реестра.
 *
 * @param {object} extraction — содержимое claims/<slug>.json
 * @param {object} report — содержимое results/<slug>.json
 * @param {string} name — имя для сообщений
 * @returns {Array<{name, id, problem}>}
 */
export function checkLedger(extraction, report, name = 'реестр') {
  const problems = [];
  const add = (id, problem) => problems.push({ name, id, problem });

  const extracted = Array.isArray(extraction?.claims) ? extraction.claims : null;
  if (!extracted) {
    add('реестр', 'нет файла извлечения (claims/<slug>.json) — не с чем сверять полноту разбора');
    return problems;
  }

  /* Утверждения, помеченные stale прогоном extract-claims, из реестра
   * исключены: их цитаты в тексте больше нет, требовать по ним исход
   * значит требовать разбирать несуществующее место. Сам факт stale —
   * отдельная претензия, её печатает extract-claims. */
  const live = extracted.filter((c) => !c.stale);
  const byId = new Map(live.map((c) => [String(c.id), c]));
  const claims = Array.isArray(report?.claims) ? report.claims : [];
  const ledger = report?.ledger && typeof report.ledger === 'object' ? report.ledger : {};

  /* ── Ссылки отчёта в реестр ─────────────────────────────────────── */
  const checked = new Set();
  for (const rc of claims) {
    const id = rc?.id ?? '—';
    const ref = rc?.claimId;
    if (!ref) {
      add(id, 'нет claimId — утверждение не привязано к реестру извлечения, и полноту разбора по нему не посчитать');
      continue;
    }
    const target = byId.get(String(ref));
    if (!target) {
      add(id, `claimId «${ref}» в реестре извлечения не существует`);
      continue;
    }
    if (!rawMatches(target.raw, rc.raw)) {
      add(id, `claimId «${ref}» указывает на другое место статьи: в реестре «${String(target.raw).slice(0, 40)}», в отчёте «${String(rc.raw).slice(0, 40)}»`);
      continue;
    }
    if (checked.has(String(ref))) {
      add(id, `claimId «${ref}» уже разобран другим утверждением — если это тот же факт, нужен ledger duplicateOf`);
      continue;
    }
    checked.add(String(ref));
  }

  /* ── Решения о непроверенных ────────────────────────────────────── */
  const closed = new Set(checked);
  for (const [ref, decision] of Object.entries(ledger)) {
    if (!byId.has(ref)) {
      add('ledger', `решение по «${ref}», которого нет в реестре извлечения`);
      continue;
    }
    if (checked.has(ref)) {
      add('ledger', `«${ref}» одновременно разобран утверждением отчёта и помечен в ledger — исход должен быть один`);
      continue;
    }
    const outcome = decision?.outcome;
    if (!LEDGER_OUTCOMES.includes(outcome)) {
      add('ledger', `«${ref}»: исход «${outcome ?? 'нет'}» не из списка: ${LEDGER_OUTCOMES.join(', ')}`);
      continue;
    }
    if (outcome === 'skipped') {
      if (!String(decision.reason || '').trim()) {
        add('ledger', `«${ref}»: skipped без reason — «не проверяли» без «почему» это пропущенный шаг, а не решение`);
        continue;
      }
    } else {
      const of = String(decision.of ?? '');
      if (!byId.has(of)) {
        add('ledger', `«${ref}»: duplicateOf «${of || 'нет'}» — такого утверждения в реестре нет`);
        continue;
      }
      if (of === ref) { add('ledger', `«${ref}»: duplicateOf сам на себя`); continue; }
      if (!checked.has(of)) {
        add('ledger', `«${ref}»: duplicateOf «${of}», но само «${of}» никто не разбирал — дубликат не может закрывать дубликат`);
        continue;
      }
    }
    closed.add(ref);
  }

  /* ── Замкнутость ────────────────────────────────────────────────── */
  const orphans = live.filter((c) => !closed.has(String(c.id)));
  if (orphans.length) {
    const list = orphans.slice(0, 5)
      .map((c) => `${c.id} «${String(c.raw).slice(0, 34)}» (строка ${c.line ?? '?'})`)
      .join(', ');
    add('реестр',
      `${orphans.length} извлечённых утверждений без исхода: ${list}${orphans.length > 5 ? ` и ещё ${orphans.length - 5}` : ''}. ` +
      'У каждого должен быть либо разбор в отчёте, либо ledger skipped/duplicateOf.');
  }

  return problems;
}

/** Сводка для отчётов и метрик: сколько чего в реестре. */
export function ledgerStats(extraction, report) {
  const live = (extraction?.claims || []).filter((c) => !c.stale);
  const byId = new Set(live.map((c) => String(c.id)));
  const claims = report?.claims || [];
  const ledger = report?.ledger || {};

  const resolved = claims.filter((c) => c.claimId && byId.has(String(c.claimId)));
  const wrongTarget = resolved.filter((c) => {
    const t = live.find((e) => String(e.id) === String(c.claimId));
    return !rawMatches(t?.raw, c.raw);
  });
  const decided = Object.keys(ledger).filter((k) => byId.has(k));
  const closed = new Set([
    ...resolved.filter((c) => !wrongTarget.includes(c)).map((c) => String(c.claimId)),
    ...decided,
  ]);

  return {
    extracted: live.length,
    reported: claims.length,
    linked: resolved.length - wrongTarget.length,
    unlinked: claims.filter((c) => !c.claimId).length,
    danglingId: claims.filter((c) => c.claimId && !byId.has(String(c.claimId))).length,
    wrongTarget: wrongTarget.length,
    skipped: decided.filter((k) => ledger[k]?.outcome === 'skipped').length,
    duplicates: decided.filter((k) => ledger[k]?.outcome === 'duplicateOf').length,
    orphans: live.filter((c) => !closed.has(String(c.id))).length,
  };
}
