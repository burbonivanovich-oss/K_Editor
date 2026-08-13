#!/usr/bin/env node
/**
 * Машина состояний редакционного цикла.
 *
 * Рутины запускаются в свежих сессиях без памяти — всё состояние цикла
 * живёт здесь, в src/data/editorial-cycle.json. Агенты не редактируют
 * JSON руками, только через этот CLI: так состояние не разъезжается.
 *
 * Рабочее место редактора — папка Google Drive (таблица + доки), см.
 * scripts/drive-sync.mjs. Здесь хранится зеркало того, что в таблице,
 * плюс связь тем с файлами репозитория.
 *
 * Состояния цикла:
 *   idle            цикла нет, можно запускать /cycle-plan
 *   awaiting_review план в таблице, ждём согласования редактора
 *   running         план одобрен, статьи пишутся и вычитываются
 *   done            все темы цикла выпущены или сняты
 *
 * Статусы темы (совпадают с колонкой «Статус» в таблице):
 *   planned   в плане, ждёт очереди
 *   writing   бот пишет прямо сейчас
 *   review    док готов, вычитывает редактор
 *   accepted  редактор принял, ждёт импорта в репозиторий
 *   released  импортировано и выпущено
 *   dropped   снято редактором
 *
 * Владелец темы:
 *   bot     пишет Claude
 *   editor  «пишем сами» — бот готовит бриф и структуру, текст пишут люди
 *
 * Использование:
 *   node scripts/cycle-state.mjs get [--json]
 *   node scripts/cycle-state.mjs init --cycle 2026-08 --plan plan.json \
 *        --sheet-id <id> --sheet-url <url> --folder-id <id>
 *   node scripts/cycle-state.mjs apply-decisions --file pull.json
 *   node scripts/cycle-state.mjs can-start-batch
 *   node scripts/cycle-state.mjs next-batch [--size 3]
 *   node scripts/cycle-state.mjs start-batch --slugs a,b,c
 *   node scripts/cycle-state.mjs to-review --slug a --doc-id <id> --doc-url <url>
 *   node scripts/cycle-state.mjs accept --slug a
 *   node scripts/cycle-state.mjs release --slug a
 *   node scripts/cycle-state.mjs set-state running
 *   node scripts/cycle-state.mjs reset --force
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { slugify } from './lib/slugify.mjs';
// Буквы колонок берём из общего модуля, а не зашиваем. Зашитые «I/J/K»
// пережили слияние бэклога и плана в одну вкладку и стали писать статус
// в «Приоритет», ссылку на док — в «Зачем сейчас», ID — в «Норма/дата».
import { COL, RU_STATUS, isPriority, parseAdaptations } from './lib/sheet-columns.mjs';
// Память об отказах редактора. Импортируется здесь, а не только в
// generate-backlog: тема попадает в таблицу двумя дверями, и вторая до
// 12.08.2026 стояла нараспашку — см. add-candidates.
import { isSuppressed, load as loadSuppressions } from './topics/suppressions.mjs';
// Ячейка «Тема» содержит задачу, а не только заголовок: редакция пишет
// туда «Актуализировать статью <URL> …» вместе с инструкцией. Разбор —
// в lib/update-task.mjs, там же история, почему он понадобился.
import { parseTopicCell } from './lib/update-task.mjs';
// Текст из таблицы — данные, не команды. Рутины автономны и имеют доступ
// к репозиторию; доступ к таблице шире доступа к репозиторию. См. шапку
// lib/untrusted-text.mjs.
import { scanForInstructions, describeFindings, isAllowedSource } from './lib/untrusted-text.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
// Переопределяется в тестах (cycle-state.test.mjs), чтобы гонять машину
// состояний на временном файле, а не на реальном src/data/editorial-cycle.json.
const STATE_PATH = process.env.CYCLE_STATE_PATH || join(__dir, '..', 'src/data/editorial-cycle.json');

const STATES = ['idle', 'awaiting_review', 'running', 'done'];
/* «candidate» — тема, по которой редактор ещё не решил. До 11.08.2026
 * кандидаты жили в отдельной таблице бэклога и в состояние цикла не
 * попадали вовсе: решение по ним разбирала рутина и вручную переносила
 * тему в план. Теперь строка одна на весь путь, поэтому и статус нужен. */
const TOPIC_STATUSES = ['candidate', 'planned', 'writing', 'review', 'accepted', 'released', 'dropped'];

// Значения колонки «Решение» в таблице (drive-sync.mjs DECISIONS), которые
// apply-decisions умеет разбирать. Список должен совпадать с DECISIONS
// там — источники разные, ручной синхронизации ничего не заменяет.
const KNOWN_DECISIONS = new Set([
  'убрать', 'одобрено', 'написать сейчас', 'принято',
  /* Текст не годится — писать заново. Возвращено 13.08.2026 по просьбе
   * редакции; 12.08.2026 «нужен рерайт» отсюда убирали, считая, что путь
   * обновления закрывается причиной отказа «уже покрыто другой статьёй».
   * Оказалось, это разные вещи: тогда речь шла об обновлении статьи, а
   * здесь — о том, что конкретный текст не подошёл, а тема нужна. */
  'переписать статью',
  // Заказ на бриф для дизайнера: обложка и иллюстрации к уже написанному
  // тексту. Статус темы не меняет — статья как была на вычитке или принята,
  // так и остаётся; это параллельный артефакт, а не стадия цикла.
  'нужно тз дизайнеру',
]);

/* Слова, которыми решения ставили до 11.08.2026. Читаются по-прежнему:
 * в живых таблицах они уже проставлены, и молчаливое «решение не
 * распознано» означало бы потерянную работу редактора. В выпадающих
 * списках их больше нет — это совместимость, а не второй словарь.
 *
 * Правило, из которого выросли эти замены: одно слово — одно действие во
 * всех таблицах. «Убрать» снимает тему и в бэклоге, и в плане, поэтому
 * слово общее. «Одобрено» же означало разное («взять в план» против
 * «вернуть боту»), поэтому в плане оно заменено, а не унифицировано. */
const PLAN_DECISION_SYNONYMS = new Map([
  ['согласовано', 'одобрено'],
  ['не согласовано', 'убрать'],
  ['отклонено', 'убрать'],
  ['снять', 'убрать'],
  // Как это называли до появления значения в списке.
  ['нужен рерайт', 'переписать статью'],
  ['переписать', 'переписать статью'],
  ['рерайт', 'переписать статью'],
]);

const EMPTY = {
  cycleId: null,
  state: 'idle',
  createdAt: null,
  updatedAt: null,
  drive: { folderId: null, sheetId: null, sheetUrl: null, folderUrl: null },
  batchSize: 3,
  maxInReview: 6,   // потолок очереди редактора: 2 батча по 3
  pausedUntil: null, // «ПАУЗА до дд.мм.гггг» в B2 — новые батчи не стартуют
  plan: [],
  batches: [],
  log: [],
};

function load() {
  if (!existsSync(STATE_PATH)) return structuredClone(EMPTY);
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return { ...structuredClone(EMPTY), ...raw, drive: { ...EMPTY.drive, ...(raw.drive || {}) } };
  } catch (e) {
    die(`editorial-cycle.json повреждён: ${e.message}. Почини вручную или запусти reset --force.`);
  }
}

function save(s, event) {
  s.updatedAt = new Date().toISOString();
  if (event) s.log = [...(s.log || []), { at: s.updatedAt, event }].slice(-60);
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n');
}

function die(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}

/* Каталог статей Маркета — из него берётся настоящий заголовок статьи,
 * которую просят актуализировать. Читается лениво и один раз: нужен
 * только при разборе ячейки, а файл на 1348 записей. */
let _catalog = null;
function marketCatalog() {
  if (_catalog) return _catalog;
  const p = join(__dir, '..', 'src/data/interlinking/market-articles.json');
  try { _catalog = JSON.parse(readFileSync(p, 'utf8')).articles || []; } catch { _catalog = []; }
  return _catalog;
}

/** Ячейка «Тема» → поля темы. Общее место для обеих дверей: тему заводит
 *  и add-candidates (бот), и apply-decisions (редактор вписал руками). */
function taskFields(cell) {
  const t = parseTopicCell(cell, { catalog: marketCatalog() });
  /* Просьба редактора остаётся просьбой и выполняется как редакционная.
   * Но если в ней есть обороты, адресованные процессу, а не тексту, —
   * тема помечается, и рутина показывает это владельцу вместо того,
   * чтобы исполнять. */
  const suspect = scanForInstructions(t.brief || t.raw);
  /* Ссылку на актуализацию загружает автономная сессия и читает целиком.
   * Домен вне списка — не отказ в работе, а отказ грузить автоматически:
   * содержимое чужой страницы иначе попадает в контекст процесса с
   * доступом к репозиторию. */
  const fetchable = t.sourceUrl ? isAllowedSource(t.sourceUrl) : null;
  /* Опорные ссылки редактор даёт сколько угодно, и процедура велит на
   * них опираться — значит их тоже загружает автономная сессия. Проверка
   * одного sourceUrl оставляла дыру ровно там, где ссылок больше всего. */
  const blockedRefs = (t.refUrls || []).filter((u) => !isAllowedSource(u));
  return {
    title: t.title,
    kind: t.kind,
    brief: t.brief || '',
    ...(suspect.length ? { suspectedInstructions: describeFindings(suspect) } : {}),
    ...(fetchable === false ? { sourceNotFetchable: 'домен вне списка разрешённых — открыть вручную, автоматически не загружаем' } : {}),
    ...(blockedRefs.length ? { refUrlsNotFetchable: blockedRefs } : {}),
    sourceUrl: t.sourceUrl,
    sourceTitle: t.sourceTitle,
    refUrls: t.refUrls,
    rawTopic: t.raw,
  };
}

const count = (s, st) => s.plan.filter((t) => t.status === st).length;
const byStatus = (s, st) => s.plan.filter((t) => t.status === st);
const find = (s, slug) => s.plan.find((t) => t.slug === slug);

// Единственное определение занятости очереди редактора — writing+review.
// Раньше can-start-batch/next-batch считали ёмкость только по review
// (см. историю ALLOWED_TRANSITIONS ниже), а transitionTopic — по
// writing+review: can-start-batch мог честно пообещать место, которое
// start-batch затем отклонял, потому что писавшиеся темы (writing) уже
// заняли часть потолка, а предварительная проверка их не видела.
const occupiedCount = (s) => count(s, 'writing') + count(s, 'review');

const today = () => new Date().toISOString().slice(0, 10);

/** Сколько дней тема ждёт редактора. Нет отметки — считаем нулём: тема
 *  попала в review до того, как отметку начали ставить. */
function waitedDays(t) {
  if (!t.reviewSince) return 0;
  const ms = Date.parse(today()) - Date.parse(t.reviewSince);
  return Math.max(0, Math.round(ms / 86400000));
}

/** Очередь вычитки в том порядке, в каком её стоит разбирать: сначала то,
 *  что ждёт дольше, при равном возрасте — по приоритету темы. */
function waitingTopics(s) {
  const rank = { P0: 0, P1: 1, P2: 2 };
  return s.plan
    .filter((t) => t.status === 'review')
    .sort((a, b) =>
      waitedDays(b) - waitedDays(a) ||
      (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1));
}

// Разрешённые переходы статуса темы. Раньше status менялся напрямую
// (t.status = ...) в пяти разных местах — легко добавить шестое и забыть
// про инвариант очереди, что и произошло: to-review для тем «пишем сами»
// никогда не проверял потолок вообще, а start-batch проверял только
// review, не writing (можно было запустить два батча подряд, пока первый
// ещё не дошёл до review, и превысить maxInReview в момент, когда оба
// одновременно попадут в review).
/* Возврат в planned из writing/review/accepted — решение «переписать
 * статью»: текст не подошёл, а тема нужна. Это единственный обратный ход
 * в машине, и он освобождает место в очереди редактора, а не занимает,
 * поэтому потолку не противоречит. Из released обратного хода нет: текст
 * уже у принимающего проекта, там это актуализация, а не рерайт. */
const ALLOWED_TRANSITIONS = {
  candidate: new Set(['planned', 'dropped']),
  planned: new Set(['writing', 'review', 'dropped']),
  writing: new Set(['review', 'planned', 'dropped']),
  review: new Set(['accepted', 'released', 'planned', 'dropped']),
  accepted: new Set(['released', 'planned', 'dropped']),
  released: new Set(),
  dropped: new Set(),
};

/**
 * Единственная точка, где меняется t.status. Проверяет допустимость
 * перехода и инвариант очереди редактора: writing + review не должно
 * превышать maxInReview. Возврат в writing/review — единственные
 * переходы, увеличивающие эту сумму (writing→review сумму не меняет:
 * тема покидает writing и занимает review тем же слотом), поэтому
 * проверка нужна только после входа в один из этих двух статусов.
 * При нарушении — откат и { ok: false, error }.
 */
function transitionTopic(s, slug, target) {
  const t = find(s, slug);
  if (!t) return { ok: false, error: `темы "${slug}" нет в плане` };
  if (!TOPIC_STATUSES.includes(target)) return { ok: false, error: `неизвестный статус "${target}"` };
  if (!ALLOWED_TRANSITIONS[t.status]?.has(target)) {
    return { ok: false, error: `тема "${slug}": переход ${t.status} → ${target} не разрешён` };
  }
  const from = t.status;
  t.status = target;
  if (target === 'writing' || target === 'review') {
    const occupied = occupiedCount(s);
    if (occupied > s.maxInReview) {
      t.status = from;
      return {
        ok: false,
        error: `тема "${slug}": потолок очереди — пишется+на вычитке стало бы ${occupied}/${s.maxInReview}`,
      };
    }
  }
  return { ok: true, from, to: target };
}


const cmd = process.argv[2];
const s = load();

switch (cmd) {
  /* ---------------------------------------------------------------- get */
  case 'get': {
    /* Одна тема целиком. Нужна перед работой над ней: у задачи на
     * актуализацию половина смысла лежит не в заголовке, а в полях
     * sourceUrl/brief/refUrls, и пересказывать их в промпте нельзя —
     * просьбу редактора выполняют дословно. */
    const one = arg('slug');
    if (one) {
      const t = find(s, one);
      if (!t) die(`темы "${one}" нет в плане`);
      console.log(JSON.stringify(t, null, 2));
      break;
    }
    if (process.argv.includes('--json')) { console.log(JSON.stringify(s, null, 2)); break; }
    const own = s.plan.filter((t) => t.owner === 'editor' && !['released', 'dropped'].includes(t.status)).length;
    console.log(`Цикл:       ${s.cycleId || '—'}`);
    console.log(`Состояние:  ${s.state}`);
    console.log(`Таблица:    ${s.drive.sheetUrl || '—'}`);
    console.log(`Папка:      ${s.drive.folderUrl || '—'}`);
    console.log(`Тем:        ${s.plan.length}`);
    console.log(`  в плане    ${count(s, 'planned')}`);
    console.log(`  пишется    ${count(s, 'writing')}`);
    console.log(`  на вычитке ${count(s, 'review')}`);
    console.log(`  принято    ${count(s, 'accepted')}`);
    console.log(`  выпущено   ${count(s, 'released')}`);
    console.log(`  снято      ${count(s, 'dropped')}`);
    console.log(`Очередь редактора: пишется+на вычитке ${occupiedCount(s)}/${s.maxInReview} — именно эта сумма ограничена потолком, не «на вычитке» отдельно.`);
    if (own) console.log(`Пишет редактор сам: ${own}`);
    break;
  }

  /* --------------------------------------------------------------- init */
  case 'init': {
    if (!['idle', 'done'].includes(s.state)) {
      die(`цикл ${s.cycleId} уже идёт (${s.state}). Заверши его или запусти reset --force.`);
    }
    const planPath = arg('plan');
    if (!planPath || !existsSync(planPath)) die('нужен --plan <файл с темами>');
    const topics = JSON.parse(readFileSync(planPath, 'utf8'));
    if (!Array.isArray(topics) || !topics.length) die('план пуст или не массив');

    const next = structuredClone(EMPTY);
    next.cycleId = arg('cycle') || new Date().toISOString().slice(0, 7);
    next.state = 'awaiting_review';
    next.createdAt = new Date().toISOString();
    /* Лимиты наследуются от предыдущего цикла, а не сбрасываются в
     * дефолт: их меняет владелец под темп редакции (set-limits), и
     * новый месяц не повод молча вернуть старое значение. */
    next.batchSize = Number(arg('batch-size', s.batchSize ?? 3));
    next.maxInReview = Number(arg('max-in-review', s.maxInReview ?? 6));
    next.drive = {
      sheetId: arg('sheet-id', null),
      sheetUrl: arg('sheet-url', null),
      folderId: arg('folder-id', null),
      folderUrl: arg('folder-url', null),
    };
    /* Разбор задачи — на всех трёх дверях, а не только на двух. Тема
     * входит в цикл через init (план месяца), add-candidates (ресёрч и
     * очередь актуализации) и apply-decisions (редактор вписал руками).
     * Разбирать только там, где вспомнилось, — это гарантия, что задача
     * на актуализацию рано или поздно войдёт необработанной. */
    next.plan = topics.map((t, i) => {
      const task = taskFields(t.title);
      return {
      ...task,
      slug: t.slug || slugify(task.title),
      priority: t.priority || 'P1',
      cluster: t.cluster || '',
      targetKeyword: t.targetKeyword || '',
      rationale: t.rationale || '',
      row: 5 + i,           // строка в таблице
      owner: t.who === 'пишем сами' ? 'editor' : 'bot',
      // Статус берётся из входного файла: список из ресёрча приходит
      // кандидатами, список из уже одобренного — сразу «в плане». По
      // умолчанию «в плане» — так вёл себя init до появления кандидатов,
      // и вызовы, которые про них не знают, не должны менять поведение.
      status: TOPIC_STATUSES.includes(t.status) ? t.status
        : (process.argv.includes('--as-candidates') ? 'candidate' : 'planned'),
      // Незакрытые статьи переезжают в новый месяц вместе со ссылками на
      // доки. Раньше init всегда ставил null: при переносе месяца связь
      // темы с готовым текстом терялась молча, а сам док оставался в
      // Drive — найти его можно было только глазами по названию.
      docId: t.docId || null,
      docUrl: t.docUrl || null,
      seenComments: [],
      };
    });

    save(next, `init ${next.cycleId}: ${topics.length} тем`);
    console.log(`✅ Цикл ${next.cycleId}: ${topics.length} тем, состояние awaiting_review`);
    break;
  }

  /* --------------------------------------------- apply-decisions (из таблицы) */
  /* Принимает вывод `drive-sync.mjs pull` и сверяет его с состоянием.        */
  case 'apply-decisions': {
    const file = arg('file');
    if (!file || !existsSync(file)) die('нужен --file <вывод drive-sync pull>');
    const pull = JSON.parse(readFileSync(file, 'utf8'));
    const changes = {
      approved: false, dropped: [], toEditor: [], toBot: [], accepted: [],
      approved_topics: [], urgent: [],
      // Решение «переписать статью»: текст не подошёл, тема возвращается
      // в план. Значение убирали из списка 12.08.2026 и вернули
      // 13.08.2026 — см. KNOWN_DECISIONS, там разобрано почему.
      rewrite: [],
      // Заказы на адаптацию под каналы — колонка «Адаптация».
      adaptations: [],
      /* Ячейки, текст которых адресован процессу, а не статье. Рутина
       * такие не исполняет — показывает владельцу. */
      suspectedInstructions: [],
      notes: [], added: [], missing: [], unrecognized: [], designBrief: [],
    };

    /* Пауза. Единственным способом остановить конвейер был потолок
     * очереди: редактор уходил в отпуск, не разбирал вычитку, статьи
     * копились до шести и вставали — а по возвращении сваливались разом.
     * Теперь это говорится прямо, в той же ячейке B2:
     *   «ПАУЗА до 20.08.2026» или просто «ПАУЗА» (тогда на две недели).
     * Снимается возвратом «ОДОБРЕН». Пауза не отменяет разбор решений и
     * ответы на комментарии — она останавливает только новые батчи. */
    const pause = (pull.approval || '').match(/^пауза(?:\s+до\s+(\d{2})\.(\d{2})\.(\d{4}))?/i);
    if (pause) {
      const until = pause[1]
        ? `${pause[3]}-${pause[2]}-${pause[1]}`
        : new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
      if (s.pausedUntil !== until) {
        s.pausedUntil = until;
        changes.paused = until;
      }
    } else if (s.pausedUntil) {
      s.pausedUntil = null;
      changes.resumed = true;
    }

    // Согласование плана целиком
    if (/^ОДОБРЕН/i.test(pull.approval || '') && s.state === 'awaiting_review') {
      s.state = 'running';
      changes.approved = true;
    }
    if (/^отклон/i.test(pull.approval || '')) changes.rejected = true;

    for (const row of pull.topics || []) {
      // Сопоставляем по стабильному slug (скрытая колонка K, пишет только
      // бот) — это первичный ключ. Номер строки после вставки/удаления
      // строки редактором сдвигается: у темы, которая физически осталась
      // на месте, row.row в новом чтении может совпасть с t.row другой
      // темы, и решение применится не туда. Slug такого сдвига не знает.
      // Если slug в строке есть, но ни на одну тему не сматчился — это
      // не повод падать на row/title: тот же класс ошибки, только через
      // чужой (протухший) slug вместо номера строки. Row/title — только
      // для строк без slug вообще: тема только что добавлена редактором
      // и не прошла sheet-sync, либо это цикл, начатый до колонки K.
      let t = row.slug
        ? s.plan.find((x) => x.slug === row.slug)
        : s.plan.find((x) => x.row === row.row) || s.plan.find((x) => x.title === row.title);

      if (!t) {
        // Редактор дописал тему прямо в таблицу
        if (!row.title?.trim()) continue;
        const task = taskFields(row.title);
        const slug = slugify(task.title);
        if (s.plan.some((x) => x.slug === slug)) continue;
        t = {
          slug, ...task, priority: row.priority || 'P1',
          cluster: row.cluster || '', targetKeyword: row.targetKeyword || '',
          rationale: row.rationale || 'добавлено редактором',
          row: row.row, owner: 'bot', status: 'planned',
          docId: null, docUrl: null, seenComments: [],
        };
        s.plan.push(t);
        changes.added.push(t.title);
      }

      /* Заголовок переписываем только если редактор правда тронул ячейку.
       *
       * Сравнивать нужно с сырым текстом ячейки (rawTopic), а не с
       * заголовком темы: ячейка «Актуализировать статью https://…»
       * никогда не равна разобранному «Актуализация: Как работать в
       * ЕГАИС» — и до 13.08.2026 каждый прогон рутины B (пять раз в
       * день) затирал нормальный заголовок обратно инструкцией. */
      if (row.title && row.title !== (t.rawTopic ?? t.originalTitle ?? t.title)) {
        Object.assign(t, taskFields(row.title));
      }
      // Приоритет принимаем только из известного набора. Иначе любая
      // чужая строка, оказавшаяся в этой ячейке, становится приоритетом
      // темы и возвращается в таблицу уже как «правильное» значение.
      if (row.priority && row.priority !== t.priority && isPriority(row.priority)) {
        t.priority = row.priority.trim().toUpperCase();
      }
      if (row.targetKeyword && row.targetKeyword !== t.targetKeyword) t.targetKeyword = row.targetKeyword;

      /* Адаптации — отдельная колонка, а не решение: их у статьи бывает
       * несколько сразу («и в Телеграм, и в Дзен»), а решение — одно
       * действие с темой. Заказ снимать нельзя, пока он не выполнен:
       * сравниваем с уже сделанным (t.adaptationsDone) и в работу берём
       * только разницу. */
      const wanted = parseAdaptations(row.adaptation);
      if (wanted.length) {
        const done = t.adaptationsDone || [];
        const fresh = wanted.filter((c) => !done.includes(c));
        if (JSON.stringify(wanted) !== JSON.stringify(t.adaptations || [])) t.adaptations = wanted;
        if (fresh.length) changes.adaptations.push({ slug: t.slug, title: t.title, channels: fresh });
      }

      const d = PLAN_DECISION_SYNONYMS.get((row.decision || '').trim().toLowerCase())
        || (row.decision || '').toLowerCase();
      if (d === 'убрать' && t.status !== 'dropped') {
        // Переход может быть недопустим (например, тема уже released) —
        // тогда просто не трогаем: снимать уже выпущенную статью через
        // колонку решения не должно получаться молча.
        if (transitionTopic(s, t.slug, 'dropped').ok) changes.dropped.push(t.title);
      } else if (d === 'одобрено' && t.status === 'candidate') {
        // Кандидат становится темой в работе. Копировать строку никуда не
        // нужно — она та же самая, меняется только статус.
        if (transitionTopic(s, t.slug, 'planned').ok) changes.approved_topics.push(t.title);
      } else if (d === 'написать сейчас') {
        // Срочный заказ: тема не ждёт планового батча. Кандидата при этом
        // одобряем заодно — редактор явно сказал, что тема нужна.
        if (t.status === 'candidate') transitionTopic(s, t.slug, 'planned');
        if (['candidate', 'planned'].includes(t.status) || t.status === 'planned') {
          t.urgent = true;
          changes.urgent.push({ slug: t.slug, title: t.title });
        }
      } else if (d === 'принято' && t.status === 'review') {
        // Сигнал приёмки статьи — в редакторской колонке «Решение», не в
        // ботовской «Статус». Раньше «принято» было значением только в
        // STATUSES (колонка «Статус», protectedRange, подпись «Заполняется
        // автоматически»), и рутина B искала его именно там — редактору
        // приходилось писать поверх клетки, помеченной как «не трогать»,
        // без единой строки документации, что это и есть его способ
        // одобрить статью. t.status === 'review' — гвард от повторной
        // засветки той же темы на следующих проходах: как только рутина B
        // обработает приёмку (cycle-state accept переводит в 'accepted'),
        // условие перестаёт совпадать само.
        changes.accepted.push({ slug: t.slug, title: t.title });
      } else if (d === 'переписать статью') {
        /* Текст не подошёл, а тема нужна. Возвращаем в план и помечаем
         * попытку: писать заново, зная, что именно не устроило, — не то
         * же самое, что писать с нуля. Прошлый док не трогаем, он
         * остаётся в Drive как то, от чего отталкиваться.
         *
         * Снятые и выпущенные не переписываем: у первых решение уже
         * принято, у вторых текст ушёл в принимающий проект — там это
         * актуализация, а не рерайт. */
        if (['writing', 'review', 'accepted'].includes(t.status)) {
          const from = t.status;
          if (transitionTopic(s, t.slug, 'planned').ok) {
            t.rewrites = (t.rewrites || 0) + 1;
            t.rewriteNote = row.note || t.lastNote || '';
            t.previousDocUrl = t.docUrl || t.previousDocUrl || null;
            changes.rewrite.push({ slug: t.slug, title: t.title, from, note: t.rewriteNote, attempt: t.rewrites });
          }
        }
      } else if (d === 'нужно тз дизайнеру') {
        // Статус не трогаем. Гвард от повторной засветки — по docId: бриф
        // делается по готовому тексту, а пока дока нет, заказывать нечего.
        if (t.docId) changes.designBrief.push({ slug: t.slug, title: t.title, docId: t.docId });
      } else if (d && !KNOWN_DECISIONS.has(d)) {
        // Колонка «Решение» в таблице — выпадающий список с showCustomUi/
        // strict:false (drive-sync.mjs): Sheets ЛЮБОЕ значение примет как
        // валидное, дропдаун только подсказывает. Опечатка вроде «убрать!»
        // или синоним «удалить» раньше проходила бы полностью бесследно —
        // ни одна ветка выше не совпадает, тема просто остаётся как была,
        // и ни редактор, ни рутина B не узнают, что решение не применилось.
        changes.unrecognized.push({ slug: t.slug, title: t.title, decision: row.decision });
      }

      // Исполнитель — колонка «Кто пишет», а не решение: одно и то же
      // действие в двух местах мы уже проходили.
      const who = (row.who || '').trim().toLowerCase();
      if (who === 'пишем сами' && t.owner !== 'editor') {
        t.owner = 'editor';
        changes.toEditor.push(t.title);
      } else if (who === 'ai' && t.owner === 'editor') {
        t.owner = 'bot';
        changes.toBot.push(t.title);
      }

      if (row.note && row.note !== t.lastNote) {
        t.lastNote = row.note;
        const suspect = scanForInstructions(row.note);
        changes.notes.push({
          slug: t.slug, title: t.title, note: row.note,
          ...(suspect.length ? { suspectedInstructions: describeFindings(suspect) } : {}),
        });
        if (suspect.length) changes.suspectedInstructions.push({ slug: t.slug, title: t.title, where: 'Правка', what: describeFindings(suspect) });
      }
    }

    // Темы, которые есть в состоянии, но пропали из таблицы. Если у темы
    // есть slug — это единственный источник истины: row/title как
    // fallback здесь недопустимы, иначе после удаления чужой строки выше
    // эта тема «находится» по номеру строки, который теперь занимает
    // другая тема, и реально пропавшая тема остаётся незамеченной. Row/
    // title — только для тем без slug (циклы, начатые до колонки K).
    for (const t of s.plan) {
      if (['released', 'dropped'].includes(t.status)) continue;
      const stillThere = t.slug
        ? (pull.topics || []).some((r) => r.slug === t.slug)
        : (pull.topics || []).some((r) => r.row === t.row || r.title === t.title);
      if (!stillThere) changes.missing.push(t.title);
    }

    const live = s.plan.filter((t) => !['released', 'dropped'].includes(t.status));
    if (s.state === 'running' && live.length === 0) s.state = 'done';

    save(s, `apply-decisions: ${changes.dropped.length} снято, ${changes.toEditor.length} «пишем сами», ${changes.notes.length} правок`);
    console.log(JSON.stringify(changes, null, 2));
    break;
  }

  /* ---------------------------------------------------- can-start-batch */
  /* Потолок очереди редактора. Не даём завалить его правками.            */
  case 'can-start-batch': {
    if (s.pausedUntil && s.pausedUntil >= today()) {
      console.log(`НЕТ — редактор поставил паузу до ${s.pausedUntil} (ячейка B2 таблицы плана)`);
      process.exit(1);
    }
    if (s.state === 'awaiting_review') { console.log('НЕТ — план ещё не одобрен в таблице'); process.exit(1); }
    if (['idle', 'done'].includes(s.state)) { console.log(`НЕТ — цикл в состоянии ${s.state}`); process.exit(1); }

    const occupied = occupiedCount(s);
    const pending = s.plan.filter((t) => t.status === 'planned' && t.owner === 'bot');

    if (occupied >= s.maxInReview) {
      console.log(`НЕТ — потолок очереди: пишется+на вычитке ${occupied}/${s.maxInReview}. Ждём, пока редактор примет или дописываются темы.`);
      process.exit(1);
    }
    if (!pending.length) {
      const own = s.plan.filter((t) => t.status === 'planned' && t.owner === 'editor').length;
      console.log(`НЕТ — botских тем в очереди нет${own ? ` (${own} пишет редактор сам)` : ''}`);
      process.exit(1);
    }
    const room = s.maxInReview - occupied;
    console.log(`ДА — ${pending.length} тем в очереди, пишется+на вычитке ${occupied}/${s.maxInReview}, влезет ещё ${room}`);
    break;
  }

  /* ---------------------------------------------------------- next-batch */
  case 'next-batch': {
    const room = Math.max(0, s.maxInReview - occupiedCount(s));
    const size = Math.min(Number(arg('size', s.batchSize)), room);
    const order = { P0: 0, P1: 1, P2: 2 };
    // «Написать сейчас» идёт вперёд приоритета: редактор сказал это про
    // конкретную тему сегодня, а приоритет проставлен при планировании.
    const picked = s.plan
      .filter((t) => t.status === 'planned' && t.owner === 'bot')
      .sort((a, b) =>
        Number(Boolean(b.urgent)) - Number(Boolean(a.urgent)) ||
        (order[a.priority] ?? 9) - (order[b.priority] ?? 9))
      .slice(0, size);
    console.log(JSON.stringify(picked, null, 2));
    break;
  }

  /* Дописать кандидатов в текущий месяц. Ресёрч идёт еженедельно, а
     вкладка месячная: новые темы не заменяют прежние, а встают строками
     ниже. Дубли по слагу отсекаются здесь же — одна и та же фраза
     Wordstat приходит из недели в неделю, и без этого месяц зарос бы
     повторами. Возвращает только реально добавленные темы, с номерами
     строк: их же принимает drive-sync append-topics. */
  case 'add-candidates': {
    const file = arg('file');
    if (!file || !existsSync(file)) die('нужен --file <json со списком тем>');
    if (!s.cycleId) die('цикл не заведён — сначала init');
    const incoming = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(incoming)) die('ожидается массив тем');

    const known = new Set(s.plan.map((t) => t.slug));
    let row = s.plan.reduce((m, t) => Math.max(m, t.row || 0), 4);
    const added = [];
    /* Заглушённые темы сюда не пускаем.
     *
     * Отказ редактора «категорически не наше ядро» глушит тему на 90 дней,
     * но проверял это только generate-backlog. В таблицу тема попадает
     * ещё и через add-candidates — и 11.08.2026 «Интернет-эквайринг»,
     * снятый двумя днями раньше, вернулся именно так. Редактору пришлось
     * отказывать второй раз: ровно то, ради чего заглушки и заводились. */
    const suppressions = loadSuppressions();
    const suppressed = [];
    for (const it of incoming) {
      const cell = it.title || it.topic || '';
      if (!cell) continue;
      /* Тот же разбор, что и для строк редактора, — но только для тем,
       * пришедших текстом. Очередь актуализации (update-queue.mjs) отдаёт
       * тему уже разобранной: ссылка известна точно, а заголовок в ней
       * выглядит как «Актуализация: <название статьи>». Прогон такого
       * заголовка через разбор второй раз ссылку не находил (её в строке
       * уже нет) и превращал тему в «Актуализация: статья без ссылки». */
      /* Разобранная тема из очереди актуализации не разбирается заново
       * (иначе теряется ссылка), но проверки к ней применяются те же.
       * До 13.08.2026 эта ветка шла мимо них целиком — то есть мимо
       * главного пути, ради которого очередь и делалась: пачка ссылок
       * от редакции входила без единой проверки домена и текста. */
      const preparsed = it.sourceUrl;
      const suspect = preparsed ? scanForInstructions(`${cell} ${it.brief || ''}`) : [];
      const blockedRefs = preparsed ? (it.refUrls || []).filter((u) => !isAllowedSource(u)) : [];
      const task = preparsed
        ? {
          title: cell, kind: 'update', brief: it.brief || '',
          sourceUrl: it.sourceUrl, sourceTitle: it.sourceTitle ?? null,
          refUrls: it.refUrls || [], rawTopic: cell,
          ...(suspect.length ? { suspectedInstructions: describeFindings(suspect) } : {}),
          ...(isAllowedSource(it.sourceUrl) ? {} : { sourceNotFetchable: 'домен вне списка разрешённых — открыть вручную, автоматически не загружаем' }),
          ...(blockedRefs.length ? { refUrlsNotFetchable: blockedRefs } : {}),
        }
        : taskFields(cell);
      const title = task.title;
      if (!title) continue;
      const slug = it.slug || slugify(title);
      if (known.has(slug)) continue;
      if (isSuppressed(title, suppressions)) { suppressed.push(title); continue; }
      known.add(slug);
      const t = {
        slug,
        ...task,
        priority: it.priority || 'P1',
        cluster: it.cluster || '',
        targetKeyword: it.targetKeyword || '',
        rationale: it.why || it.rationale || '',
        row: ++row,
        owner: 'bot',
        status: 'candidate',
        docId: null,
        docUrl: null,
        seenComments: [],
      };
      s.plan.push(t);
      added.push({ ...it, ...t });
    }
    save(s, `add-candidates: +${added.length} из ${incoming.length}`);
    if (suppressed.length) {
      console.error(`ℹ Не добавлены — заглушены отказом редактора (${suppressed.length}):`);
      for (const title of suppressed) console.error(`   • ${title}`);
    }
    console.log(JSON.stringify(added, null, 2));
    break;
  }

  /* Привязать уже существующий Google Doc к теме, не меняя статус.
     Нужно, когда док создан, а связь потерялась (перенос месяца,
     пересборка цикла): to-review для этого не годится — он требует
     перехода статуса, а тема уже на вычитке. */
  /* Заголовок темы после написания статьи.
   *
   * В колонку «Тема» редактор пишет не только заголовки: 13.08.2026 там
   * оказались «Актуализировать статью https://…» и «Заголовок: Ошибки
   * при работе с ТС ПИоТ…». Это задача, а не название материала, но в
   * состояние она попала как заголовок — и файлы статей получили имена
   * вида 2026-08-13-aktualizirovat-statyu-https-kontur-ru-….
   *
   * Команда возвращает в состояние настоящий заголовок готовой статьи и
   * запоминает имя файла отдельным полем. Slug темы не трогаем: это
   * первичный ключ, по нему сходятся строка таблицы и состояние. */
  case 'set-title': {
    const slug = arg('slug');
    const title = arg('title');
    if (!slug || !title) die('нужны --slug и --title');
    const t = find(s, slug);
    if (!t) die(`темы "${slug}" нет в плане`);
    const before = t.title;
    t.title = title;
    const fileSlug = arg('file-slug');
    if (fileSlug) t.fileSlug = fileSlug;
    // Исходную формулировку не теряем: в ней могла быть инструкция
    // редактора со ссылкой, и она нужна при разборе следующей правки.
    if (before !== title && !t.originalTitle) t.originalTitle = before;
    save(s, `set-title ${slug}: «${before.slice(0, 40)}» → «${title.slice(0, 40)}»`);
    console.log(`✅ ${slug}: заголовок обновлён${fileSlug ? `, файл ${fileSlug}` : ''}`);
    break;
  }

  case 'set-doc': {
    const slug = arg('slug');
    const t = find(s, slug);
    if (!t) die(`тема "${slug}" не найдена`);
    t.docId = arg('doc-id', t.docId);
    t.docUrl = arg('doc-url', t.docUrl);
    save(s, `set-doc ${slug}`);
    console.log(`✅ ${slug} → ${t.docUrl}`);
    break;
  }

  /* --------------------------------------------------------- start-batch */
  case 'start-batch': {
    const slugs = (arg('slugs') || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!slugs.length) die('нужен --slugs a,b,c');

    const bad = [];
    for (const sl of slugs) {
      const t = find(s, sl);
      if (!t) bad.push(`${sl} — нет в плане`);
      else if (t.status !== 'planned') bad.push(`${sl} — статус ${t.status}, а не planned`);
      else if (t.owner !== 'bot') bad.push(`${sl} — пишет редактор сам`);
    }
    if (bad.length) die(`нельзя брать в батч:\n  ${bad.join('\n  ')}`);

    // По одной теме за раз через transitionTopic — она же проверяет
    // потолок writing+review на каждом шаге. Батч атомарный: если потолок
    // не влез на середине списка, откатываем уже применённые темы назад,
    // чтобы не оставить батч в наполовину стартовавшем состоянии.
    const applied = [];
    let failure = null;
    for (const sl of slugs) {
      const r = transitionTopic(s, sl, 'writing');
      if (!r.ok) { failure = r.error; break; }
      applied.push(sl);
    }
    if (failure) {
      for (const sl of applied) find(s, sl).status = 'planned';
      die(`батч не стартовал: ${failure}`);
    }

    const n = s.batches.length + 1;
    s.batches.push({ n, slugs, startedAt: new Date().toISOString(), state: 'writing' });
    save(s, `батч ${n} начат: ${slugs.join(', ')}`);
    console.log(`✅ Батч ${n}: ${slugs.length} тем в работе`);
    break;
  }

  /* ----------------------------------------------------------- to-review */
  case 'to-review': {
    const slug = arg('slug');
    if (!slug) die('нужен --slug');
    const r = transitionTopic(s, slug, 'review');
    if (!r.ok) die(r.error);
    const t = find(s, slug);
    t.docId = arg('doc-id', t.docId);
    t.docUrl = arg('doc-url', t.docUrl);
    // Момент, с которого статья ждёт редактора. Без него в таблице
    // статья шестого дня выглядит так же, как вчерашняя, и приоритет
    // вычитки редактору взять неоткуда.
    t.reviewSince = new Date().toISOString().slice(0, 10);
    const b = s.batches.find((x) => x.slugs.includes(slug) && x.state === 'writing');
    if (b && b.slugs.every((sl) => find(s, sl).status !== 'writing')) b.state = 'review';
    save(s, `${slug} → на вычитке`);
    console.log(`✅ ${slug} → на вычитке · ${t.docUrl || 'без ссылки'} · очередь ${occupiedCount(s)}/${s.maxInReview}`);
    break;
  }

  /* ------------------------------------------------------ accept/release */
  case 'accept':
  case 'release': {
    const slug = arg('slug') || process.argv[3];
    if (!slug) die('нужен --slug');
    const to = cmd === 'accept' ? 'accepted' : 'released';
    const r = transitionTopic(s, slug, to);
    if (!r.ok) die(r.error);

    for (const b of s.batches) {
      if (b.slugs.includes(slug) && b.slugs.every((sl) => ['accepted', 'released', 'dropped'].includes(find(s, sl)?.status))) {
        b.state = 'closed';
        b.closedAt = new Date().toISOString();
      }
    }
    const live = s.plan.filter((x) => !['released', 'dropped'].includes(x.status));
    if (s.state === 'running' && !live.length) s.state = 'done';

    save(s, `${slug} → ${RU_STATUS[to]}`);
    console.log(`✅ ${slug} → ${RU_STATUS[to]} · очередь ${occupiedCount(s)}/${s.maxInReview} · состояние ${s.state}`);
    break;
  }

  /* --------------------------------------------------------------- owner */
  case 'own': {
    const slug = arg('slug');
    const owner = arg('owner');
    const t = slug && find(s, slug);
    if (!t) die(`темы "${slug}" нет в плане`);
    if (!['bot', 'editor'].includes(owner)) die('--owner должен быть bot или editor');
    t.owner = owner;
    save(s, `${slug}: пишет ${owner === 'editor' ? 'редактор' : 'бот'}`);
    console.log(`✅ ${slug} — пишет ${owner === 'editor' ? 'редактор сам' : 'бот'}`);
    break;
  }

  /* ------------------------------------------------------ seen-comments */
  case 'seen-comments': {
    const slug = arg('slug');
    const ids = (arg('ids') || '').split(',').map((x) => x.trim()).filter(Boolean);
    const t = slug && find(s, slug);
    if (!t) die(`темы "${slug}" нет в плане`);
    t.seenComments = [...new Set([...(t.seenComments || []), ...ids])].slice(-200);
    save(s, `${slug}: отмечено ${ids.length} замечаний`);
    console.log(`✅ ${slug}: разобрано ${t.seenComments.length} замечаний всего`);
    break;
  }

  /* ----------------------------------------------------------- set-state */
  case 'set-state': {
    const to = process.argv[3];
    if (!STATES.includes(to)) die(`неизвестное состояние "${to}". Допустимо: ${STATES.join(', ')}`);
    const from = s.state;
    s.state = to;
    save(s, `state ${from} → ${to}`);
    console.log(`✅ ${from} → ${to}`);
    break;
  }

  /* ------------------------------------------------------ row-decisions */
  /* Какие решения имеют смысл для каждой строки — по её статусу.
   *
   * В колонке «Решение» шесть значений, но одновременно применимы два-три:
   * «пишем сами» бессмысленно для написанной статьи, «принято» — для темы,
   * которая ещё в плане, «нужно ТЗ дизайнеру» — пока текста нет. Общий
   * список из шести пунктов заставлял редактора помнить, что где уместно,
   * и молча допускал бессмысленные комбинации.
   *
   * Отдаём drive-sync.mjs set-row-dropdowns: он ставит свой список на
   * каждую строку. Списки остаются нестрогими (strict: false) — вписать
   * своё значение по-прежнему можно, подсказка не запрет. */
  case 'row-decisions': {
    /* «Переписать статью» показываем там, где есть что переписывать:
     * с вычитки — чаще всего, у принятой — если передумали, у пишущейся
     * — чтобы не ждать конца заведомо ненужного текста. У кандидата и
     * темы в плане текста ещё нет, и предлагать там рерайт значит
     * предлагать действие, которое ничего не сделает. */
    const BY_STATUS = {
      candidate: ['одобрено', 'написать сейчас', 'убрать'],
      planned:  ['написать сейчас', 'убрать'],
      writing:  ['переписать статью', 'убрать'],
      review:   ['принято', 'переписать статью', 'убрать'],
      accepted: ['нужно ТЗ дизайнеру', 'переписать статью'],
      released: ['нужно ТЗ дизайнеру'],
      dropped:  [],
    };
    const updates = s.plan
      .filter((t) => t.row)
      .map((t) => {
        return { row: t.row, values: [...(BY_STATUS[t.status] ?? [])] };
      })
      .filter((u) => u.values.length);
    console.log(JSON.stringify(updates));
    break;
  }

  /* --------------------------------------------------------- sheet-sync */
  /* Готовит обновления ячеек «Статус», «Документ» и скрытого ID (колонка
   * K — apply-decisions сопоставляет по нему строки, см. там) для
   * drive-sync set-cells. */
  /* Очередь встала — кто-нибудь об этом узнает?
   *
   * Потолок в 6 статей защищает редактора от завала правками, но у защиты
   * есть обратная сторона: если про статью просто забыли, новые не
   * приходят и цикл тихо останавливается. Строку состояния в шапке видит
   * только тот, кто открыл таблицу, — а он её не открыл, в том и беда.
   *
   * Команда отвечает на два вопроса: что залежалось и пора ли напоминать.
   * Напоминание — не чаще раза в сутки: иначе почасовой прогон превратит
   * заботу в спам, и его начнут игнорировать вместе с полезным. */
  case 'stale-review': {
    const days = Number(arg('days', 3));
    const stale = waitingTopics(s).filter((t) => waitedDays(t) >= days);
    const queueFull = occupiedCount(s) >= s.maxInReview;
    const lastNudge = s.lastNudgeAt || null;
    const due = (stale.length > 0 || queueFull) && lastNudge !== today();
    console.log(JSON.stringify({
      days,
      queueFull,
      occupied: occupiedCount(s),
      max: s.maxInReview,
      stale: stale.map((t) => ({ title: t.title, waited: waitedDays(t), url: t.docUrl })),
      blockedTopics: s.plan.filter((t) => t.status === 'planned' && t.owner === 'bot').length,
      lastNudge,
      due,
    }, null, 2));
    break;
  }

  /* Отметка «сегодня уже напоминали». Отдельной командой, а не побочным
     эффектом stale-review: читать состояние можно сколько угодно раз,
     а менять его — только когда напоминание действительно ушло. */
  case 'mark-nudged': {
    s.lastNudgeAt = today();
    save(s, 'nudge: напоминание о вычитке отправлено');
    console.log(`✅ Отмечено: напоминали ${s.lastNudgeAt}`);
    break;
  }

  /* Потолок очереди и размер порции задавались только при init — на живом
   * цикле поменять их было нечем, кроме правки JSON руками, а это ровно
   * то, чего файл не должен допускать. Отдельная команда с записью в лог:
   * потом видно, когда и на что поменяли.
   *
   * Потолок ниже текущей занятости не запрещаем: это не поломка, а
   * «дальше не наливаем, пока не разберут» — новые статьи просто не
   * придут, уже начатые дописываются. Предупреждаем и идём дальше. */
  case 'set-limits': {
    const num = (name) => {
      const raw = arg(name);
      if (raw === undefined) return null;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) die(`--${name}: нужно целое число ≥ 1, пришло "${raw}"`);
      return n;
    };
    const max = num('max-in-review');
    const size = num('batch-size');
    if (max === null && size === null) die('нужен --max-in-review N и/или --batch-size N');

    const before = { max: s.maxInReview, size: s.batchSize };
    if (max !== null) s.maxInReview = max;
    if (size !== null) s.batchSize = size;

    const parts = [];
    if (max !== null) parts.push(`потолок очереди ${before.max} → ${max}`);
    if (size !== null) parts.push(`порция ${before.size} → ${size}`);
    save(s, `set-limits: ${parts.join(', ')}`);
    console.log(`✅ ${parts.join(', ')}`);

    const occupied = occupiedCount(s);
    if (occupied > s.maxInReview) {
      console.log(`⚠ Сейчас занято ${occupied} — больше нового потолка. Новые статьи не пойдут, пока не разберут очередь.`);
    }
    if (s.batchSize > s.maxInReview) {
      console.log(`⚠ Порция (${s.batchSize}) больше потолка (${s.maxInReview}) — за раз придёт не больше ${s.maxInReview}.`);
    }
    break;
  }

  case 'sheet-sync': {
    const updates = [];

    /* Строка состояния в шапке (E2). Молчание рутин по дизайну — «нового
     * нет, не беспокоим», но со стороны редактора тишина неотличима от
     * поломки: батч не пришёл, и понять почему можно только пересчитав
     * строки руками (аудит 2026-08-08, находка №4). Одна строка в шапке
     * снимает вопрос без письма и без похода к владельцу. */
    const occupied = occupiedCount(s);
    const pendingBot = s.plan.filter((t) => t.status === 'planned' && t.owner === 'bot').length;
    const parts = [`Очередь: ${occupied}/${s.maxInReview}`];
    if (s.pausedUntil && s.pausedUntil >= today()) {
      parts.push(`пауза до ${s.pausedUntil} — новые статьи не пишутся, снимается в ячейке B2`);
    } else if (s.state === 'awaiting_review') {
      parts.push('план ждёт вашего «ОДОБРЕН» в B2 — до этого статьи не пишутся');
    } else if (occupied >= s.maxInReview) {
      parts.push('новые статьи не придут, пока вы не разберёте очередь — это защита, не сбой');
    } else if (!pendingBot) {
      parts.push('свободных тем для бота нет — пополните план или снимите «пишем сами»');
    } else {
      // Текст читает редактор, а не разработчик: «батч» — жаргон.
      parts.push(`тем в работе у бота: ${pendingBot}, ближайшие статьи — понедельник или четверг`);
    }
    // С какой статьи начать. Приоритет — сначала возраст (что ждёт
    // дольше), при равном возрасте P0 выше P1. Полная очередь без этой
    // подсказки — шесть равнозначных строк, порядок редактор выбирает
    // наугад, и дольше всех ждёт обычно не то, что важнее.
    const firstUp = waitingTopics(s)[0];
    if (firstUp) {
      parts.push(`начать с: «${firstUp.title}» (${firstUp.priority || 'P1'}, ждёт ${waitedDays(firstUp)} дн.)`);
    }
    parts.push(`обновлено ${today()}`);
    updates.push({ range: 'E2', value: parts.join(' · ') });

    for (const t of s.plan) {
      if (!t.row) continue;
      // К статусу «на вычитке» дописываем возраст: отдельной колонки под
      // это нет, а вставлять её нельзя — сдвинутся I/J/K, на которые
      // ссылаются буквами и этот код, и kontur-menu.gs.
      const days = t.status === 'review' ? waitedDays(t) : null;
      const label = RU_STATUS[t.status] || t.status;
      updates.push({ range: `${COL.status}${t.row}`, value: days === null ? label : `${label} · ${days} дн.` });
      if (t.docUrl) updates.push({ range: `${COL.doc}${t.row}`, value: t.docUrl });
      if (t.slug) updates.push({ range: `${COL.slug}${t.row}`, value: t.slug });
    }
    console.log(JSON.stringify(updates));
    break;
  }

  /* --------------------------------------------------------------- reset */
  case 'reset': {
    if (!process.argv.includes('--force')) die('это сотрёт текущий цикл. Повтори с --force.');
    // Настройки темпа переживают сброс: reset стирает цикл, а не решение
    // владельца о том, сколько статей редакция тянет за раз.
    const fresh = structuredClone(EMPTY);
    fresh.batchSize = s.batchSize ?? fresh.batchSize;
    fresh.maxInReview = s.maxInReview ?? fresh.maxInReview;
    save(fresh, 'reset');
    console.log('✅ Состояние сброшено в idle');
    break;
  }

  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].split('/**')[1]);
    process.exit(cmd ? 1 : 0);
}
