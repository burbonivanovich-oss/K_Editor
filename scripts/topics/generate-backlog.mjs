#!/usr/bin/env node
/**
 * Рутина A0 — недельный бэклог тем.
 *
 * Собирает кандидатов из последнего Wordstat-диффа, отсеивает то, что уже
 * покрыто планом и блогом, снимает заглушённые темы и объясняет по каждой,
 * почему её стоит писать именно сейчас. Результат уходит редактору
 * таблицей: он раз в неделю проставляет решения, ничего не выискивая сам.
 *
 * Инфоповоды — темы без частотности — приходят файлом --signals: событие
 * объявили, запрос ещё не сформировался, и через Wordstat такая тема не
 * придёт никогда. Отбираются до общего пула и в пределах своей квоты
 * (--signals-quota, по умолчанию 6): сортировка по спросу похоронила бы
 * их в конце списка. Собирают сигналы /monitor-rss и
 * /monitor-competitors — они работают в сессии и файлов не оставляют,
 * поэтому JSON готовит рутина A0, см. cycle-backlog.md, «Шаг 1в».
 *
 * Запуск:
 *   node scripts/topics/generate-backlog.mjs
 *   node scripts/topics/generate-backlog.mjs --limit 20 --signals /tmp/signals.json
 *   node scripts/topics/generate-backlog.mjs --limit 40 --per-cluster 4
 *   node scripts/topics/generate-backlog.mjs --dry-run
 *
 * --per-cluster N (по умолчанию 4) — сколько тем одного кластера пускать в
 * список. Без ограничения самый частотный кластер выбирает всю квоту, и
 * редактор видит не обзор спроса, а один кластер в тридцати формулировках.
 *
 * --near-dup 0..1 (по умолчанию 0.4) — порог схлопывания перестановочных
 * дублей: «маркировка товара знаки» и «честный знак на товаре» это одна
 * тема. 0 отключает проверку.
 *
 * --bands off — снять квоты по полосам частотности и вернуться к чистой
 * сортировке по спросу. По умолчанию квоты включены: без них список
 * получается однородно широким, а узкие коммерческие запросы («касса для
 * аптеки», «учёт остатков в магазине») не попадают в него никогда.
 *
 * Пишет src/data/topic-backlog.json. Решения редактора разбирает
 * cycle-listen, память об отказах ведёт suppressions.mjs.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isSuppressed, normalize, load as loadSuppressions } from "./suppressions.mjs";
import { isInformational, dedupeKey, stemTokens } from "../wordstat/relevance.mjs";
import { tokenize, jaccard } from "../lib/text-similarity.mjs";
import { priorityMultiplier } from "./priority-clusters.mjs";
import { segmentFor } from "./segments.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DISC_DIR = join(ROOT, "src", "data", "wordstat", "discoveries");
const PLAN_FILE = join(ROOT, "src", "data", "editorial-plan.json");
const BLOG_DIR = join(ROOT, "src", "content", "blog");
const OUT = join(ROOT, "src", "data", "topic-backlog.json");
const DYNAMICS_FILE = join(ROOT, "src", "data", "wordstat", "candidate-dynamics.json");
const PRODUCT_MAP_FILE = join(ROOT, "src", "data", "product-mapping.json");
const SOURCES_FILE = join(ROOT, "src", "data", "factcheck", "sources.json");
const MARKET_CATALOG_FILE = join(ROOT, "src", "data", "interlinking", "market-articles.json");

/* ─────────────────────────────────── обогащение: продукт, НПА, дедуп ──── */
// Три поля, которых не хватало в референс-таблице редактора (см. постмортем
// 2026-08-06): Продукт, Норма/дата, Дедуп+Ссылка Контура. Все три собираются
// детерминированно из уже существующих в репозитории справочников — без
// обращения к ИИ и без сетевых вызовов, чтобы рутина A0 осталась бесплатным
// Node-скриптом в GitHub Actions.

const productMap = existsSync(PRODUCT_MAP_FILE)
  ? JSON.parse(readFileSync(PRODUCT_MAP_FILE, "utf8")).clusters
  : {};

/** Кластер → продукт по справочнику product-mapping.json. Нет записи или
 * низкая уверенность источника не помешает — просто вернём null: лучше
 * пусто, чем угаданный продукт (тот же принцип, что у research-specialist
 * с номерами НПА). */
function productFor(cluster) {
  const entry = cluster ? productMap[cluster] : null;
  if (!entry || !entry.product) return { product: null, productLabel: null };
  return { product: entry.product, productLabel: entry.productLabel };
}

// Кластер → topic в npaWhitelist (см. TOPICS_BY_CATEGORY в
// audit-npa-references.mjs — тот же принцип, уже, потому что здесь только
// однозначные соответствия: «зачем гадать между пятью налоговыми нормами».
const CLUSTER_TO_NPA_TOPIC = {
  "ts-piot": "ts-piot",
  markirovka: "markirovka",
  "markirovka-2026": "markirovka",
  "ofd-fn": "kkt",
  merkuriy: "merkuriy",
  kkt: "kkt",
  egais: "egais",
  buhgalteriya: "buh",
  "otchetnost-edo": "edo-kedo",
  kadry: "kadry",
  nalogi: "nalogi",
  "nalogi-kassa": "kkt",
  roznica: "kkt",
  apteka: "markirovka",
};

let npaWhitelist = null;
function loadNpaWhitelist() {
  if (npaWhitelist !== null) return npaWhitelist;
  npaWhitelist = existsSync(SOURCES_FILE)
    ? JSON.parse(readFileSync(SOURCES_FILE, "utf8")).npaWhitelist
    : {};
  return npaWhitelist;
}

/** Предварительная норма для кластера — не замена research-specialist,
 * а подсказка редактору «в эту сторону смотреть». Стадия 1 /create-article
 * всё равно верифицирует номер заново перед тем, как он попадёт в статью. */
function npaHintFor(cluster) {
  const topic = CLUSTER_TO_NPA_TOPIC[cluster];
  if (!topic) return null;
  const wl = loadNpaWhitelist();
  for (const type of ["pp", "fz", "prikaz"]) {
    for (const [num, entry] of Object.entries(wl[type] ?? {})) {
      if (num === "note") continue;
      const candidates = Array.isArray(entry) ? entry : [entry];
      const match = candidates.find((e) => e?.topic === topic);
      if (match) {
        const label = { pp: "ПП", fz: "ФЗ", prikaz: "Приказ" }[type];
        return `${label} № ${num} (предв., уточнить в Стадии 1)`;
      }
    }
  }
  return null;
}

let marketCatalog = null;
function loadMarketCatalog() {
  if (marketCatalog !== null) return marketCatalog;
  marketCatalog = existsSync(MARKET_CATALOG_FILE)
    ? JSON.parse(readFileSync(MARKET_CATALOG_FILE, "utf8")).articles
    : [];
  return marketCatalog;
}

/** Дедуп против каталога kontur.ru/market — та же логика и порог, что у
 * check-market-duplication.mjs (Стадия 1 /create-article, шаг 2а). */
function marketDedupFor(topic) {
  const catalog = loadMarketCatalog();
  if (!catalog.length) return { dedup: "новая", konturLink: null };
  const queryTokens = tokenize(topic);
  let best = null;
  for (const article of catalog) {
    const score = jaccard(queryTokens, tokenize(article.title || ""));
    if (score >= 0.3 && (!best || score > best.score)) best = { ...article, score };
  }
  if (!best) return { dedup: "новая", konturLink: null };
  const verdict = best.score >= 0.6 ? "сузить угол" : "проверить пересечение";
  return { dedup: `${verdict} (${best.score.toFixed(2)})`, konturLink: best.url };
}

// Триггеры «инфоповода» — конкретная дата/событие, которое устареет и
// требует публикации к моменту, а не когда-нибудь. Без триггера считаем
// evergreen: эвристика, не замена редакторскому суждению.
const INFOPOVOD_RE = /\bс\s+\d{1,2}[.\s]|вступ|измен|нов(ые|ый|ая)\s+(правил|треб|закон|срок)|продли|отмен|перенес|штраф\s+вырос|повыс/i;
function typeFor(topic) {
  return INFOPOVOD_RE.test(topic) ? "infopovod" : "evergreen";
}

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
};
const DRY_RUN = process.argv.includes("--dry-run");
// 40 тем, а не 15: редактору нужен выбор, а не короткий список сверху
// частотности. Ниже по списку темы слабее, но это его решение, не наше —
// на 15 темах половина кластеров не попадала в таблицу вообще.
const LIMIT = parseInt(arg("limit", "40"), 10);
const MIN_COUNT = parseInt(arg("min-count", "50"), 10);
// Во сколько раз строже порог для абсолютной частотности, чем для diff-а.
// Рост с 40 до 300 показов — событие; 300 показов сами по себе — фон.
const DUMP_FLOOR_FACTOR = parseInt(arg("dump-floor-factor", "10"), 10);
// Минимум слов во фразе из выгрузки. Сортировка по абсолютной частоте
// иначе поднимает наверх навигационные однословники — «wildberries»,
// «ozon», «маркировка»: у них миллионы показов и нулевая пригодность как
// тема статьи. Информационный запрос почти всегда длиннее трёх слов.
const DUMP_MIN_WORDS = parseInt(arg("dump-min-words", "3"), 10);

/* ────────────────────────────────────────────── что уже покрыто ──── */

/** Ключи, по которым уже есть статья или запланированная тема. */
function coveredKeywords() {
  const covered = new Set();

  if (existsSync(PLAN_FILE)) {
    const plan = JSON.parse(readFileSync(PLAN_FILE, "utf8"));
    for (const row of plan.topics ?? plan.rows ?? []) {
      if (row.targetKeyword) covered.add(normalize(row.targetKeyword));
    }
  }

  if (existsSync(BLOG_DIR)) {
    for (const f of readdirSync(BLOG_DIR).filter((f) => /\.mdx?$/.test(f))) {
      const raw = readFileSync(join(BLOG_DIR, f), "utf8");
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) continue;
      // seo.keywords — список под отступом; берём всё до следующего
      // ключа верхнего уровня.
      const kw = fm[1].match(/keywords:\s*\n((?:\s+-\s+[^\n]+\n?)+)/);
      if (!kw) continue;
      for (const line of kw[1].match(/(?<=-\s)(.+)/g) ?? []) {
        covered.add(normalize(line.replace(/^["']|["']$/g, "")));
      }
    }
  }
  return covered;
}

/* ──────────────────────────────────────────── источник: Wordstat ──── */

/** Последний diff-json по каждому namespace (корень и вложенные). */
function latestDiffs() {
  if (!existsSync(DISC_DIR)) return [];
  const out = [];

  const collect = (base, ns) => {
    const diffs = join(base, "diffs");
    if (!existsSync(diffs)) return;
    const files = readdirSync(diffs)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    if (!files.length) return;
    const payload = JSON.parse(readFileSync(join(diffs, files[files.length - 1]), "utf8"));
    out.push({ ns, file: files[files.length - 1], payload });
  };

  collect(DISC_DIR, null);
  for (const name of readdirSync(DISC_DIR)) {
    const p = join(DISC_DIR, name);
    if (name === "diffs" || /^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    try {
      if (readdirSync(p)) collect(p, name);
    } catch {
      /* не каталог — пропускаем */
    }
  }
  return out;
}

/**
 * Обоснование «почему сейчас». Редактору нужен повод, а не голая цифра:
 * без него решение принимается вслепую.
 */
function reasonFor(item) {
  if (item.kind === "breakout") {
    return `пробила порог шума: ${item.prev} → ${item.now} показов в месяц (×${item.ratio.toFixed(1)})`;
  }
  if (item.kind === "rising") {
    return `рост частотности: ${item.prev} → ${item.now} показов в месяц (×${item.ratio.toFixed(1)})`;
  }
  if (item.kind === "growing" || item.kind === "trending" || item.kind === "growing+trending") {
    const fmt = (w) => {
      const pct = Math.round((w.ratio - 1) * 100);
      return `+${pct}% за последние ${w.weeks} нед. к предыдущим ${w.weeks}`;
    };
    if (item.short && item.trend) {
      // Сильнейший случай: тема растёт и прямо сейчас, и весь квартал.
      // Обе цифры важны отдельно — короткая доказывает срочность, длинная
      // доказывает, что это не разовый всплеск, который погаснет к статье.
      return `спрос растёт устойчиво: ${fmt(item.trend)}, и уже разгоняется — ${fmt(item.short)}`;
    }
    const w = item.short || item.trend;
    const now = Math.round(w.now);
    const label = item.short ? "спрос растёт" : "спрос растёт весь квартал";
    return `${label}: ${Math.round(w.prev)} → ${now} показов в неделю (${fmt(w)})`;
  }
  if (item.kind === "demand") {
    // Формулировка намеренно скромнее, чем у diff-кандидатов: здесь нет
    // сравнения с прошлой неделей, и выдавать «выросло» было бы неправдой.
    return `спрос ${item.count} показов в месяц, темы нет ни в плане, ни в блоге`;
  }
  // Кандидат сюда доходит только если не покрыт планом и блогом (проверка
  // covered выше по коду), поэтому «статьи нет» — не догадка, а факт
  // отбора. Раньше строка была голой («новая фраза в выдаче, N показов»),
  // и в таблице все свежие фразы выглядели одинаково, хотя отличались и
  // частотностью, и кластером.
  return `новая фраза в выдаче: ${item.count} показов в месяц, статьи по запросу нет${
    item.cluster ? `, кластер ${item.cluster}` : ""
  }`;
}

function candidatesFromDiffs(diffs) {
  const rows = [];
  for (const { ns, payload } of diffs) {
    for (const seed of payload.seeds ?? []) {
      const cluster = seed.cluster || null;
      for (const n of seed.diff?.NEW ?? []) {
        if (n.count < MIN_COUNT) continue;
        // Шумовой фильтр стоял только на пути дампов, а diff-кандидаты шли
        // мимо него — так «кассы смотреть онлайн» и «фильмы онлайн касс»
        // добрались до таблицы редактора. Порог слов здесь мягче (2):
        // diff-фразы короче дампных, и minWords=3 срезал бы живые темы.
        if (!isInformational(n.phrase, 2)) continue;
        rows.push({
          phrase: n.phrase, cluster, seed: seed.seed, ns,
          kind: "new", count: n.count, weight: n.count,
        });
      }
      for (const r of seed.diff?.RISING ?? []) {
        if (r.now < MIN_COUNT) continue;
        rows.push({
          phrase: r.phrase, cluster, seed: seed.seed, ns,
          kind: r.breakout ? "breakout" : "rising",
          prev: r.prev, now: r.now, ratio: r.ratio,
          // Прорыв снизу интереснее ровного роста той же величины:
          // это тема, которой на прошлой неделе фактически не было.
          weight: (r.now - r.prev) * (r.breakout ? 1.5 : 1),
        });
      }
    }
  }
  return rows;
}

/**
 * Кандидаты из последней выгрузки, без сравнения с прошлой неделей.
 *
 * Diff даёт лучший сигнал — «спрос вырос именно сейчас», — но требует двух
 * снапшотов, то есть недели ожидания. На первом прогоне и после любой
 * чистки истории diff-ов нет, а выгрузка на сотни сидов уже лежит. Без
 * этого источника рутина A0 в такие недели молчит, хотя данные есть.
 *
 * Сигнал слабее: берём абсолютную частотность, поэтому и порог выше —
 * иначе в бэклог польётся длинный хвост из десятков тысяч фраз.
 */
function candidatesFromDump() {
  if (!existsSync(DISC_DIR)) return [];
  const rows = [];
  const floor = MIN_COUNT * DUMP_FLOOR_FACTOR;

  const collect = (base, ns) => {
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
        if (p.count < floor) continue;
        if (!isInformational(p.phrase, DUMP_MIN_WORDS)) continue;
        rows.push({
          phrase: p.phrase,
          cluster: payload.cluster || null,
          seed: payload.seed,
          ns,
          kind: "demand",
          count: p.count,
          weight: p.count,
        });
      }
    }
  };

  collect(DISC_DIR, null);
  for (const name of readdirSync(DISC_DIR)) {
    if (name === "diffs" || /^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    const p = join(DISC_DIR, name);
    try {
      readdirSync(p);
      collect(p, name);
    } catch {
      /* не каталог — пропускаем */
    }
  }
  return rows;
}

/**
 * Порог роста, ниже которого не считаем сигналом. Одна планка для обоих
 * окон, независимо от их длины (3 недели или 16) — оба случая
 * означают структурный сдвиг, а не шум недельных колебаний.
 */
const GROWTH_THRESHOLD = 1.15;

/**
 * Кандидаты с посчитанной динамикой (enrich-candidates.mjs) — два разреза
 * одной истории, а не два запроса к API.
 *
 * Короткое окно (windowWeeks, по умолчанию 3) ловит «тронулось прямо
 * сейчас»: разослали письмо ФНС, вышло разъяснение, наступил сезон
 * отчётности. Длинное (trendWeeks, по умолчанию 12) ловит устойчивый
 * структурный рост, который короткое окно смазывает шумом — неделя-две
 * спада внутри трёхмесячного роста на короткой дистанции выглядят как
 * ничего не происходит. Тема с 5% роста в месяц три месяца подряд не даёт
 * ни одного недельного скачка и без длинного окна не попала бы в бэклог
 * никогда — а это как раз тема, где отставание от спроса накопилось
 * дольше всего.
 *
 * Если сработали оба сигнала — это не два кандидата, а один и самый
 * сильный: тема растёт и прямо сейчас, и весь квартал.
 *
 * cacheVersion фильтрует записи в устаревшем формате: до перехода на
 * недельную гранулярность рост считался только за квартал, а число
 * оттуда несравнимо с текущим. Не отфильтровать — значит показать в
 * одном бэклоге проценты, посчитанные по-разному, без предупреждения.
 */
function candidatesFromDynamics() {
  if (!existsSync(DYNAMICS_FILE)) return [];
  let payload;
  try {
    payload = JSON.parse(readFileSync(DYNAMICS_FILE, "utf8"));
  } catch {
    return [];
  }
  const rows = [];
  for (const it of payload.items ?? []) {
    if (it.cacheVersion !== 3) continue;

    const shortHit = it.growth && Number.isFinite(it.growth) && it.growth >= GROWTH_THRESHOLD;
    const trendHit = it.growthTrend && Number.isFinite(it.growthTrend) && it.growthTrend >= GROWTH_THRESHOLD;
    if (!shortHit && !trendHit) continue;

    const short = shortHit
      ? { ratio: it.growth, now: it.recent ?? it.count, prev: it.recent / it.growth, weeks: it.windowWeeks || 3 }
      : null;
    const trend = trendHit
      ? { ratio: it.growthTrend, now: it.recentTrend, prev: it.recentTrend / it.growthTrend, weeks: it.trendWeeks || 12 }
      : null;

    // Вес — прирост в показах на более сильном из сигналов: рост в
    // полтора раза на сотне запросов слабее роста на четверть у десяти
    // тысяч, независимо от того, короткое это окно или длинное.
    const strongest = short && trend
      ? (short.ratio >= trend.ratio ? short : trend)
      : (short || trend);

    rows.push({
      phrase: it.phrase,
      cluster: it.cluster || null,
      seed: it.seed,
      ns: it.ns,
      kind: short && trend ? "growing+trending" : short ? "growing" : "trending",
      short,
      trend,
      count: it.count,
      weight: (strongest.now - strongest.prev) * Math.min(strongest.ratio, 3),
    });
  }
  return rows;
}

/* ─────────────────────────────────────────────────────── сборка ──── */

const signalsPath = arg("signals");
let extraSignals = [];
if (signalsPath) {
  if (!existsSync(signalsPath)) {
    console.error(`Файл сигналов не найден: ${signalsPath}`);
    process.exit(1);
  }
  extraSignals = JSON.parse(readFileSync(signalsPath, "utf8"));
  if (!Array.isArray(extraSignals)) {
    console.error("--signals должен содержать массив тем");
    process.exit(1);
  }
}

const diffs = latestDiffs();

// Diff — основной источник. Выгрузка — запасной, включается когда diff-ов
// ещё нет: на первой неделе и после чистки истории.
const dynamics = diffs.length ? [] : candidatesFromDynamics();
// Сырая выгрузка — последний рубеж: она сортируется по абсолютной
// частоте и «почему сейчас» не объясняет. Берём, только если ни diff-ов,
// ни обогащённых кандидатов нет.
const dump = diffs.length || dynamics.length ? [] : candidatesFromDump();

if (dynamics.length) {
  console.log(`Diff-ов нет — беру рост из помесячной динамики: ${dynamics.length} растущих фраз.`);
}
if (!diffs.length && !dynamics.length && dump.length) {
  console.log(
    `Diff-ов нет (нужны два снапшота) — беру спрос из последней выгрузки: ` +
      `${dump.length} фраз от ${MIN_COUNT * DUMP_FLOOR_FACTOR} показов.`,
  );
}

if (!diffs.length && !dynamics.length && !dump.length && !extraSignals.length) {
  console.log(
    "Нет ни diff-ов, ни выгрузки, ни внешних сигналов.\n" +
      "Дождитесь прогона wordstat-workflow или передайте --signals.",
  );
  process.exit(0);
}

const covered = coveredKeywords();
const suppressionData = loadSuppressions();

const raw = [
  ...candidatesFromDiffs(diffs),
  ...dynamics,
  ...dump,
  ...extraSignals.map((s) => ({
    phrase: s.topic || s.phrase,
    cluster: s.cluster || null,
    kind: "signal",
    source: s.source || "monitor",
    note: s.note || null,
    // Дата события — то, чем инфоповод заменяет частотность: по ней
    // редактор понимает, к какому сроку тема должна выйти.
    eventDate: s.eventDate || s.date || null,
    weight: s.weight ?? 0,
  })),
];

const stats = { всего: raw.length, дубли: 0, покрыто: 0, заглушено: 0 };
const seen = new Set();
// Наборы основ уже принятых тем — для отсева вложенных формулировок.
const acceptedSets = [];
/* Параллельно acceptedSets: какой карточке кандидата соответствует набор
   основ. Нужен, чтобы близкий запрос не выбрасывался как дубль, а
   приклеивался к уже принятой теме — см. attachRelated ниже. Null там,
   где тема была принята к дедупу, но отсеяна дальше (покрыта планом или
   заглушена): приклеивать не к чему. */
const acceptedCards = [];
const candidates = [];
// Сколько тем одного кластера пускаем в список. Сортировка идёт по весу, а
// вес — это частотность; поэтому один урожайный кластер (в прогоне 09.08 —
// kkt) занимал половину таблицы, а эквайринг, оборудование и общепит не
// попадали вовсе. Редактору нужен обзор спроса, а не топ одного кластера.
// 0 отключает ограничение.
const PER_CLUSTER = parseInt(arg("per-cluster", "4"), 10);
const perCluster = new Map();

/**
 * Вложенный дубль: набор основ одной темы целиком содержится в другой.
 * «модуль честный знак» ⊂ «локальный модуль честный знак» — это одна тема
 * в трёх видах, и в прошлом прогоне она заняла три места из сорока.
 * Ключ схлопывания такое не ловит: наборы слов разные.
 */
function isNested(tokens) {
  const a = new Set(tokens);
  return acceptedSets.some((b) => {
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    for (const t of small) if (!big.has(t)) return false;
    return true;
  });
}

/**
 * Перестановочный дубль: тот же запрос другими словами и в другом порядке.
 * Вложенность его не ловит — наборы основ пересекаются, но ни один не
 * содержит другой целиком: «маркировка товара знаки», «честный знак на
 * товаре» и «маркировать честный знак» — это одна тема в трёх видах.
 *
 * На списке в 15 тем такое почти не встречалось, на 40–50 съедало до
 * трети мест: чем длиннее список, тем глубже он черпает переформулировки
 * одного и того же запроса. Редактор при этом видит не выбор, а свою же
 * работу по вычистке дублей за скриптом.
 *
 * Порог 0.5 подобран по реальным выгрузкам: он схлопывает перестановки и
 * не трогает соседние темы одного кластера — «накладная егаис» и
 * «остатки егаис» дают 0.33 и остаются обе.
 */
const NEAR_DUP = parseFloat(arg("near-dup", "0.4"));
// Порог склейки строже порога схлопывания: между 0.4 и 0.55 запрос — дубль
// и просто выбрасывается, выше 0.55 — та же тема другими словами, её
// частотность имеет смысл суммировать.
const ATTACH_MIN = parseFloat(arg("attach-min", "0.5"));
const MAX_RELATED = parseInt(arg("max-related", "4"), 10);
function nearDuplicateIndex(tokens) {
  if (!(NEAR_DUP > 0)) return { idx: -1, score: 0 };
  const a = new Set(tokens);
  let best = { idx: -1, score: 0 };
  acceptedSets.forEach((b, i) => {
    const score = jaccard(a, b);
    if (score >= NEAR_DUP && score > best.score) best = { idx: i, score };
  });
  return best;
}

/**
 * Связка: близкий запрос не выбрасывается, а приклеивается к принятой теме.
 *
 * «эквайринг для ип» и «эквайринг для ип тарифы» — одна статья, но два
 * запроса, и в ручном списке редакции они и стояли одной строкой с общей
 * частотностью 8 226 + 7 585. Скрипт же схлопывал второй как дубль и терял
 * половину спроса: тема выглядела вдвое слабее, чем она есть, и уезжала
 * ниже по списку или вылетала из полосы.
 *
 * Приклеенные запросы видны редактору отдельным полем: по ним он понимает,
 * какие формулировки статья должна закрыть, не выискивая их сам.
 */
function attachRelated(idx, item, score) {
  const card = acceptedCards[idx];
  if (!card) return false;
  // Приклеиваем только по-настоящему близкое и не больше четырёх штук.
  // Первая версия брала всё, что проходило порог схлопывания, — и одна
  // тема «маркировка товара» собрала 55 запросов и 106 тысяч показов,
  // проглотив половину кластера. Это уже не связка, а подмена: редактор
  // видел бы одну строку вместо десятка разных статей.
  if (score < ATTACH_MIN) return false;
  const w = item.weight ?? 0;
  if (!w) return true;
  card.relatedQueries = card.relatedQueries ?? [];
  if (card.relatedQueries.length >= MAX_RELATED) return false;
  if (card.relatedQueries.some((r) => r.query === item.phrase)) return true;
  card.relatedQueries.push({ query: item.phrase, wordstat: w });
  card.wordstatTotal = (card.wordstatTotal ?? card.wordstat ?? 0) + w;
  stats["связок склеено"] = (stats["связок склеено"] ?? 0) + 1;
  return true;
}

/* Полосы частотности и доли мест под каждую.
 *
 * Сортировка по весу — это сортировка по частотности, и без квот список
 * получался однородно широким: медиана 5811, минимум 1592, ни одной темы
 * ниже тысячи. Ручной список редакции (40 тем, август 2026) выглядел
 * иначе: медиана 4451, минимум 51, и 15% мест занимали узкие
 * коммерческие запросы — «касса для магазина одежды», «касса для аптеки»,
 * «учёт остатков в магазине». Они дают мало показов и много продаж, и
 * механическим отбором по частоте не достаются никогда.
 *
 * Доли повторяют то распределение: широкие темы задают охват, средние
 * несут основную массу, нишевые — конверсию. Полоса недобрала — места
 * уходят соседям, список всё равно будет полным.
 */
const BANDS = [
  { name: "широкие",  min: 20000, share: 0.12 },
  { name: "высокие",  min: 5000,  share: 0.28 },
  { name: "средние",  min: 1000,  share: 0.45 },
  { name: "низкие",   min: 200,   share: 0.05 },
  { name: "нишевые",  min: 0,     share: 0.10 },
];
const USE_BANDS = arg("bands", "on") !== "off";
const bandOf = (w) => BANDS.find((b) => (w ?? 0) >= b.min) ?? BANDS[BANDS.length - 1];
const bandQuota = new Map(BANDS.map((b) => [b.name, Math.max(1, Math.round(LIMIT * b.share))]));
const bandTaken = new Map(BANDS.map((b) => [b.name, 0]));
const deferred = [];

/* Инфоповоды идут первыми и вне полос частотности.
 *
 * У темы «с апреля 2026 продажи пива уходят в ЕГАИС из Честного знака
 * автоматически» частотности нет вовсе: запрос ещё не сформировался,
 * потому что событие только объявили. Сортировка по спросу ставит такую
 * тему в самый конец, а полоса «нишевые» отдаёт ей место по остаточному
 * принципу — то есть механика гарантированно теряет ровно тот класс тем,
 * ради которых у редакции есть дедлайн.
 *
 * Поэтому сигналы мониторинга отбираются до общего пула и в пределах
 * своей квоты. Ноль сигналов — квота просто не расходуется. */
const SIGNAL_QUOTA = parseInt(arg("signals-quota", "6"), 10);
const signalRows = raw.filter((r) => r.kind === "signal");
const demandRows = raw.filter((r) => r.kind !== "signal");

const ordered = demandRows.sort(
  (a, b) => b.weight * priorityMultiplier(b.cluster) - a.weight * priorityMultiplier(a.cluster),
);

/* Два прохода. Первый берёт темы в рамках квот своей полосы, второй
 * добивает список отложенными — иначе при бедной выгрузке в нишевых
 * полосах бэклог оказался бы короче лимита. */
function tryAccept(item, respectBands) {
  if (candidates.length >= LIMIT) return;
  // dedupeKey, а не normalize: normalize схлопывает только регистр и
  // пробелы, из-за чего переформулировки одного запроса проходили как
  // разные темы.
  const key = dedupeKey(item.phrase);
  if (!key) return;

  if (seen.has(key)) { stats.дубли++; return; }

  const tokens = stemTokens(item.phrase);
  if (isNested(tokens)) { stats.дубли++; return; }
  const near = nearDuplicateIndex(tokens);
  if (near.idx >= 0) {
    if (!attachRelated(near.idx, item, near.score)) stats.дубли++;
    return;
  }

  const ck = item.cluster || "—";
  if (PER_CLUSTER > 0 && (perCluster.get(ck) ?? 0) >= PER_CLUSTER) {
    stats["сверх квоты кластера"] = (stats["сверх квоты кластера"] ?? 0) + 1;
    return;
  }

  const band = bandOf(item.weight);
  if (respectBands && bandTaken.get(band.name) >= bandQuota.get(band.name)) {
    // Не отбрасываем: если полосы окажутся бедными, эта тема ещё
    // понадобится во втором проходе.
    deferred.push(item);
    stats["ждут места в полосе"] = (stats["ждут места в полосе"] ?? 0) + 1;
    return;
  }
  bandTaken.set(band.name, bandTaken.get(band.name) + 1);
  perCluster.set(ck, (perCluster.get(ck) ?? 0) + 1);

  seen.add(key);
  acceptedSets.push(new Set(tokens));
  acceptedCards.push(null); // заполним ниже, если тема дойдёт до карточки

  if (covered.has(key)) { stats.покрыто++; return; }

  const hit = isSuppressed(item.phrase, suppressionData);
  if (hit) {
    stats.заглушено++;
    return;
  }

  const { product, productLabel } = productFor(item.cluster);
  const { segment, segmentLabel } = segmentFor(item.cluster);
  const { dedup, konturLink } = marketDedupFor(item.phrase);

  const card = {
    topic: item.phrase,
    targetKeyword: item.phrase,
    cluster: item.cluster,
    // Кластеры Контур.Маркета (product-mapping.json + ekvairing/oborudovanie)
    // весят в 1.5 раза больше при сортировке (priority-clusters.mjs) — поле
    // видно и в JSON, чтобы это было заметно не только по итоговому
    // порядку, но и при разборе кандидатов вручную или в рутине A0.
    priorityCluster: priorityMultiplier(item.cluster) > 1,
    source: item.kind === "signal" ? item.source : `wordstat:${item.ns ?? "root"}`,
    why: item.kind === "signal" ? (item.note ?? "сигнал мониторинга") : reasonFor(item),
    metrics: item.kind === "signal"
      ? null
      : { kind: item.kind, prev: item.prev ?? null, now: item.now ?? item.count, ratio: item.ratio ?? null },
    wordstat: item.kind === "signal" ? null : (item.now ?? item.count ?? null),
    product,
    productLabel,
    segment,
    segmentLabel,
    type: item.kind === "signal" ? "infopovod" : typeFor(item.phrase),
    normHint: item.eventDate ? `событие ${item.eventDate}` : npaHintFor(item.cluster),
    dedup,
    konturLink,
    decision: "",
    author: "",
    declineReason: "",
  };
  candidates.push(card);
  // Карточка встала — теперь к ней можно приклеивать близкие запросы.
  acceptedCards[acceptedCards.length - 1] = card;
}

/* Сначала инфоповоды в пределах своей квоты — у них нет спроса, по
   которому их можно было бы отранжировать честно, зато есть дата. */
let signalsTaken = 0;
for (const item of signalRows) {
  if (signalsTaken >= SIGNAL_QUOTA) break;
  const before = candidates.length;
  tryAccept(item, false);
  if (candidates.length > before) signalsTaken++;
}
stats["инфоповодов"] = signalsTaken;

/* Дальше спрос: проход с квотами полос, затем добор отложенными. */
for (const item of ordered) tryAccept(item, USE_BANDS);
for (const item of deferred) tryAccept(item, false);

/* Суммарный спрос — в обоснование. Число в колонке «Wordstat» остаётся
   частотностью основного запроса, иначе оно разойдётся с тем, что редактор
   увидит в самом Wordstat; а сумма по связке объясняет, почему тема стоит
   выше соседей. */
for (const c of candidates) {
  if (!c.relatedQueries?.length) continue;
  const total = c.wordstatTotal ?? c.wordstat;
  c.why = `${c.why}; со связанными запросами ${total} показов по ${c.relatedQueries.length + 1} формулировкам`;
}

const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  sources: diffs.map((d) => `${d.ns ?? "root"}/${d.file}`),
  limit: LIMIT,
  minCount: MIN_COUNT,
  stats,
  candidates,
};

console.log(`Кандидатов на входе: ${stats.всего}`);
console.log(`  дублей схлопнуто:   ${stats.дубли}`);
console.log(`  уже покрыто:        ${stats.покрыто}`);
console.log(`  заглушено отказами: ${stats.заглушено}`);
console.log(`В бэклог: ${candidates.length} (лимит ${LIMIT})`);

for (const c of candidates.slice(0, 10)) {
  console.log(`  • ${c.topic}  [${c.cluster ?? "—"}] — ${c.why}`);
}

if (DRY_RUN) {
  console.log("\nDry-run: файл не записан.");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`\n✓ ${OUT.replace(ROOT + "/", "")}`);
}
