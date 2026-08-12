#!/usr/bin/env node
/**
 * Google Drive как рабочее место редактора.
 *
 * Редактор не заходит в GitHub. Всё, что ему нужно, лежит в одной папке
 * Drive: таблица плана + по одному Google Doc на статью. Этот скрипт —
 * единственный мост между репозиторием и Drive.
 *
 * Структура папки:
 *   📁 Контур — редакция
 *      📊 Редакция — темы и план      ОДНА таблица, ОДНА вкладка в работе:
 *         ├ «Темы и статьи 2026-08»      месяц: кандидаты и статьи вместе
 *         └ «архив · …»                   прошлые месяцы
 *      📁 2026-08                     папка месяца, по одному Doc на статью
 *
 * Строка живёт весь путь темы: кандидат → в плане → пишется → на вычитке
 * → принято → выпущено. Ничего никуда не копируется: копия — источник
 * расхождения, а не удобство. Раз в месяц заводится новая вкладка,
 * незакрытые статьи переезжают в неё вместе с новыми кандидатами.
 *
 * Подкоманды:
 *   init-root    [--name "Контур — редакция"]      создать корневую папку
 *   init-month   --month 2026-08 --items t.json    вкладка месяца + папка
 *   pull         --sheet-id <id> [--tab "…"]       решения редактора
 *   push-plan    --sheet-id <id> --plan t.json     перезалить строки
 *   make-doc     --title "..." --md article.md      создать Doc из markdown
 *   export-doc   --doc-id <id> [--out file.md]      Doc → markdown
 *   comments     --doc-id <id>                      нерешённые замечания
 *   comment      --file-id <id> --text "..." [--mention editor@mail]
 *   reply        --doc-id <id> --comment-id <id> --text "..." [--resolve]
 *   notify       --file-id <id> --to editor@mail [--message "..."]
 *   set-cells    --sheet-id <id> --updates '[{"range":"S5","value":"пишется"}]'
 *   set-row-dropdowns --sheet-id <id> --updates '[{"row":5,"values":["принято"]}]'
 *   check                                          диагностика доступа
 *
 * Два разных способа позвать редактора, и путать их не надо:
 *
 *   comment — оставляет замечание в доке или таблице. Видно тому, кто
 *   файл откроет; `--mention` добавляет к тексту +адрес, и Drive
 *   разбирает его в mentionedEmailAddresses. Рассылку писем по
 *   упоминаниям Google для комментариев, созданных через API, не
 *   гарантирует — считать это каналом уведомления нельзя.
 *
 *   notify — выдаёт редактору доступ к конкретному файлу с
 *   sendNotificationEmail=true. Вот это письмо Google шлёт всегда, и
 *   emailMessage попадает в его текст. Годится ровно один раз на файл:
 *   если доступ у редактора уже есть, второго письма не будет.
 *
 * Аутентификация: два независимых пути, порядок задаёт DRIVE_AUTH.
 *
 * Рекомендуемый — OAuth (DRIVE_AUTH=oauth): файлы создаются от имени
 * владельца Диска, в его квоте. Без общего диска это единственный путь,
 * который создаёт файлы автоматически. Подробности и настройка без
 * семидневного отзыва токена — docs/google-api-setup.md.
 *
 * Сервисный аккаунт (DRIVE_AUTH=sa) работает только на общем диске: своей
 * квоты Drive у него нет, и без общего диска любая попытка создать файл
 * упирается в storageQuotaExceeded.
 *
 * Без DRIVE_AUTH — авто: сначала сервисный аккаунт, если задан
 * GOOGLE_DOCS_KEY, иначе OAuth. Для однозначности лучше указывать явно.
 *
 * Окружение:
 *   DRIVE_AUTH             oauth | sa — какой путь брать (см. выше)
 *   GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN — OAuth
 *   GOOGLE_DOCS_KEY        сервисный аккаунт (JSON или base64)
 *   GOOGLE_DOCS_FOLDER_ID  корневая папка редакции в Drive
 *   DRY_RUN=1              печатать план запросов и выйти
 *
 * ВАЖНО: в проекте Google Cloud должны быть включены Drive, Docs и Sheets
 * API. Прав достаточно одного скоупа drive.file. Проверить всё разом: `check`.
 * Инструкция по настройке — docs/google-api-setup.md
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugify } from './lib/slugify.mjs';
import { resolveInternalLink } from './lib/resolve-links.mjs';
import {
  WORK_COLS, WORK_HEADER_ROW, WORK_FIRST_DATA_ROW, APPROVAL_CELL,
  colLetter, workIdx, COL as WORK_COL, RU_STATUS,
} from './lib/sheet-columns.mjs';

const ROOT_FOLDER = process.env.GOOGLE_DOCS_FOLDER_ID || '';
const RAW_KEY = process.env.GOOGLE_DOCS_KEY || '';
const OAUTH_ID = process.env.GSC_CLIENT_ID || '';
const OAUTH_SECRET = process.env.GSC_CLIENT_SECRET || '';
const OAUTH_REFRESH = process.env.GSC_REFRESH_TOKEN || '';
const DRY_RUN = process.env.DRY_RUN === '1';
// Какой путь аутентификации брать, когда настроены оба.
//
// По умолчанию побеждает сервисный аккаунт — так было исторически. Но без
// общего диска он файлы создавать не может: своей квоты Drive у него нет,
// и всё упирается в storageQuotaExceeded. Если общего диска нет, путь
// должен быть OAuth, и лучше сказать это явно, чем удалять секрет и гадать,
// почему снова взялся не тот доступ.
const AUTH_PREF = (process.env.DRIVE_AUTH || '').toLowerCase();

// Скоуп сервисного аккаунта — полный drive, и это не расточительство.
//
// Рабочая схема — общий диск (Shared Drive): файлы там принадлежат самому
// диску, а не создателю, поэтому у сервисного аккаунта не спрашивают его
// личную квоту Drive, которой у него нет. Именно это снимает
// storageQuotaExceeded, и при этом ключ SA бессрочный — никаких
// семидневных отзывов токена, как на пути OAuth.
//
// Но папку общего диска приложение не создавало, а drive.file даёт доступ
// только к своим файлам: создание внутри чужой папки упрётся в 404.
// Отсюда полный drive.
//
// Требование верификации Google на restricted-скоупы к сервисному аккаунту
// не относится: у него нет экрана согласия, права выдаёт владелец проекта,
// а доступ к данным ограничен членством в конкретном общем диске.
//
// ВНИМАНИЕ: список действует ТОЛЬКО для сервисного аккаунта. На пути OAuth
// права зашиты в refresh_token в момент выдачи; там наоборот нужен узкий
// drive.file — он non-sensitive и позволяет опубликовать приложение в
// Production, что снимает отзыв токена через 7 дней.
// См. docs/google-api-setup.md
const SCOPES = ['https://www.googleapis.com/auth/drive'].join(' ');

/* ────────────────────────────────────────────────────── аутентификация ── */
const b64url = (s) =>
  Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function parseKey(raw) {
  const t = raw.trim();
  return JSON.parse(t.startsWith('{') ? t : Buffer.from(t, 'base64').toString('utf8'));
}

async function tokenSA(creds) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: SCOPES,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${head}.${body}`;
  const sig = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(creds.private_key)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth (SA) ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).access_token;
}

async function tokenOAuth() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: OAUTH_ID,
      client_secret: OAUTH_SECRET,
      refresh_token: OAUTH_REFRESH,
      grant_type: 'refresh_token',
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth (refresh) ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).access_token;
}

let TOKEN = null;
let AUTH_MODE = null;

async function auth() {
  if (TOKEN) return TOKEN;

  const oauthReady = Boolean(OAUTH_ID && OAUTH_SECRET && OAUTH_REFRESH);
  if (AUTH_PREF === 'oauth') {
    if (!oauthReady) die('DRIVE_AUTH=oauth, но GSC_CLIENT_ID/SECRET/REFRESH_TOKEN заданы не полностью');
    TOKEN = await tokenOAuth();
    AUTH_MODE = 'oauth';
    return TOKEN;
  }
  if (AUTH_PREF === 'sa') {
    if (!RAW_KEY) die('DRIVE_AUTH=sa, но GOOGLE_DOCS_KEY не задан');
    TOKEN = await tokenSA(parseKey(RAW_KEY));
    AUTH_MODE = 'sa';
    return TOKEN;
  }

  if (RAW_KEY) {
    TOKEN = await tokenSA(parseKey(RAW_KEY));
    AUTH_MODE = 'sa';
  } else if (OAUTH_ID && OAUTH_SECRET && OAUTH_REFRESH) {
    TOKEN = await tokenOAuth();
    AUTH_MODE = 'oauth';
  } else {
    die('нет учётных данных: задай GOOGLE_DOCS_KEY или GSC_CLIENT_ID/SECRET/REFRESH_TOKEN');
  }
  return TOKEN;
}

/** Сервисный аккаунт не имеет своей квоты Drive — при отказе падаем на OAuth. */
async function withQuotaFallback(fn) {
  try {
    return await fn();
  } catch (e) {
    const isQuota = /storageQuota|storage quota/i.test(e.message);
    if (AUTH_MODE === 'sa' && isQuota && OAUTH_ID && OAUTH_REFRESH) {
      console.warn('⚠ Сервисный аккаунт упёрся в квоту Drive, переключаюсь на OAuth.');
      TOKEN = await tokenOAuth();
      AUTH_MODE = 'oauth';
      return await fn();
    }
    // Голый 403 storageQuotaExceeded не подсказывает ничего: выглядит как
    // «кончилось место», хотя место ни при чём. У сервисного аккаунта своей
    // квоты Drive нет вообще, и починка — не освободить место, а завести
    // OAuth-откат. Без этой подсказки диагноз ищут в чужом направлении.
    if (AUTH_MODE === 'sa' && isQuota) {
      throw new Error(
        'storageQuotaExceeded: у сервисного аккаунта нет собственной квоты Drive, ' +
          'и файл создать он не может. Это не «кончилось место».\n' +
          '  Откат на OAuth не сработал: не заданы GSC_CLIENT_ID / GSC_CLIENT_SECRET / ' +
          'GSC_REFRESH_TOKEN.\n' +
          '  Как получить refresh_token — docs/google-api-setup.md, путь A.\n' +
          `  Исходная ошибка: ${e.message.slice(0, 200)}`,
      );
    }
    throw e;
  }
}

/* ───────────────────────────────────────────────────────────── запросы ── */
async function api(url, opts = {}) {
  const t = await auth();
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${t}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${url.split('?')[0]} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

// Drive API по умолчанию делает вид, что общих дисков не существует:
// файлы в них не находятся поиском и не создаются, пока в запросе нет
// supportsAllDrives. Добавляем флаги централизованно — иначе один
// забытый вызов ломает всю схему, а ошибка выглядит как «файл не найден».
function withDriveFlags(path) {
  // Дописываем строкой, а не через URLSearchParams: тот перекодирует уже
  // готовый параметр q, превращая пробелы в «+». В поисковом запросе Drive
  // это ломает имена с пробелами — «Бэклог тем» перестаёт находиться.
  const sep = path.includes('?') ? '&' : '?';
  let out = `${path}${sep}supportsAllDrives=true`;
  if (path.startsWith('files?') && path.includes('q=')) {
    out += '&includeItemsFromAllDrives=true';
  }
  return out;
}

const drive = (path, opts) =>
  api(`https://www.googleapis.com/drive/v3/${withDriveFlags(path)}`, opts);
const docs = (path, opts) => api(`https://docs.googleapis.com/v1/${path}`, opts);
const sheets = (path, opts) => api(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, opts);

function die(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}

/* ─────────────────────────────────────────────────── структура таблицы ── */
// Строки 1–3 — шапка и переключатель согласования. Строка 4 — заголовки
// колонок. Темы начинаются с 5-й.
/* ───────────────────────────── одна вкладка на месяц: темы и статьи ──── */
/* До 11.08.2026 бэклог и план жили в разных таблицах, потом — в разных
 * вкладках. Одобренная тема при этом копировалась из одной в другую и
 * существовала дважды: строка бэклога оставалась выглядеть нерешённой,
 * а работа шла в плане. Копия — источник расхождения, а не удобство.
 *
 * Теперь строка одна и живёт весь путь темы: кандидат → в плане →
 * пишется → на вычитке → принято → выпущено. Месяц — вкладка, свежая
 * встаёт первой. Незакрытые статьи прошлого месяца переезжают в новую
 * вкладку вместе с новыми кандидатами: бросать их в архивной вкладке
 * значит потерять из виду. */
/* Домен принимающего проекта. Пусто — внутренние ссылки в доках остаются
 * простым текстом (см. mdToDocRequests): у модуля своего сайта нет. */
const BLOG_BASE = process.env.BLOG_BASE_URL || '';

const WORK_TAB_PREFIX = 'Темы и статьи ';
const workTabName = (month) => `${WORK_TAB_PREFIX}${month}`;

/* Реестр написанного. Вкладка месяца показывает только текущий месяц, а
 * с первого числа заводится новая — всё, что написано раньше, уходит из
 * поля зрения редакции. Машина дубли ловит (generate-backlog сверяется
 * с блогом), но человеку при взгляде на кандидата видеть нечего, и
 * вопрос «мы это уже писали?» упирается в память. Отсюда отдельная
 * вкладка на весь корпус, только для чтения: её ведёт бот. */
const WRITTEN_TAB = 'Написано';
const WRITTEN_COLS = [
  { title: '№', width: 40 },
  { title: 'Статья', width: 380 },
  { title: 'Целевой запрос', width: 230 },
  { title: 'Кластер', width: 110 },
  { title: 'Дата', width: 90 },
  { title: 'Слов', width: 60 },
  { title: 'Обновить до', width: 100 },
  { title: 'Файл', width: 300 },
];

/* Полный список решений для колонки целиком. По строкам его сужает
 * cycle-state.mjs row-decisions: у кандидата свои варианты, у статьи на
 * вычитке — свои. Исполнителя («AI» / «пишем сами») здесь нет намеренно:
 * кто пишет — это колонка, а не решение, и держать одно и то же в двух
 * местах мы уже пробовали. */
const WORK_DECISIONS = [
  'одобрено',            // кандидат → в план
  'написать сейчас',     // не ждать батча: тема уходит в ближайший прогон
  'нужен рерайт',        // статья есть, но устарела — обновляем её
  'принято',             // статья на вычитке устраивает
  'нужно ТЗ дизайнеру',  // заказ на обложку и иллюстрации
  'убрать',              // снять тему на любом этапе
];
const WORK_WHO = ['AI', 'пишем сами'];
const WORK_STATUSES = ['кандидат', 'в плане', 'пишется', 'на вычитке', 'принято', 'выпущено', 'снято'];

/* Причина отказа — не комментарий, а команда: от формулировки зависит,
 * замолчит тема на 90 дней, на 30 или вернётся через неделю. Список
 * нестрогий, как и «Решение»: свой текст означает «тема вернётся». */
const WORK_REASONS = [
  'категорически не наше ядро',
  'не тот угол',
  'уже покрыто другой статьёй',
  'пока рано — вернуть позже',
];

/* Старые слова решений: в живых таблицах они уже проставлены, и молчаливое
 * «не распознано» означало бы потерянную работу редактора. В выпадающих
 * списках их больше нет — это совместимость, а не второй словарь. */
const DECISION_SYNONYMS = new Map([
  ['согласовано', 'одобрено'],
  ['не согласовано', 'убрать'],
  ['отклонено', 'убрать'],
  ['снять', 'убрать'],
  // Исполнитель переехал из решений в колонку «Кто пишет». Старые
  // значения не выбрасываем, а переносим туда, где им теперь место
  // (см. readWork) — иначе «пишем сами», проставленное редактором,
  // просто исчезло бы вместе со смыслом.
  ['пишет бот', ''],
  ['пишем сами', ''],
]);
const DECISION_TO_WHO = new Map([['пишет бот', 'AI'], ['пишем сами', 'пишем сами']]);
function normalizeDecision(value) {
  const raw = (value || '').trim();
  const mapped = DECISION_SYNONYMS.get(raw.toLowerCase());
  return mapped === undefined ? raw : mapped;
}

/* ─────────────────────────────────────────────────── markdown → Docs ──── */
/** Разбирает markdown в плоский текст + диапазоны стилей для Docs API. */
function mdToDocRequests(md, unresolved = []) {
  let text = '';
  const h1 = [], h2 = [], h3 = [], bullets = [], bold = [], links = [];

  // Мягкие переносы внутри абзаца склеиваем: в исходниках строки обёрнуты
  // по 80 символов, иначе Doc развалится на обрывки по одной строке.
  const lines = [];
  let para = '';
  const flush = () => { if (para) { lines.push(para); para = ''; } };
  for (const raw of md.split('\n')) {
    const l = raw.trimEnd();
    if (!l.trim()) { flush(); lines.push(''); continue; }
    if (/^(#{1,6}\s|[-*—]\s|\d+\.\s|>|\||```)/.test(l.trim())) { flush(); lines.push(l); continue; }
    para = para ? `${para} ${l.trim()}` : l.trim();
  }
  flush();

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { text += '\n'; continue; }

    const m1 = line.match(/^#\s+(.+)$/);
    const m2 = line.match(/^##\s+(.+)$/);
    const m3 = line.match(/^###\s+(.+)$/);
    const bul = line.match(/^[-*—]\s+(.+)$/);
    const head = m1 || m2 || m3;

    if (head) {
      const start = text.length;
      const inner = processInline(head[1]);
      text += inner.text + '\n';
      const range = { start, end: text.length };
      (m1 ? h1 : m2 ? h2 : h3).push(range);
      for (const b of inner.bold) bold.push({ start: start + b.start, end: start + b.end });
      continue;
    }
    if (bul) {
      const start = text.length;
      const inner = processInline(bul[1]);
      text += inner.text + '\n';
      bullets.push({ start, end: text.length });
      for (const b of inner.bold) bold.push({ start: start + b.start, end: start + b.end });
      for (const l of inner.links) links.push({ start: start + l.start, end: start + l.end, url: l.url });
      continue;
    }
    const start = text.length;
    const inner = processInline(line);
    text += inner.text + '\n';
    for (const b of inner.bold) bold.push({ start: start + b.start, end: start + b.end });
    for (const l of inner.links) links.push({ start: start + l.start, end: start + l.end, url: l.url });
  }

  text = text.replace(/\n+$/, '\n');
  if (!text.trim()) return [];

  const reqs = [{ insertText: { location: { index: 1 }, text } }];
  const style = (ranges, named) => {
    for (const r of ranges) {
      reqs.push({
        updateParagraphStyle: {
          range: { startIndex: 1 + r.start, endIndex: 1 + r.end },
          paragraphStyle: { namedStyleType: named },
          fields: 'namedStyleType',
        },
      });
    }
  };
  style(h1, 'HEADING_1');
  style(h2, 'HEADING_2');
  style(h3, 'HEADING_3');

  for (const r of bullets) {
    reqs.push({
      createParagraphBullets: {
        range: { startIndex: 1 + r.start, endIndex: 1 + r.end },
        bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  }
  for (const r of bold) {
    reqs.push({
      updateTextStyle: {
        range: { startIndex: 1 + r.start, endIndex: 1 + r.end },
        textStyle: { bold: true },
        fields: 'bold',
      },
    });
  }
  /* Внутренние ссылки статей записаны от корня: «/blog/<слаг>» — Google
   * достраивал из этого «http:///blog/...», битую ссылку в каждом доке.
   * Разрешаем по-настоящему: домен принимающего проекта, если он назван,
   * иначе — материал Контур.Маркета на ту же тему из каталога проекта.
   * Не нашли уверенного соответствия — ссылки нет, текст остаётся
   * текстом, а сам факт попадает в unresolved и печатается вызывающему. */
  for (const l of links) {
    const resolved = resolveInternalLink(l.url, { blogBase: BLOG_BASE });
    if (!resolved) { unresolved.push(l.url); continue; }
    const url = resolved.url;
    reqs.push({
      updateTextStyle: {
        range: { startIndex: 1 + l.start, endIndex: 1 + l.end },
        textStyle: { link: { url } },
        fields: 'link',
      },
    });
  }
  return reqs;
}

/** **bold** и [text](url) → чистый текст + диапазоны. */
function processInline(line) {
  let text = '';
  const bold = [], links = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '*' && line[i + 1] === '*') {
      const end = line.indexOf('**', i + 2);
      if (end > i + 2) {
        const start = text.length;
        text += line.slice(i + 2, end);
        bold.push({ start, end: text.length });
        i = end + 2;
        continue;
      }
    }
    if (line[i] === '[') {
      const cb = line.indexOf(']', i + 1);
      if (cb > i && line[cb + 1] === '(') {
        const cp = line.indexOf(')', cb + 2);
        if (cp > cb) {
          const start = text.length;
          text += line.slice(i + 1, cb);
          links.push({ start, end: text.length, url: line.slice(cb + 2, cp) });
          i = cp + 1;
          continue;
        }
      }
    }
    text += line[i];
    i++;
  }
  return { text, bold, links };
}

/* ────────────────────────────────────────────────────────── операции ──── */
async function findInFolder(name, parent, mime) {
  const q = [
    `name='${name.replace(/'/g, "\\'")}'`,
    `'${parent}' in parents`,
    'trashed=false',
    mime ? `mimeType='${mime}'` : null,
  ].filter(Boolean).join(' and ');
  const r = await drive(`files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)`);
  return r.files?.[0] ?? null;
}

async function ensureFolder(name, parent) {
  const found = await findInFolder(name, parent, 'application/vnd.google-apps.folder');
  if (found) return found;
  return withQuotaFallback(() =>
    drive('files?fields=id,name,webViewLink', {
      method: 'POST',
      body: JSON.stringify({
        name,
        parents: [parent],
        mimeType: 'application/vnd.google-apps.folder',
      }),
    })
  );
}

async function createSheet(name, parent) {
  return withQuotaFallback(() =>
    drive('files?fields=id,name,webViewLink', {
      method: 'POST',
      body: JSON.stringify({
        name,
        parents: [parent],
        mimeType: 'application/vnd.google-apps.spreadsheet',
      }),
    })
  );
}

/* ─────────────────────────────── одна таблица вместо десятков файлов ──── */
/* До 11.08.2026 каждая неделя бэклога и каждый цикл заводили отдельный
 * файл: 52 таблицы бэклога и 12 таблиц плана в год. Держалось это на
 * одном: письмо от Google приходит только при первой выдаче доступа к
 * новому файлу, и новый файл работал уведомлением «бэклог приехал».
 * Цена оказалась выше пользы — редакция искала нужную ссылку среди
 * одинаковых названий, а доступ приходилось выдавать заново каждую
 * неделю каждому. Теперь всё живёт в одной таблице: неделя — вкладка,
 * цикл — вкладка. Ссылка у редактора одна и навсегда. */
const WORKSPACE_NAME = 'Редакция — темы и план';
const backlogTabName = (week) => `Темы ${week}`;
const planTabName = (cycle) => `План ${cycle}`;

/** Таблица редакции: одна на всё, заводится при первом обращении. */
async function workspace() {
  const found = await findInFolder(WORKSPACE_NAME, ROOT_FOLDER, 'application/vnd.google-apps.spreadsheet');
  return found || createSheet(WORKSPACE_NAME, ROOT_FOLDER);
}

/* ─────────────────────────────────────────── реестр написанного ──── */

const BLOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'content', 'blog');

/** Написанные статьи из frontmatter: источник правды — файлы, не таблица. */
function writtenArticles() {
  if (!existsSync(BLOG_DIR)) return [];
  const out = [];
  for (const f of readdirSync(BLOG_DIR).filter((n) => /\.mdx?$/.test(n))) {
    const raw = readFileSync(join(BLOG_DIR, f), 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    const fm = m[1];
    const one = (re) => (fm.match(re) ?? [])[1]?.trim().replace(/^["']|["']$/g, '') || '';
    // Первый ключ из seo.keywords — целевой запрос статьи.
    const kw = (fm.match(/keywords:\s*\n\s+-\s+([^\n]+)/) ?? [])[1] || '';
    out.push({
      title: one(/title:\s*(.+)/),
      keyword: kw.trim().replace(/^["']|["']$/g, ''),
      cluster: (fm.match(/categories:\s*\n\s+-\s+([^\n]+)/) ?? [])[1]?.trim() || '',
      date: one(/pubDate:\s*(.+)/),
      words: raw.slice(m[0].length).split(/\s+/).filter(Boolean).length,
      review: one(/reviewDate:\s*(.+)/),
      file: f,
    });
  }
  // Свежие сверху: реестр читают, чтобы вспомнить недавнее.
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/** Вкладка «Написано»: шапка, ширины, защита — редактор её только читает. */
async function formatWrittenSheet(sheetId, gid, rowCount) {
  const lastRow = 2 + rowCount;
  const meta = await sheets(`${sheetId}?fields=sheets(properties(sheetId),protectedRanges(range(sheetId)))`);
  const already = (meta.sheets.find((s) => s.properties.sheetId === gid)?.protectedRanges ?? []).length;

  const requests = [
    {
      updateCells: {
        range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
        rows: [{ values: [{ userEnteredValue: { stringValue:
          `Что уже написано — ${rowCount} статей. Вкладку ведёт бот, править её не нужно: ` +
          'она нужна, чтобы при взгляде на кандидата было видно, писали мы это или нет.' } }] }],
        fields: 'userEnteredValue',
      },
    },
    {
      updateCells: {
        range: { sheetId: gid, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: WRITTEN_COLS.length },
        rows: [{ values: WRITTEN_COLS.map((c) => ({
          userEnteredValue: { stringValue: c.title },
          userEnteredFormat: { textFormat: { bold: true } },
        })) }],
        fields: 'userEnteredValue,userEnteredFormat.textFormat.bold',
      },
    },
    { updateSheetProperties: {
      properties: { sheetId: gid, gridProperties: { frozenRowCount: 2 } },
      fields: 'gridProperties.frozenRowCount',
    } },
    ...WRITTEN_COLS.map((c, i) => ({
      updateDimensionProperties: {
        range: { sheetId: gid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: c.width },
        fields: 'pixelSize',
      },
    })),
  ];

  // Защита ставится один раз: batchUpdate не идемпотентен, и повторные
  // прогоны иначе плодят по диапазону в час.
  if (!already) {
    requests.push({
      addProtectedRange: {
        protectedRange: {
          range: { sheetId: gid },
          description: 'Реестр ведёт бот',
          warningOnly: true,
        },
      },
    });
  }

  await sheets(`${sheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
  return lastRow;
}

/** gid вкладки по имени; нет — создаётся. Свежая вкладка встаёт первой. */
async function ensureTab(sheetId, title, index = 0) {
  const meta = await sheets(`${sheetId}?fields=sheets(properties(sheetId,title,index))`);
  const found = meta.sheets.find((s) => s.properties.title === title);
  if (found) return found.properties.sheetId;

  // В только что созданной таблице уже есть пустой «Лист1». Добавлять
  // рядом ещё один — оставить редактору мусорную вкладку навсегда.
  const first = meta.sheets[0]?.properties;
  if (meta.sheets.length === 1 && /^(Лист1|Sheet1)$/i.test(first.title)) {
    await sheets(`${sheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: first.sheetId, title },
            fields: 'title',
          },
        }],
      }),
    });
    return first.sheetId;
  }

  const res = await sheets(`${sheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title, index } } }],
    }),
  });
  return res.replies[0].addSheet.properties.sheetId;
}

/** Диапазон с именем вкладки: без него Sheets пишет в первую попавшуюся. */
function a1(tab, range) {
  return tab ? `'${String(tab).replace(/'/g, "''")}'!${range}` : range;
}

/** Свежая вкладка нужного вида. Нет таких — первая вкладка файла: так
 *  читаются таблицы, заведённые до перехода на одну общую. */
async function latestTab(sheetId, prefix) {
  const meta = await sheets(`${sheetId}?fields=sheets(properties(sheetId,title,index))`);
  const matching = meta.sheets
    .map((s) => s.properties)
    .filter((p) => p.title.startsWith(prefix))
    .sort((a, b) => b.title.localeCompare(a.title));
  return matching[0] || meta.sheets[0].properties;
}

/** Шапка, легенда, заголовки, ширины, списки и защита ботовых колонок. */
async function formatWorkSheet(sheetId, gid, monthId, rowCount) {
  const lastRow = WORK_FIRST_DATA_ROW + rowCount - 1;
  const meta = await sheets(`${sheetId}?fields=sheets(properties(sheetId),protectedRanges(range(sheetId,startColumnIndex)))`);
  const protectedCols = new Set(
    (meta.sheets.find((sh) => sh.properties.sheetId === gid)?.protectedRanges || [])
      .map((p) => p.range?.startColumnIndex)
      .filter((i) => i !== undefined),
  );
  const requests = [
    {
      updateCells: {
        rows: [
          { values: [{ userEnteredValue: { stringValue: `Темы и статьи — ${monthId}` },
                       userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } }] },
          { values: [
              { userEnteredValue: { stringValue: 'Статус плана:' },
                userEnteredFormat: { textFormat: { bold: true } } },
              { userEnteredValue: { stringValue: 'на согласовании' } },
              { userEnteredValue: { stringValue: '← поставьте «ОДОБРЕН», когда список тем устроит' },
                userEnteredFormat: { textFormat: { italic: true, foregroundColor: { red: 0.45, green: 0.42, blue: 0.4 } } } },
              { userEnteredValue: { stringValue: '' } },
              // E2 — строка состояния цикла, её переписывает cycle-state.mjs
              // sheet-sync на каждом проходе.
              { userEnteredValue: { stringValue: 'Состояние обновится после первого прохода' },
                userEnteredFormat: { textFormat: { italic: true, foregroundColor: { red: 0.45, green: 0.42, blue: 0.4 } } } },
            ] },
        ],
        fields: 'userEnteredValue,userEnteredFormat',
        start: { sheetId: gid, rowIndex: 0, columnIndex: 0 },
      },
    },
    {
      updateCells: {
        rows: [{ values: [{
          userEnteredValue: { stringValue:
            'Одна строка — одна тема, от кандидата до выпуска. «одобрено» берёт тему в работу, '
            + '«написать сейчас» не ждёт очереди, «принято» закрывает вычитку, «убрать» снимает тему '
            + '(тогда нужна причина). Колонки «Статус», «Документ» и «ID» заполняет бот.' },
          userEnteredFormat: { textFormat: { italic: true, foregroundColor: { red: 0.45, green: 0.42, blue: 0.4 } } },
        }] }],
        fields: 'userEnteredValue,userEnteredFormat',
        start: { sheetId: gid, rowIndex: 2, columnIndex: 1 },
      },
    },
    {
      updateCells: {
        rows: [{ values: WORK_COLS.map((c) => ({
          userEnteredValue: { stringValue: c.title },
          userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.91, blue: 0.87 } },
        })) }],
        fields: 'userEnteredValue,userEnteredFormat',
        start: { sheetId: gid, rowIndex: WORK_HEADER_ROW - 1, columnIndex: 0 },
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId: gid, gridProperties: { frozenRowCount: WORK_HEADER_ROW } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
  ];

  WORK_COLS.forEach((c, i) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: gid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        // Скрытая колонка не удалена: данные в ней нужны скриптам, а
        // ширину экрана она не занимает. Развернуть — правой кнопкой по
        // заголовку соседней колонки, «Показать столбцы».
        properties: { pixelSize: c.width, hiddenByUser: Boolean(c.hidden) },
        fields: 'pixelSize,hiddenByUser',
      },
    });
  });

  requests.push({
    setDataValidation: {
      range: { sheetId: gid, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 2 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: ['на согласовании', 'ОДОБРЕН', 'отклонён']
          .map((v) => ({ userEnteredValue: v })) },
        showCustomUi: true, strict: false,
      },
    },
  });

  if (rowCount > 0) {
    const dropdown = (key, values) => ({
      setDataValidation: {
        range: {
          sheetId: gid,
          startRowIndex: WORK_FIRST_DATA_ROW - 1,
          endRowIndex: lastRow,
          startColumnIndex: workIdx(key),
          endColumnIndex: workIdx(key) + 1,
        },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) },
          showCustomUi: true, strict: false,
        },
      },
    });
    requests.push(dropdown('decision', WORK_DECISIONS));
    requests.push(dropdown('who', WORK_WHO));
    requests.push(dropdown('reason', WORK_REASONS));
    // Ботовые колонки больше не идут подряд: «Статус» и «Документ» стоят
    // среди колонок редактора, потому что смотрит он на них постоянно.
    // Значит и защита — по колонке, а не одним диапазоном до конца листа.
    // Уже поставленные не дублируем: formatWorkSheet вызывается повторно
    // при каждом дописывании тем, и защиты копились бы каждую неделю.
    WORK_COLS.forEach((c, i) => {
      if (c.owner !== 'bot') return;
      if (protectedCols.has(i)) return;
      requests.push({
        addProtectedRange: {
          protectedRange: {
            range: {
              sheetId: gid,
              startRowIndex: WORK_HEADER_ROW - 1,
              startColumnIndex: i,
              endColumnIndex: i + 1,
            },
            description: 'Заполняется автоматически',
            warningOnly: true,
          },
        },
      });
    });
  }

  await sheets(`${sheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
  return gid;
}

// Значение ячейки из объекта темы. Ключи разные у кандидатов (generate-backlog)
// и у тем цикла (editorial-cycle.json) — сводим здесь, а не в двух вызывающих.
/* «Зачем сейчас» — обоснование из ресёрча: частотность, что подогревает
 * спрос, к какой дате привязано. Раньше сюда подставлялся ещё и rationale
 * из состояния цикла, и при пересборке месяца живой текст ресёрча
 * заменялся служебной строкой вроде «одобрено редактором в бэклоге» —
 * колонка переставала что-либо объяснять. rationale остаётся запасным
 * вариантом только когда своего текста нет вообще. */
const WORK_ALIASES = { topic: ['title'], why: ['rationale'], doc: ['docUrl'] };
function workCellValue(key, t) {
  if (key === 'n') return null;
  /* «Тема» — сформулированный заголовок статьи, а не фраза из Wordstat.
   * У кандидата из ресёрча в `topic` лежит сырое «1 с маркировка», а в
   * `title` — то, что написала рутина: «Маркировка в 1С: как настроить
   * обмен…». Пока алиас смотрел сначала в `topic`, в таблицу уходила
   * сырая фраза, apply-decisions читал её обратно как правку редактора и
   * затирал заголовок в состоянии цикла. Заголовок главнее. */
  if (key === 'topic') return t.title || t.topic || '';
  if (key === 'segment') return t.segmentLabel || t.segment || '';
  // У инфоповода частотности нет и быть не может: запрос ещё не
  // сформировался, событие только объявили.
  if (key === 'wordstat' && (t.wordstat == null || t.wordstat === '')) {
    return t.type === 'infopovod' ? 'инфоповод' : '';
  }
  if (key === 'related') {
    const rel = t.relatedQueries ?? [];
    if (!rel.length) return '';
    const total = t.wordstatTotal ?? t.wordstat;
    return `${rel.map((r) => `${r.query} (${r.wordstat})`).join('; ')} — всего ${total}`;
  }
  if (key === 'slug') return t.slug || slugify(t.title || t.topic || '');
  // В таблице статус по-русски: внутреннее «review» редактору ни о чём
  // не говорит, а колонка — его главный ориентир.
  if (key === 'status') return RU_STATUS[t.status] || t.status || 'кандидат';
  if (t[key] != null && t[key] !== '') return t[key];
  for (const alias of WORK_ALIASES[key] ?? []) {
    if (t[alias] != null && t[alias] !== '') return t[alias];
  }
  return '';
}

/* Пишем двумя кусками — исследовательские колонки слева и ботовые справа,
 * а колонки редактора между ними не трогаем. Один сплошной PUT затирал бы
 * решения, которые редактор уже проставил: перезаливка строк случается не
 * только при создании вкладки, но и когда в месяц добавляют темы. */
/* Ссылки, для которых не нашлось адреса: ни домена принимающего проекта,
 * ни уверенного соответствия в каталоге Маркета. Это не ошибка скрипта —
 * это список мест, где перелинковку надо доделать руками или дождаться
 * публикации соседней статьи. Молчать о них нельзя: в доке они выглядят
 * обычным текстом, и о том, что автор имел в виду ссылку, никто не узнает. */
function reportUnresolved(list) {
  console.error(`\n⚠ Внутренних ссылок без адреса: ${list.length}`);
  for (const u of list) console.error(`   ${u}`);
  console.error('   В доке они остались текстом. Задайте BLOG_BASE_URL или');
  console.error('   поставьте ссылку на материал Контура вручную.');
}

async function writeWorkRows(sheetId, tab, items) {
  const lastRow = WORK_FIRST_DATA_ROW + items.length - 1;
  /* Пишем по одной колонке — колонки редактора пропускаем. Сплошной PUT
     затирал бы решения, которые редактор уже проставил: перезаливка
     случается не только при создании вкладки, но и когда в месяц
     добавляют темы. Раньше колонки редактора шли подряд и хватало двух
     кусков; теперь «Решение» и «Правка» стоят среди ботовых. */
  const data = WORK_COLS
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.owner !== 'editor')
    .map(({ c, i }) => ({
      range: a1(tab, `${colLetter(i)}${WORK_FIRST_DATA_ROW}:${colLetter(i)}${lastRow}`),
      values: items.map((t, r) => [c.key === 'n' ? r + 1 : workCellValue(c.key, t)]),
    }));

  await sheets(`${sheetId}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
}

/** Читает вкладку месяца: решения редактора + состояние строк. */
async function readWork(sheetId, tab) {
  const target = tab || (await latestTab(sheetId, WORK_TAB_PREFIX)).title;
  const range = a1(target, `A1:${colLetter(WORK_COLS.length - 1)}1000`);
  const r = await sheets(`${sheetId}/values/${encodeURIComponent(range)}`);
  const rows = r.values || [];

  /* Колонки ищем по заголовку, а не по номеру. Позиционное чтение ломается
   * молча: 11.08.2026 в набор добавили «Сегмент» и «Связки», и вкладки,
   * написанные раньше, начали читаться со сдвигом — решение редактора
   * уезжало в соседнее поле, а рутина разбирала причину отказа как решение. */
  const header = (rows[WORK_HEADER_ROW - 1] || []).map((h) => (h || '').trim().toLowerCase());
  const titles = new Set(WORK_COLS.map((c) => c.title.toLowerCase()));
  const byTitle = header.some((h) => titles.has(h))
    ? new Map(header.map((h, idx) => [h, idx]))
    : new Map(WORK_COLS.map((c, idx) => [c.title.toLowerCase(), idx]));

  const items = [];
  const topicIdx = byTitle.get('тема') ?? workIdx('topic');
  for (let i = WORK_FIRST_DATA_ROW - 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const topic = (row[topicIdx] || '').trim();
    if (!topic) continue;
    const item = { row: i + 1 };
    WORK_COLS.forEach((c) => {
      if (c.key === 'n') return;
      const idx = byTitle.has(c.title.toLowerCase()) ? byTitle.get(c.title.toLowerCase()) : null;
      item[c.key] = idx === null ? '' : (row[idx] || '').trim();
    });
    const movedWho = DECISION_TO_WHO.get((item.decision || '').toLowerCase());
    if (movedWho && !item.who) item.who = movedWho;
    const canonical = normalizeDecision(item.decision);
    if (canonical !== item.decision) item.decisionRaw = item.decision;
    item.decision = canonical;
    // Отсрочка, проставленная в «Кто пишет» до 11.08.2026, читается как причина.
    if (item.who && item.who.toLowerCase() === 'пока неактуально') {
      item.who = '';
      if (!item.reason) item.reason = 'пока рано — вернуть позже';
    }
    // cycle-state.mjs ждёт эти имена — они же были у таблицы плана.
    item.title = item.topic;
    item.docUrl = item.doc;
    items.push(item);
  }
  return {
    sheetId,
    tab: target,
    approval: (rows[1]?.[1] || '').trim(),
    // Заголовки отдаём как есть: по ним verify-sheet.mjs ловит расхождение
    // раскладки — единственный способ заметить, что скрипт пишет не в ту
    // колонку, до того как это увидит редактор.
    columns: header,
    items,
    topics: items,   // старое имя: cycle-state apply-decisions читает topics
  };
}

/* ─────────────────────────────────────────────────────── подкоманды ───── */
const cmd = process.argv[2];

try {
  switch (cmd) {
    case 'init-root': {
      // Корневую папку создаёт само приложение, и это не прихоть.
      //
      // На пути OAuth скоуп drive.file даёт доступ только к файлам, которые
      // приложение создало. Папку, сделанную человеком руками, оно не видит:
      // попытка создать что-то внутри неё возвращает 404, будто её нет.
      // Поэтому папку заводит бот, а человек просто открывает её по ссылке
      // и работает как обычно — владелец файлов всё равно владелец токена.
      const name = arg('name', 'Контур — редакция');

      if (DRY_RUN) {
        console.log(JSON.stringify({ dryRun: true, name }, null, 2));
        break;
      }

      const folder = await withQuotaFallback(() =>
        drive('files?fields=id,name,webViewLink', {
          method: 'POST',
          body: JSON.stringify({
            name,
            mimeType: 'application/vnd.google-apps.folder',
          }),
        })
      );

      console.log(JSON.stringify({
        folderId: folder.id,
        folderUrl: folder.webViewLink,
        name: folder.name,
      }, null, 2));
      console.log('\nПоложите folderId в секрет GOOGLE_DOCS_FOLDER_ID,');
      console.log('а ссылку отдайте редактору — папка уже в его аккаунте.');
      break;
    }

    /* Одна вкладка на месяц: кандидаты и статьи в одной таблице.
       Повторный запуск переиспользует вкладку и перезаливает строки,
       не трогая колонки редактора. */
    case 'init-month':
    case 'init-cycle': {
      const month = arg('month') || arg('cycle') || new Date().toISOString().slice(0, 7);
      const itemsPath = arg('items') || arg('plan');
      if (!ROOT_FOLDER) die('GOOGLE_DOCS_FOLDER_ID не задан');
      if (!itemsPath || !existsSync(itemsPath)) die('нужен --items <файл с темами>');
      const items = JSON.parse(readFileSync(itemsPath, 'utf8'));
      if (!Array.isArray(items) || !items.length) die('список тем пуст');

      if (DRY_RUN) {
        console.log(JSON.stringify({ dryRun: true, month, items: items.length, rootFolder: ROOT_FOLDER }, null, 2));
        break;
      }

      // Папка месяца остаётся: в ней лежат Google Doc'и статей.
      const folder = await ensureFolder(month, ROOT_FOLDER);
      const sheet = await workspace();
      const tab = workTabName(month);
      const gid = await ensureTab(sheet.id, tab);

      await formatWorkSheet(sheet.id, gid, month, items.length);
      await writeWorkRows(sheet.id, tab, items);

      console.log(JSON.stringify({
        month,
        folderId: folder.id,
        folderUrl: folder.webViewLink,
        sheetId: sheet.id,
        tab,
        gid,
        sheetUrl: `https://docs.google.com/spreadsheets/d/${sheet.id}/edit#gid=${gid}`,
        items: items.length,
      }, null, 2));
      break;
    }

    /* Дописать темы в конец вкладки месяца. Ресёрч еженедельный, вкладка
       месячная: новые кандидаты встают строками ниже, прежние решения
       редактора не трогаются. Номера строк приходят из cycle-state
       add-candidates — там же отсекаются дубли по слагу. */
    case 'append-topics': {
      const sheetId = arg('sheet-id');
      const itemsPath = arg('items') || arg('plan');
      if (!sheetId) die('нужен --sheet-id');
      if (!itemsPath || !existsSync(itemsPath)) die('нужен --items <файл>');
      const items = JSON.parse(readFileSync(itemsPath, 'utf8'));
      if (!Array.isArray(items) || !items.length) {
        console.log('Новых тем нет — дописывать нечего.');
        break;
      }
      const tab = arg('tab') || (await latestTab(sheetId, WORK_TAB_PREFIX)).title;
      const gid = await ensureTab(sheetId, tab);

      // Пишем по номерам строк, которые уже назначил cycle-state: так
      // таблица и состояние не разъедутся даже если между шагами кто-то
      // добавил строку руками.
      const data = [];
      for (const t of items) {
        WORK_COLS.forEach((c, i) => {
          if (c.owner === 'editor') return;
          data.push({
            range: a1(tab, `${colLetter(i)}${t.row}`),
            values: [[c.key === 'n' ? t.row - WORK_FIRST_DATA_ROW + 1 : workCellValue(c.key, t)]],
          });
        });
      }
      await sheets(`${sheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      });

      // Списки и защита должны накрыть и новые строки.
      const lastRow = Math.max(...items.map((t) => t.row));
      await formatWorkSheet(sheetId, gid, tab.replace(WORK_TAB_PREFIX, ''), lastRow - WORK_FIRST_DATA_ROW + 1);

      console.log(JSON.stringify({
        tab, added: items.length, lastRow,
        sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${gid}`,
      }, null, 2));
      break;
    }

    case 'pull': {
      const sheetId = arg('sheet-id');
      if (!sheetId) die('нужен --sheet-id');
      console.log(JSON.stringify(await readWork(sheetId, arg('tab')), null, 2));
      break;
    }

    /* Реестр написанного. Вкладка месяца живёт месяц, а корпус — всегда;
       без реестра «мы это уже писали?» проверяется только памятью. Идёт
       последней вкладкой: смотрят её изредка, при спорном кандидате. */
    case 'sync-written': {
      const sheetId = arg('sheet-id');
      if (!sheetId) die('нужен --sheet-id');
      const articles = writtenArticles();
      if (!articles.length) { console.log('Написанных статей нет — вкладку не трогаю.'); break; }

      // Индекс = число вкладок: реестр встаёт последним, за вкладками
      // месяцев. Больший индекс Sheets не принимает.
      const tabs = (await sheets(`${sheetId}?fields=sheets(properties(title))`)).sheets.length;
      const gid = await ensureTab(sheetId, WRITTEN_TAB, tabs);
      await formatWrittenSheet(sheetId, gid, articles.length);
      await sheets(`${sheetId}/values/${encodeURIComponent(a1(WRITTEN_TAB, `A3:${colLetter(WRITTEN_COLS.length - 1)}${2 + articles.length}`))}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        body: JSON.stringify({
          values: articles.map((a, i) => [
            i + 1, a.title, a.keyword, a.cluster, a.date, a.words, a.review, a.file,
          ]),
        }),
      });
      console.log(`✅ Вкладка «${WRITTEN_TAB}»: ${articles.length} статей`);
      break;
    }

    /* Осталось именем для рутины A0, но заводит не отдельную таблицу
       недели, а ту же вкладку месяца: бэклог теперь месячный. */
    case 'init-backlog': {
      const week = arg('week') || new Date().toISOString().slice(0, 10);
      console.log(`ℹ init-backlog переехал в init-month: неделя ${week} → месяц ${week.slice(0, 7)}`);
      console.log('  Запустите: node scripts/drive-sync.mjs init-month --month ' + week.slice(0, 7) + ' --items <файл>');
      process.exit(2);
      break;
    }

    case 'push-plan': {
      const sheetId = arg('sheet-id');
      const planPath = arg('plan') || arg('items');
      if (!sheetId) die('нужен --sheet-id');
      if (!planPath || !existsSync(planPath)) die('нужен --plan <файл>');
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      const tab = arg('tab') || (await latestTab(sheetId, WORK_TAB_PREFIX)).title;
      const gid = await ensureTab(sheetId, tab);
      await formatWorkSheet(sheetId, gid, tab.replace(WORK_TAB_PREFIX, ''), plan.length);
      await writeWorkRows(sheetId, tab, plan);
      console.log(`✅ Вкладка «${tab}» обновлена: ${plan.length} тем`);
      break;
    }

    /* Списки решений по строкам: у каждой темы свой набор, по её статусу.
       Ставится после set-cells, из вывода cycle-state.mjs row-decisions. */
    case 'set-row-dropdowns': {
      const sheetId = arg('sheet-id');
      const updates = JSON.parse(arg('updates') || '[]');
      if (!sheetId) die('нужен --sheet-id');
      if (!updates.length) die('нужен --updates \'[{"row":5,"values":["принято"]}]\'');
      const tab = arg('tab');
      const gid = tab
        ? await ensureTab(sheetId, tab)
        : (await latestTab(sheetId, WORK_TAB_PREFIX)).sheetId;
      const col = workIdx('decision');
      await sheets(`${sheetId}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: updates.map((u) => ({
            setDataValidation: {
              range: {
                sheetId: gid,
                startRowIndex: u.row - 1,
                endRowIndex: u.row,
                startColumnIndex: col,
                endColumnIndex: col + 1,
              },
              rule: {
                condition: {
                  type: 'ONE_OF_LIST',
                  values: u.values.map((v) => ({ userEnteredValue: v })),
                },
                // Нестрого — как и общий список: подсказка, а не запрет.
                showCustomUi: true, strict: false,
              },
            },
          })),
        }),
      });
      console.log(`✅ Списки решений обновлены: ${updates.length} строк`);
      break;
    }

    case 'set-cells': {
      const sheetId = arg('sheet-id');
      const updates = JSON.parse(arg('updates') || '[]');
      if (!sheetId) die('нужен --sheet-id');
      if (!updates.length) die('нужен --updates \'[{"range":"S5","value":"..."}]\'');
      /* cycle-state.mjs присылает голые «S5»: про вкладки он не знает и
         знать не должен. Имя подставляем здесь — иначе статусы уедут в
         первую вкладку файла. Своё имя в диапазоне уважается как есть. */
      const workTab = arg('tab') || (await latestTab(sheetId, WORK_TAB_PREFIX)).title;
      await sheets(`${sheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: updates.map((u) => ({
            range: u.range.includes('!') ? u.range : a1(workTab, u.range),
            values: [[u.value]],
          })),
        }),
      });
      console.log(`✅ Обновлено ячеек: ${updates.length}`);
      break;
    }

    case 'make-doc': {
      const title = arg('title');
      const mdPath = arg('md');
      const parent = arg('folder') || ROOT_FOLDER;
      if (!title) die('нужен --title');
      if (!mdPath || !existsSync(mdPath)) die('нужен --md <файл>');
      const md = readFileSync(mdPath, 'utf8');

      if (DRY_RUN) {
        console.log(JSON.stringify({ dryRun: true, title, parent, requests: mdToDocRequests(md).length }, null, 2));
        break;
      }

      /* Док с таким названием уже есть — переписываем его содержимое, а не
       * заводим новый. Раньше старый удалялся: вместе с ним исчезали
       * комментарии редактора и менялась ссылка, на которую он смотрит и
       * которая записана в состоянии цикла. Перезалить текст после правки
       * фактов — обычное дело, терять из-за этого вычитку нельзя. */
      const unresolved = [];
      const existing = await findInFolder(title, parent, 'application/vnd.google-apps.document');
      if (existing) {
        const doc = await docs(`documents/${existing.id}?fields=body(content(endIndex))`);
        const end = doc.body?.content?.at(-1)?.endIndex ?? 1;
        const reqs = mdToDocRequests(md, unresolved);
        await docs(`documents/${existing.id}:batchUpdate`, {
          method: 'POST',
          body: JSON.stringify({
            requests: [
              // endIndex последнего элемента указывает за перевод строки,
              // который удалить нельзя — отсюда -1.
              ...(end > 2 ? [{ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } }] : []),
              ...reqs,
            ],
          }),
        });
        console.log(JSON.stringify({
          docId: existing.id,
          url: existing.webViewLink || `https://docs.google.com/document/d/${existing.id}/edit`,
          rewritten: true,
          unresolvedLinks: unresolved,
        }, null, 2));
        if (unresolved.length) reportUnresolved(unresolved);
        break;
      }

      const created = await withQuotaFallback(() =>
        drive('files?fields=id,webViewLink', {
          method: 'POST',
          body: JSON.stringify({
            name: title,
            parents: [parent],
            mimeType: 'application/vnd.google-apps.document',
          }),
        })
      );
      const reqs = mdToDocRequests(md, unresolved);
      if (reqs.length) {
        await docs(`documents/${created.id}:batchUpdate`, {
          method: 'POST',
          body: JSON.stringify({ requests: reqs }),
        });
      }
      console.log(JSON.stringify({ docId: created.id, url: created.webViewLink }, null, 2));
      break;
    }

    case 'export-doc': {
      const docId = arg('doc-id');
      if (!docId) die('нужен --doc-id');
      const t = await auth();
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/markdown`,
        { headers: { Authorization: `Bearer ${t}` } }
      );
      if (!res.ok) die(`экспорт ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const md = await res.text();
      const out = arg('out');
      if (out) {
        writeFileSync(out, md);
        console.log(`✅ ${md.length} симв. → ${out}`);
      } else {
        process.stdout.write(md);
      }
      break;
    }

    case 'comments': {
      const docId = arg('doc-id');
      if (!docId) die('нужен --doc-id');
      const r = await drive(
        `files/${docId}/comments?fields=comments(id,content,resolved,author(displayName),quotedFileContent(value),replies(id,content,author(displayName)))&includeDeleted=false&pageSize=100`
      );
      const open = (r.comments || []).filter((c) => !c.resolved);
      console.log(JSON.stringify(open, null, 2));
      break;
    }

    /* Новое замечание в файле. Раньше скрипт умел только читать
       комментарии и отвечать в существующем треде — а cycle-listen.md
       требует «оставить комментарий к ячейке с переспросом», когда
       правка редактора непонятна. Выполнить это было нечем, и рутина
       либо угадывала, либо молчала.

       Привязку к конкретной ячейке или куску текста (anchor) API не
       даёт: поле есть, но формат для Sheets не документирован. Поэтому
       комментарий файловый, а на строку ссылаемся текстом — «строка 7,
       колонка „Правка“». */
    case 'comment': {
      const fileId = arg('file-id') || arg('doc-id') || arg('sheet-id');
      const text = arg('text');
      const mention = arg('mention');
      if (!fileId || !text) die('нужны --file-id и --text');
      const content = mention ? `+${mention} ${text}` : text;
      // fields на создании — только id: mentionedEmailAddresses в списке
      // полей POST отвергается («Invalid field selection»), хотя на
      // чтении отдаётся. Поэтому создаём, потом перечитываем.
      const r = await drive(`files/${fileId}/comments?fields=id`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
      console.log(`✅ Замечание оставлено: ${r.id}`);
      if (mention) {
        const back = await drive(`files/${fileId}/comments/${r.id}?fields=mentionedEmailAddresses`);
        const seen = (back.mentionedEmailAddresses || []).length > 0;
        console.log(
          seen
            ? `   Упоминание разобрано: ${back.mentionedEmailAddresses.join(', ')}`
            : '   ⚠ Упоминание не разобрано Drive.',
        );
        console.log('   Письмо по упоминанию Google не гарантирует. Нужно наверняка — notify.');
      }
      break;
    }

    case 'reply': {
      const docId = arg('doc-id');
      const commentId = arg('comment-id');
      const text = arg('text');
      if (!docId || !commentId || !text) die('нужны --doc-id, --comment-id, --text');
      await drive(`files/${docId}/comments/${commentId}/replies?fields=id`, {
        method: 'POST',
        body: JSON.stringify({
          content: text,
          ...(process.argv.includes('--resolve') ? { action: 'resolve' } : {}),
        }),
      });
      console.log(`✅ Ответ отправлен${process.argv.includes('--resolve') ? ' и замечание закрыто' : ''}`);
      break;
    }

    /* Единственный канал, которым модуль может дотянуться до почты
       редактора. Письмо шлёт сам Google при выдаче доступа к файлу —
       это работает всегда, в отличие от упоминаний в комментариях.

       Отсюда правило: батч зовёт редактора по каждому свежесозданному
       доку. Док новый, явного доступа у редактора на него нет (он
       наследуется от папки), поэтому permissions.create проходит и
       письмо уходит. На папку или таблицу плана, к которым доступ уже
       выдан, второго письма не будет — Drive вернёт дубликат, и мы
       честно об этом скажем, а не сделаем вид, что позвали. */
    case 'notify': {
      const fileId = arg('file-id') || arg('doc-id') || arg('sheet-id');
      const to = arg('to');
      const message = arg('message', '');
      const role = arg('role', 'writer');
      if (!fileId || !to) die('нужны --file-id и --to editor@mail');

      const already = await drive(`files/${fileId}/permissions?fields=permissions(emailAddress,role)`);
      if ((already.permissions || []).some((p) => p.emailAddress === to)) {
        console.log(`⚠ У ${to} доступ к этому файлу уже есть — письма не будет.`);
        console.log('  Письмо уходит только при первой выдаче доступа. Зовите по свежему доку.');
        process.exit(2);
      }

      const params = new URLSearchParams({ sendNotificationEmail: 'true', fields: 'id' });
      if (message) params.set('emailMessage', message);
      await drive(`files/${fileId}/permissions?${params}`, {
        method: 'POST',
        body: JSON.stringify({ type: 'user', role, emailAddress: to }),
      });
      console.log(`✅ Доступ выдан (${role}), письмо от Google ушло на ${to}`);
      break;
    }

    /* Диагностика перед первым запуском: какой путь аутентификации,
       какие скоупы реально выданы, доступны ли API и папка. */
    case 'check': {
      let bad = 0;

      console.log('Учётные данные');
      console.log(`  GOOGLE_DOCS_KEY       ${RAW_KEY ? 'задан' : '—'}`);
      console.log(`  GSC_CLIENT_ID         ${OAUTH_ID ? 'задан' : '—'}`);
      console.log(`  GSC_REFRESH_TOKEN     ${OAUTH_REFRESH ? 'задан' : '—'}`);
      console.log(`  GOOGLE_DOCS_FOLDER_ID ${ROOT_FOLDER || '— НЕ ЗАДАН'}`);
      console.log(`  DRIVE_AUTH            ${AUTH_PREF || '— (авто: сервисный аккаунт, если задан)'}`);
      if (!AUTH_PREF && RAW_KEY && OAUTH_REFRESH) {
        console.log('    ⚠ Настроены оба доступа, победит сервисный аккаунт.');
        console.log('      Без общего диска он создать файл не сможет — ставьте DRIVE_AUTH=oauth.');
      }
      if (!ROOT_FOLDER) bad++;

      const t = await auth();
      console.log(`\nПуть аутентификации: ${AUTH_MODE === 'sa' ? 'сервисный аккаунт' : 'OAuth refresh_token'}`);
      if (AUTH_MODE === 'sa') {
        console.log('  ⚠ Сервисный аккаунт не имеет своей квоты Drive.');
        console.log('    При storageQuotaExceeded будет откат на OAuth, если он настроен.');
      }

      // Какие скоупы реально в токене.
      //
      // drive.file (non-sensitive) закрывает всё сразу: Drive, Sheets и Docs
      // принимают его для файлов, созданных самим приложением. Папку цикла,
      // таблицу и доки создаёт бот, поэтому одного drive.file достаточно и
      // верификация приложения в Google не нужна.
      // Запасной комплект — sensitive-скоупы spreadsheets + documents.
      const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${t}`);
      const granted = info.ok ? ((await info.json()).scope || '').split(/\s+/) : [];
      const has = (s) => granted.some((g) => g.endsWith(`/auth/${s}`));
      const full = has('drive');
      const perFile = has('drive.file') || full;
      const sensitive = has('spreadsheets') && has('documents');

      console.log('\nСкоупы в выданном токене:');
      if (granted.length === 0) {
        console.log('  ⚠ tokeninfo не ответил — пропускаю проверку скоупов');
      } else {
        console.log(`  ${perFile ? '✅' : '❌'} drive.file${full ? ' (через полный drive)' : ''}` +
                    '   доступ к файлам, созданным ботом');
        console.log(`  ${has('spreadsheets') ? '✅' : '·'} spreadsheets   запасной, sensitive`);
        console.log(`  ${has('documents') ? '✅' : '·'} documents      запасной, sensitive`);

        if (perFile) {
          console.log('\n  Достаточно drive.file — Sheets и Docs принимают его для своих файлов.');
          if (has('spreadsheets') || has('documents')) {
            console.log('  ⚠ Есть и sensitive-скоупы. Работать будет, но ради Production\n' +
                        '    их лучше убрать: с ними Google требует верификацию приложения.');
          }
        } else if (sensitive) {
          console.log('\n  ⚠ drive.file нет, но есть spreadsheets + documents — заработает.');
          console.log('    Минус: sensitive-скоупы требуют верификации для Production,\n' +
                      '    а в статусе Testing токен умирает через 7 дней.');
        } else {
          console.log('\n  ❌ Прав не хватает. Нужен drive.file (проще всего)\n' +
                      '     или пара spreadsheets + documents.');
          console.log(AUTH_MODE === 'oauth'
            ? '     На пути OAuth это чинится ТОЛЬКО переполучением refresh_token\n' +
              '     с prompt=consent — галочка в консоли старый токен не расширяет.\n' +
              '     См. docs/google-api-setup.md, шаг 3.'
            : '     Проверь права сервисного аккаунта.');
          bad++;
        }
      }

      // Живы ли API
      console.log('\nДоступность API:');
      for (const [name, url] of [
        ['Drive',  `https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)`],
        ['Sheets', `https://sheets.googleapis.com/v4/spreadsheets/1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`],
      ]) {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
        const body = await r.text();
        if (/has not been used in project|is disabled/i.test(body)) {
          console.log(`  ❌ ${name} API не включён в проекте Google Cloud`);
          bad++;
        } else if (r.status === 403 && /insufficient/i.test(body)) {
          console.log(`  ❌ ${name}: не хватает скоупа`);
          bad++;
        } else if (r.status === 404 && name === 'Sheets') {
          console.log(`  ✅ Sheets API включён (404 на несуществующую таблицу — это норма)`);
        } else if (r.ok) {
          console.log(`  ✅ ${name} API отвечает`);
        } else {
          console.log(`  ⚠ ${name}: HTTP ${r.status} — ${body.slice(0, 120)}`);
        }
      }

      // Общие диски — рабочая схема для сервисного аккаунта.
      //
      // Файл на общем диске принадлежит диску, а не создателю, поэтому
      // личную квоту у сервисного аккаунта никто не спрашивает — а её у
      // него и нет. Если папка цикла лежит в «Моём диске», storageQuota
      // будет вылезать снова и снова, поэтому проверяем это прямо.
      try {
        const dl = await drive('drives?pageSize=20&fields=drives(id,name)');
        const drives = dl.drives ?? [];
        console.log(`\nОбщие диски, видимые этим доступом: ${drives.length}`);
        for (const d of drives) console.log(`  • ${d.name}  (${d.id})`);
        if (!drives.length && AUTH_MODE === 'sa') {
          console.log('  ⚠ Ни одного. Сервисный аккаунт нужно добавить участником');
          console.log('    общего диска — по его client_email, роль «Менеджер контента».');
        }
      } catch (e) {
        console.log(`\n⚠ Список общих дисков получить не вышло: ${e.message.slice(0, 120)}`);
      }

      if (ROOT_FOLDER) {
        try {
          const meta = await drive(
            `files/${ROOT_FOLDER}?fields=id,name,driveId,capabilities(canAddChildren)`,
          );
          const onShared = Boolean(meta.driveId);
          console.log(`\nПапка «${meta.name}»`);
          console.log(`  ${onShared ? '✅' : '⚠ '} ${onShared ? 'на общем диске' : 'в «Моём диске», не на общем'}`);
          console.log(`  ${meta.capabilities?.canAddChildren ? '✅' : '❌'} создавать файлы внутри`);
          if (!onShared && AUTH_MODE === 'sa') {
            console.log('     Сервисный аккаунт не сможет создать здесь файл: в «Моём диске»');
            console.log('     владельцем становится он сам, а места у него нет. Перенесите');
            console.log('     папку на общий диск — это снимает storageQuotaExceeded насовсем.');
          }
        } catch (e) {
          console.log(`\n⚠ Метаданные папки недоступны: ${e.message.slice(0, 120)}`);
        }
      }

      // Можно ли писать в папку.
      //
      // Читать саму папку бесполезно: под drive.file бот её не видит, раз её
      // создал человек, и 404 тут норма, а не ошибка. Единственная честная
      // проверка — создать пробный файл внутри и сразу убрать.
      if (ROOT_FOLDER) {
        let probe = null;
        try {
          probe = await withQuotaFallback(() =>
            drive('files?fields=id', {
              method: 'POST',
              body: JSON.stringify({
                name: `.kontur-probe-${Date.now()}`,
                parents: [ROOT_FOLDER],
                mimeType: 'application/vnd.google-apps.document',
              }),
            })
          );
          console.log('\n✅ Запись в папку работает (пробный файл создан)');
        } catch (e) {
          console.log(`\n❌ В папку ${ROOT_FOLDER} писать не выходит.`);
          if (/storageQuota/i.test(e.message)) {
            console.log('   storageQuotaExceeded: у сервисного аккаунта нет своего места в Drive.');
            console.log('   Лучшее решение — перенести папку на общий диск: там владелец');
            console.log('   файла сам диск, и личная квота не спрашивается. Ключ сервисного');
            console.log('   аккаунта при этом бессрочный, обновлять нечего.');
            console.log('   Запасное — OAuth (GSC_*), но его токен в статусе Testing живёт 7 дней.');
          } else if (/404|notFound/i.test(e.message)) {
            console.log(AUTH_MODE === 'sa'
              ? '   Расшарь папку на client_email сервисного аккаунта с ролью Редактор.'
              : '   Проверь GOOGLE_DOCS_FOLDER_ID и что папка принадлежит аккаунту,\n' +
                '   под которым выдавался токен.');
          } else {
            console.log(`   ${e.message.slice(0, 200)}`);
          }
          bad++;
        }
        if (probe?.id) {
          try {
            await drive(`files/${probe.id}`, { method: 'DELETE' });
            console.log('   Пробный файл удалён.');
          } catch {
            console.log(`   ⚠ Пробный файл ${probe.id} удалить не вышло — убери вручную.`);
          }
        }
      }

      console.log(bad === 0
        ? '\n━━━ Всё готово, можно запускать /cycle-plan ━━━'
        : `\n━━━ Проблем: ${bad}. См. docs/google-api-setup.md ━━━`);
      process.exit(bad ? 1 : 0);
    }

    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].split('/**')[1]);
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  die(e.message);
}
