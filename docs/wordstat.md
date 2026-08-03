# Wordstat API — частотность ключей

Кеш частот запросов из Яндекс.Wordstat для приоритизации тем в контент-плане и
аналитики уже опубликованных статей. Заменяет эвристический скоринг в скилле
`/find-topics` на реальные цифры.

## Что лежит и где

```
src/data/wordstat/
  keys.json              # текущий кеш: фраза → частота, тренд, история, related
  snapshots/             # копия keys.json на каждый день weekly-обновления
    YYYY-MM-DD.json
  .candidates.json       # промежуточный список — что нужно запросить (gitignored
                         # не делается, лежит рядом для диагностики)
```

Формат записи в `keys.json`:

```json
{
  "schemaVersion": 1,
  "lastFullUpdate": "2026-05-18",
  "keys": {
    "что такое тс пиот": {
      "phrase": "что такое ТС ПИоТ",
      "priority": 1,
      "sources": ["blog:2026-01-15-chto-takoe-ts-piot.md:seo", "content-plan-2026"],
      "fetchedAt": "2026-05-18T04:12:33.000Z",
      "history": [
        { "date": "2025-05", "count": 720 },
        { "date": "2025-06", "count": 810 },
        ...
        { "date": "2026-04", "count": 1830 }
      ],
      "shows": 1830,
      "trend": "up",
      "topShows": 8240,
      "topPhrase": "тс пиот",
      "related": [
        { "phrase": "тс пиот", "count": 8240 },
        { "phrase": "тс пиот это", "count": 540 },
        ...
      ],
      "relatedFetchedAt": "2026-05-18T04:12:33.000Z"
    }
  }
}
```

Поля:
- `shows` — последний полный месяц истории по **точной** запрошенной фразе.
- `topShows` — максимум среди `related[].count`. Часто намного больше `shows`,
  потому что мы спрашиваем длинную формулировку («ТС ПИоТ обзор»), а аудитория
  ищет короче («тс пиот», «тс пиот это»).
- `topPhrase` — самая популярная вариация (`related[0].phrase`).
- `trend` — `up`/`down`/`stable`/`unknown`. Отношение среднего за последние
  3 мес к среднему за предыдущие 3.
- `history` — до 12 месячных точек, монотонно возрастает по дате.
- `related` — топ-30 похожих запросов с их частотой. Источник идей для новых
  статей (вход для `/find-topics`).

**Важно для скиллов: используйте `max(shows, topShows)` как реальный сигнал
спроса**, а `shows` отдельно — как показатель того, насколько целевая
формулировка совпадает с поведением аудитории. Если `topShows >> shows`,
формулировку стоит переписать на `topPhrase`.

## Два контура

### Контур A — точечная валидация (fetch.mjs)

Берёт известные нам ключи (`seo.keywords` опубликованных статей + «Целевой
запрос» из content-plan) и тянет по ним `/v1/dynamics` (история за 12 мес) +
`/v1/topRequests` (популярные вариации). Цель — подтвердить частоту того,
о чём мы уже пишем.

```
src/content/blog/*.md  seo.keywords  ─┐
src/content/wiki/content-plan-2026.md ┴─► extract-keys.mjs ─► .candidates.json
                                                                     │
                                                                     ▼
                              ┌───────── fetch.mjs ─────────┐
                              │  POST /v1/dynamics  (12mo)  │ ── keys.json
                              │  POST /v1/topRequests       │ ── snapshots/<date>.json
                              └─────────────────────────────┘
```

### Контур B — trend discovery (discover.mjs)

Берёт ~162 широких seed-ов из `discoveries/seeds.json` (зонтичные сущности,
интент-паттерны, проблемы, аудитория) и тянет `/v1/topRequests` numPhrases=2000
на каждый. Результат — до 2000 фраз вокруг каждого seed-а. Через неделю
сравниваем с предыдущей выгрузкой — получаем NEW/RISING/FALLING/DROPPED.
Цель — **открытие новых тем**, которых нет в плане.

```
discoveries/seeds.json ─► discover.mjs ─► discoveries/YYYY-MM-DD/*.json
                                                       │
                                              diff-snapshots.mjs
                                                       │
                                                       ▼
                                         discoveries/diffs/YYYY-MM-DD.md
                                          (читает /find-topics)
```

162 seeds × 1 квота = 162 квоты/неделю. С точечным `fetch.mjs` суммарно
~640 квот/неделю — в пределах 1000/сутки.

Источники ключей и их приоритет:

| Источник | Приоритет | Что значит для fetch |
|---|---|---|
| `frontmatter.seo.keywords` опубликованной статьи | 1 | Обновляем не реже 1 раза в `FRESH_DAYS` (7 дней) |
| Колонка «Целевой запрос» в `content-plan-2026.md` | 1 | То же — для оценки приоритетов P0/P1 |

**Что НЕ собираем:**

- `frontmatter.tags` — теги это категориальные ярлыки, а не информационные
  запросы. Их частота смешивается с чужими интентами (тег «штраф» = автоштрафы,
  тег «алкоголь» = всё подряд). Цифры получаются раздутыми и бесполезными.
- Однословные фразы и чистые числа. Гард в `extract-keys.mjs`:
  `tokens.split(/[\s-]+/).length >= 2`. Те же правила применяются к
  `keys.json` при каждом запуске `fetch.mjs` — старые записи, не проходящие
  гард, удаляются.

## Скрипты

```bash
# Локально — пересобрать список кандидатов
node scripts/wordstat/extract-keys.mjs

# Локально — посмотреть план без сетевых запросов
DRY_RUN=1 node scripts/wordstat/fetch.mjs

# Локально с реальным API (нужны ключ и каталог в env)
YC_API_KEY=… YC_FOLDER_ID=b1ghs… node scripts/wordstat/fetch.mjs
```

Переменные окружения для `fetch.mjs`:

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `YC_API_KEY` | Api-Key сервисного аккаунта Yandex Cloud | — (обязательно) |
| `YC_FOLDER_ID` | ID каталога Yandex Cloud (`b1ghs…`, **не** облака) | — (обязательно) |
| `DRY_RUN` | `1` — печатает план и выходит | `0` |
| `MAX_QUOTA` | потолок квот за прогон | `500` |
| `TOP_REQUESTS_LIMIT` | сколько P1 ключей получают topRequests | `50` |
| `REGION_ID` | Yandex geo ID | `225` (Россия) |
| `FRESH_DAYS` | возраст актуальности | `7` |
| `REQUEST_DELAY_MS` | пауза между запросами | `200` |

## Автозапуск

`.github/workflows/wordstat-weekly.yml` — каждый понедельник в 04:00 UTC.
Запускает `extract-keys.mjs` → `fetch.mjs` → коммит `keys.json` и нового снепшота
обратно в активную ветку.

Ручной запуск: **Actions → Wordstat Weekly Refresh → Run workflow**. Можно
переопределить `max_quota`, `top_requests_limit`, `fresh_days`.

## API

Wordstat больше **не отдельный сервис**. С 2026 года это набор методов внутри
**Yandex Cloud Search API v2** (gRPC + protobuf с REST-обёрткой). Старый
`api.wordstat.yandex.net/v1/*` с OAuth-токеном отключён (404 / битый TLS).

Базовый URL — `https://searchapi.api.cloud.yandex.net/v2/wordstat`, метод всегда
`POST`, в **каждом** теле обязателен `folderId` (ID каталога, не облака):

- `POST /v2/wordstat/dynamics` — частота **точной фразы** по месяцам.
  Поля: `phrase`, `period: "PERIOD_MONTHLY"`, `fromDate`/`toDate` в **RFC3339 с
  временем и `Z`** (голая дата отклоняется), `regions: ["225"]`. Ответ —
  `results[].{date, count, share}`, `count` строкой. **1 квота на ключ.**
- `POST /v2/wordstat/topRequests` — популярные запросы, содержащие фразу
  (`results`) + похожие (`associations`). Поля: `phrase`, `numPhrases` (1..2000,
  **обязательно**), `regions`, `devices: ["DEVICE_ALL"]`. Данные за 30 дней.
  Источник для `topShows` и `topPhrase`. **1 квота на ключ.**

Авторизация и доступ:
- Заголовок `Authorization: Api-Key <ключ>`; ключ принадлежит **сервисному
  аккаунту** с ролью `search-api.webSearch.user` на каталоге.
- `folderId` = ID каталога (`b1ghs…`). Если послать ID облака (`b1gl7…`) — 403
  (gRPC code 7). Биллинг каталога должен быть привязан, иначе тоже 403/402.
- `count` во всех ответах — **строка**, приводим к int (`parseInt`).
- Ошибки в формате `{ code, message, details }`: 3 — InvalidArgument,
  7 — PermissionDenied, 13 — Internal (ретраим), 16 — Unauthenticated.

Сервис платный (тарификация за запрос). При росте объёмов следите за 429/503 —
в скриптах есть ретраи с backoff на транзиентных ошибках.

`MAX_QUOTA=500` × 2 квоты на ключ = до 250 ключей за прогон. Если кандидатов
больше — оставшиеся подтянутся на следующих weekly-прогонах (FRESH_DAYS).

## Как этим пользуются скиллы

| Скилл | Что читает | Зачем |
|---|---|---|
| `/find-topics` | `discoveries/diffs/<latest>.md` + `keys.json` | Получает свежие NEW/RISING фразы за неделю, проверяет, что они не покрыты блогом, выдаёт темы в `content-plan-2026.md`. |
| `/cluster-gaps` | `keys.json` | Ранжирование пробелов кластера по `max(shows, topShows)` и `trend`. |
| `/maintain-content` | `keys.json` (история) | Триггер «обновить статью», если `shows` целевого ключа вырос/упал ×2 за 6 месяцев. |
| `/demand-watch` | `demand-watch.md` + `keys.json` | Сверяет кластеры с динамикой: что обновить (рост ×2), переформулировать (`topShows ≫ shows`), написать (непокрытый спрос), объединить (падение). Отчёт обновляется weekly. |

## Цикл недели

```
Понедельник 04:00 UTC ─ workflow:
  1. extract-keys.mjs           — собирает кандидатов из блога + плана
  2. fetch.mjs                  — точечно по seo.keywords (контур A)
  3. discover.mjs               — broad по 162 seeds (контур B)
  4. diff-snapshots.mjs         — сравнивает с прошлой неделей
  5. demand-watch.mjs           — спрос ↔ покрытие по кластерам → demand-watch.md
  6. commit                     — пушит keys.json, discoveries/<date>/, diffs/<date>.md,
                                  demand-watch.md

Понедельник днём:
  /find-topics                  — открывает diff, предлагает новые темы
  /demand-watch [<кластер>]     — что обновить/переформулировать/написать по свежим цифрам
  ручной просмотр               — добавить в content-plan-2026.md что годное
  /create-article               — запускает пайплайн на выбранной теме
```

## Где править seeds

`src/data/wordstat/discoveries/seeds.json` — JSON-массив с полями `phrase`,
`category`, `cluster`. Категории: `entity` (узкая сущность), `intent`
(паттерн запроса), `audience` (срез), `problem` (боль/ошибка), `system`
(платформа), `seasonal` (календарь). Cluster — один из 18 кластеров
контент-плана или `any`.

Добавление/удаление seed-а — простой редит JSON. На следующем weekly:
- Новый seed → создастся файл `<date>/<slug>.json`. Через 2 weekly появится
  diff против самого себя (нужны 2 точки).
- Удалённый seed → больше не фетчится, в diff просто отсутствует.

## Обновление при изменениях

- Появился новый источник ключей (например, отдельный файл с эталонами
  кластера) — добавьте в `extract-keys.mjs` функцию `collectFromX()`.
- Изменилась схема `keys.json` — поднимите `schemaVersion` и опишите изменения
  здесь.
- Появился ещё один скилл, который читает `keys.json` — добавьте строку в
  таблицу выше.
