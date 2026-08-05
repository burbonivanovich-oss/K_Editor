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
 *      📊 Контент-план 2026-08        таблица: темы, решения, статусы
 *      📁 2026-08                     папка цикла
 *         📄 Штраф за работу без ТС ПИоТ
 *         📄 ...
 *
 * Подкоманды:
 *   init-root    [--name "Контур — редакция"]      создать корневую папку
 *   init-cycle   --cycle 2026-08 --plan plan.json   создать папку + таблицу
 *   init-backlog --week 2026-08-04 --items b.json  таблица бэклога тем (A0)
 *   pull-backlog --sheet-id <id>                   решения по бэклогу
 *   push-plan    --cycle 2026-08                    перезалить строки плана
 *   pull         --cycle 2026-08                    прочитать решения редактора
 *   make-doc     --title "..." --md article.md      создать Doc из markdown
 *   export-doc   --doc-id <id> [--out file.md]      Doc → markdown
 *   comments     --doc-id <id>                      нерешённые замечания
 *   reply        --doc-id <id> --comment-id <id> --text "..." [--resolve]
 *   set-cells    --sheet-id <id> --updates '[{"range":"J5","value":"на вычитке"}]'
 *   check                                          диагностика доступа
 *
 * Аутентификация: сервисный аккаунт GOOGLE_DOCS_KEY, с откатом на OAuth
 * refresh_token при storageQuotaExceeded (у сервисного аккаунта нет своей
 * квоты Drive).
 *
 * Окружение:
 *   GOOGLE_DOCS_KEY        сервисный аккаунт (JSON или base64)
 *   GOOGLE_DOCS_FOLDER_ID  корневая папка редакции в Drive
 *   GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN — запасной OAuth
 *   DRY_RUN=1              печатать план запросов и выйти
 *
 * ВАЖНО: в проекте Google Cloud должны быть включены Drive, Docs и Sheets
 * API. Прав достаточно одного скоупа drive.file. Проверить всё разом: `check`.
 * Инструкция по настройке — docs/google-api-setup.md
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';

const ROOT_FOLDER = process.env.GOOGLE_DOCS_FOLDER_ID || '';
const RAW_KEY = process.env.GOOGLE_DOCS_KEY || '';
const OAUTH_ID = process.env.GSC_CLIENT_ID || '';
const OAUTH_SECRET = process.env.GSC_CLIENT_SECRET || '';
const OAUTH_REFRESH = process.env.GSC_REFRESH_TOKEN || '';
const DRY_RUN = process.env.DRY_RUN === '1';

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
const HEADER_ROW = 4;
const FIRST_DATA_ROW = 5;
const APPROVAL_CELL = 'B2';

const COLS = [
  { key: 'n',        title: '#',              width: 40  },
  { key: 'title',    title: 'Тема',           width: 340 },
  { key: 'priority', title: 'Приоритет',      width: 90  },
  { key: 'keyword',  title: 'Целевой запрос', width: 200 },
  { key: 'cluster',  title: 'Кластер',        width: 120 },
  { key: 'why',      title: 'Зачем сейчас',   width: 280 },
  { key: 'decision', title: 'Решение',        width: 130 },  // ← редактор
  { key: 'note',     title: 'Правка',         width: 300 },  // ← редактор
  { key: 'status',   title: 'Статус',         width: 120 },  // ← бот
  { key: 'doc',      title: 'Документ',       width: 200 },  // ← бот
];

const colLetter = (i) => String.fromCharCode(65 + i);
const COL = Object.fromEntries(COLS.map((c, i) => [c.key, colLetter(i)]));

const DECISIONS = ['', 'одобрено', 'убрать', 'пишем сами'];
const STATUSES = ['в плане', 'пишется', 'на вычитке', 'принято', 'выпущено', 'снято'];

/* ─────────────────────────────────────────────────── бэклог тем (A0) ──── */
// Отдельная таблица от контент-плана: у бэклога недельный ритм, у плана
// месячный. Живёт в корневой папке рядом с планом, папки цикла не трогает —
// в бэклоге ещё нет статей, только кандидаты в темы.

const BACKLOG_HEADER_ROW = 3;
const BACKLOG_FIRST_DATA_ROW = 4;

const BACKLOG_COLS = [
  { key: 'n',        title: '#',              width: 40  },
  { key: 'topic',    title: 'Тема',           width: 340 },
  { key: 'cluster',  title: 'Кластер',        width: 120 },
  { key: 'why',      title: 'Зачем сейчас',   width: 320 },
  { key: 'source',   title: 'Источник',       width: 140 },
  { key: 'decision', title: 'Решение',        width: 150 },  // ← редактор
  { key: 'who',      title: 'Кто пишет',      width: 150 },  // ← редактор
  { key: 'reason',   title: 'Причина отказа', width: 280 },  // ← редактор
];

const BACKLOG_DECISIONS = ['согласовано', 'не согласовано'];
const BACKLOG_WHO = ['AI', 'пишем сами', 'пока неактуально'];

/* ─────────────────────────────────────────────────── markdown → Docs ──── */
/** Разбирает markdown в плоский текст + диапазоны стилей для Docs API. */
function mdToDocRequests(md) {
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
  for (const l of links) {
    reqs.push({
      updateTextStyle: {
        range: { startIndex: 1 + l.start, endIndex: 1 + l.end },
        textStyle: { link: { url: l.url } },
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

/** Шапка, заголовки колонок, ширины, выпадающие списки, защита ботовых колонок. */
async function formatSheet(sheetId, cycleId, topicCount) {
  const meta = await sheets(`${sheetId}?fields=sheets(properties(sheetId,title))`);
  const gid = meta.sheets[0].properties.sheetId;
  const lastRow = FIRST_DATA_ROW + topicCount - 1;

  const requests = [
    // Заголовок и переключатель согласования
    {
      updateCells: {
        rows: [
          { values: [{ userEnteredValue: { stringValue: `Контент-план ${cycleId}` },
                       userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } }] },
          { values: [
              { userEnteredValue: { stringValue: 'Статус плана:' },
                userEnteredFormat: { textFormat: { bold: true } } },
              { userEnteredValue: { stringValue: 'на согласовании' } },
              { userEnteredValue: { stringValue: '← поставьте «ОДОБРЕН», когда план устроит' },
                userEnteredFormat: {
                  textFormat: { italic: true, foregroundColor: { red: 0.45, green: 0.42, blue: 0.4 } },
                } },
            ] },
        ],
        fields: 'userEnteredValue,userEnteredFormat',
        start: { sheetId: gid, rowIndex: 0, columnIndex: 0 },
      },
    },
    // Заголовки колонок
    {
      updateCells: {
        rows: [{
          values: COLS.map((c) => ({
            userEnteredValue: { stringValue: c.title },
            userEnteredFormat: {
              textFormat: { bold: true },
              backgroundColor: { red: 0.93, green: 0.91, blue: 0.87 },
            },
          })),
        }],
        fields: 'userEnteredValue,userEnteredFormat',
        start: { sheetId: gid, rowIndex: HEADER_ROW - 1, columnIndex: 0 },
      },
    },
    // Закрепить шапку
    {
      updateSheetProperties: {
        properties: { sheetId: gid, gridProperties: { frozenRowCount: HEADER_ROW } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
  ];

  // Ширины колонок
  COLS.forEach((c, i) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: gid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: c.width },
        fields: 'pixelSize',
      },
    });
  });

  // Выпадающий список согласования плана
  requests.push({
    setDataValidation: {
      range: { sheetId: gid, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 2 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: [
          { userEnteredValue: 'на согласовании' },
          { userEnteredValue: 'ОДОБРЕН' },
          { userEnteredValue: 'отклонён' },
        ]},
        showCustomUi: true, strict: false,
      },
    },
  });

  // Выпадающий список решений по каждой теме
  if (topicCount > 0) {
    requests.push({
      setDataValidation: {
        range: {
          sheetId: gid,
          startRowIndex: FIRST_DATA_ROW - 1,
          endRowIndex: lastRow,
          startColumnIndex: COLS.findIndex((c) => c.key === 'decision'),
          endColumnIndex: COLS.findIndex((c) => c.key === 'decision') + 1,
        },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: DECISIONS.filter(Boolean).map((v) => ({ userEnteredValue: v })) },
          showCustomUi: true, strict: false,
        },
      },
    });
    // Колонки бота — только для чтения, чтобы редактор не правил статусы руками
    requests.push({
      addProtectedRange: {
        protectedRange: {
          range: {
            sheetId: gid,
            startRowIndex: HEADER_ROW - 1,
            startColumnIndex: COLS.findIndex((c) => c.key === 'status'),
            endColumnIndex: COLS.length,
          },
          description: 'Заполняется автоматически',
          warningOnly: true,
        },
      },
    });
  }

  await sheets(`${sheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
  return gid;
}

async function writePlanRows(sheetId, plan) {
  const values = plan.map((t, i) => [
    i + 1,
    t.title,
    t.priority || 'P1',
    t.targetKeyword || '',
    t.cluster || '',
    t.rationale || '',
    '',                        // Решение — редактору
    '',                        // Правка — редактору
    t.status || 'в плане',
    t.docUrl || '',
  ]);
  const range = `A${FIRST_DATA_ROW}:${colLetter(COLS.length - 1)}${FIRST_DATA_ROW + values.length - 1}`;
  await sheets(`${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values }),
  });
}

/** Шапка, заголовки, ширины и выпадающие списки таблицы бэклога. */
async function formatBacklogSheet(sheetId, weekId, rowCount) {
  const meta = await sheets(`${sheetId}?fields=sheets(properties(sheetId,title))`);
  const gid = meta.sheets[0].properties.sheetId;
  const lastRow = BACKLOG_FIRST_DATA_ROW + rowCount - 1;

  const requests = [
    {
      updateCells: {
        rows: [
          { values: [{ userEnteredValue: { stringValue: `Бэклог тем — неделя ${weekId}` },
                       userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } }] },
          { values: [{ userEnteredValue: { stringValue: 'Проставьте решение по каждой теме. При «не согласовано» причина обязательна — иначе тема вернётся на следующей неделе.' },
                       userEnteredFormat: {
                         textFormat: { italic: true, foregroundColor: { red: 0.45, green: 0.42, blue: 0.4 } },
                       } }] },
        ],
        fields: 'userEnteredValue,userEnteredFormat',
        start: { sheetId: gid, rowIndex: 0, columnIndex: 0 },
      },
    },
    {
      updateCells: {
        rows: [{
          values: BACKLOG_COLS.map((c) => ({
            userEnteredValue: { stringValue: c.title },
            userEnteredFormat: {
              textFormat: { bold: true },
              backgroundColor: { red: 0.93, green: 0.91, blue: 0.87 },
            },
          })),
        }],
        fields: 'userEnteredValue,userEnteredFormat',
        start: { sheetId: gid, rowIndex: BACKLOG_HEADER_ROW - 1, columnIndex: 0 },
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId: gid, gridProperties: { frozenRowCount: BACKLOG_HEADER_ROW } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
  ];

  BACKLOG_COLS.forEach((c, i) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: gid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: c.width },
        fields: 'pixelSize',
      },
    });
  });

  if (rowCount > 0) {
    const dropdown = (key, values) => ({
      setDataValidation: {
        range: {
          sheetId: gid,
          startRowIndex: BACKLOG_FIRST_DATA_ROW - 1,
          endRowIndex: lastRow,
          startColumnIndex: BACKLOG_COLS.findIndex((c) => c.key === key),
          endColumnIndex: BACKLOG_COLS.findIndex((c) => c.key === key) + 1,
        },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) },
          showCustomUi: true, strict: false,
        },
      },
    });
    requests.push(dropdown('decision', BACKLOG_DECISIONS));
    requests.push(dropdown('who', BACKLOG_WHO));
  }

  await sheets(`${sheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
  return gid;
}

async function writeBacklogRows(sheetId, items) {
  const values = items.map((t, i) => [
    i + 1,
    t.topic || t.title || '',
    t.cluster || '',
    t.why || t.note || t.rationale || '',
    t.source || '',
    '',  // Решение — редактору
    '',  // Кто пишет — редактору
    '',  // Причина отказа — редактору
  ]);
  const range =
    `A${BACKLOG_FIRST_DATA_ROW}:${colLetter(BACKLOG_COLS.length - 1)}` +
    `${BACKLOG_FIRST_DATA_ROW + values.length - 1}`;
  await sheets(`${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values }),
  });
}

/** Решения редактора из таблицы бэклога — вход для шага 3 рутины A0. */
async function readBacklog(sheetId) {
  const range = `A1:${colLetter(BACKLOG_COLS.length - 1)}1000`;
  const r = await sheets(`${sheetId}/values/${encodeURIComponent(range)}`);
  const rows = r.values || [];
  const out = [];

  for (let i = BACKLOG_FIRST_DATA_ROW - 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const topic = (row[1] || '').trim();
    if (!topic) continue;
    out.push({
      row: i + 1,
      topic,
      cluster: (row[2] || '').trim(),
      why: (row[3] || '').trim(),
      source: (row[4] || '').trim(),
      decision: (row[5] || '').trim(),
      who: (row[6] || '').trim(),
      reason: (row[7] || '').trim(),
    });
  }
  return { sheetId, items: out };
}

async function readSheet(sheetId) {
  const range = `A1:${colLetter(COLS.length - 1)}1000`;
  const r = await sheets(`${sheetId}/values/${encodeURIComponent(range)}`);
  const rows = r.values || [];
  const approval = (rows[1]?.[1] || '').trim();
  const topics = [];
  for (let i = FIRST_DATA_ROW - 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[1]) continue;
    topics.push({
      row: i + 1,
      n: Number(row[0]) || null,
      title: row[1] || '',
      priority: row[2] || 'P1',
      targetKeyword: row[3] || '',
      cluster: row[4] || '',
      rationale: row[5] || '',
      decision: (row[6] || '').trim(),
      note: (row[7] || '').trim(),
      status: (row[8] || '').trim(),
      docUrl: row[9] || '',
    });
  }
  return { approval, topics };
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

    case 'init-cycle': {
      const cycle = arg('cycle') || new Date().toISOString().slice(0, 7);
      const planPath = arg('plan');
      if (!ROOT_FOLDER) die('GOOGLE_DOCS_FOLDER_ID не задан');
      if (!planPath || !existsSync(planPath)) die('нужен --plan <файл с темами>');
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      if (!Array.isArray(plan) || !plan.length) die('план пуст');

      if (DRY_RUN) {
        console.log(JSON.stringify({ dryRun: true, cycle, topics: plan.length, rootFolder: ROOT_FOLDER }, null, 2));
        break;
      }

      const folder = await ensureFolder(cycle, ROOT_FOLDER);
      const sheetName = `Контент-план ${cycle}`;
      let sheet = await findInFolder(sheetName, ROOT_FOLDER, 'application/vnd.google-apps.spreadsheet');
      if (!sheet) sheet = await createSheet(sheetName, ROOT_FOLDER);

      await formatSheet(sheet.id, cycle, plan.length);
      await writePlanRows(sheet.id, plan);

      console.log(JSON.stringify({
        cycleId: cycle,
        folderId: folder.id,
        folderUrl: folder.webViewLink,
        sheetId: sheet.id,
        sheetUrl: sheet.webViewLink || `https://docs.google.com/spreadsheets/d/${sheet.id}`,
        topics: plan.length,
      }, null, 2));
      break;
    }

    case 'pull': {
      const sheetId = arg('sheet-id');
      if (!sheetId) die('нужен --sheet-id');
      console.log(JSON.stringify(await readSheet(sheetId), null, 2));
      break;
    }

    case 'init-backlog': {
      const week = arg('week') || new Date().toISOString().slice(0, 10);
      const itemsPath = arg('items');
      if (!ROOT_FOLDER) die('GOOGLE_DOCS_FOLDER_ID не задан');
      if (!itemsPath || !existsSync(itemsPath)) die('нужен --items <файл с темами>');
      const items = JSON.parse(readFileSync(itemsPath, 'utf8'));
      if (!Array.isArray(items) || !items.length) die('бэклог пуст');

      if (DRY_RUN) {
        console.log(JSON.stringify({ dryRun: true, week, items: items.length, rootFolder: ROOT_FOLDER }, null, 2));
        break;
      }

      // Таблица бэклога лежит в корневой папке рядом с контент-планом:
      // это ещё не статьи, папку цикла заводить не под что.
      const sheetName = `Бэклог тем ${week}`;
      let sheet = await findInFolder(sheetName, ROOT_FOLDER, 'application/vnd.google-apps.spreadsheet');
      if (!sheet) sheet = await createSheet(sheetName, ROOT_FOLDER);

      await formatBacklogSheet(sheet.id, week, items.length);
      await writeBacklogRows(sheet.id, items);

      console.log(JSON.stringify({
        week,
        sheetId: sheet.id,
        sheetUrl: sheet.webViewLink || `https://docs.google.com/spreadsheets/d/${sheet.id}`,
        items: items.length,
      }, null, 2));
      break;
    }

    case 'pull-backlog': {
      const sheetId = arg('sheet-id');
      if (!sheetId) die('нужен --sheet-id');
      console.log(JSON.stringify(await readBacklog(sheetId), null, 2));
      break;
    }

    case 'push-plan': {
      const sheetId = arg('sheet-id');
      const planPath = arg('plan');
      if (!sheetId) die('нужен --sheet-id');
      if (!planPath || !existsSync(planPath)) die('нужен --plan <файл>');
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      await formatSheet(sheetId, arg('cycle', ''), plan.length);
      await writePlanRows(sheetId, plan);
      console.log(`✅ Таблица обновлена: ${plan.length} тем`);
      break;
    }

    case 'set-cells': {
      const sheetId = arg('sheet-id');
      const updates = JSON.parse(arg('updates') || '[]');
      if (!sheetId) die('нужен --sheet-id');
      if (!updates.length) die('нужен --updates \'[{"range":"J5","value":"..."}]\'');
      await sheets(`${sheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: updates.map((u) => ({ range: u.range, values: [[u.value]] })),
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

      const existing = await findInFolder(title, parent, 'application/vnd.google-apps.document');
      if (existing) {
        await withQuotaFallback(() => drive(`files/${existing.id}`, { method: 'DELETE' }));
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
      const reqs = mdToDocRequests(md);
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

    /* Диагностика перед первым запуском: какой путь аутентификации,
       какие скоупы реально выданы, доступны ли API и папка. */
    case 'check': {
      let bad = 0;

      console.log('Учётные данные');
      console.log(`  GOOGLE_DOCS_KEY       ${RAW_KEY ? 'задан' : '—'}`);
      console.log(`  GSC_CLIENT_ID         ${OAUTH_ID ? 'задан' : '—'}`);
      console.log(`  GSC_REFRESH_TOKEN     ${OAUTH_REFRESH ? 'задан' : '—'}`);
      console.log(`  GOOGLE_DOCS_FOLDER_ID ${ROOT_FOLDER || '— НЕ ЗАДАН'}`);
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
