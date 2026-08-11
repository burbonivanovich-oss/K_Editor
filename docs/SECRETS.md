# Секреты GitHub: что есть, как получить, как обновлять

Все API-ключи проекта живут в **Settings → Secrets and variables →
Actions** репозитория. Этот документ — единый справочник.

## Сводная таблица

| Секрет | Сервис | Срок жизни | Используется |
|---|---|---|---|
| `OPENROUTER_API_KEY` | OpenRouter | бессрочный | `check-ai-markers.mjs --llm` (опционально) |
| `YC_API_KEY` | Yandex Cloud Search API (сервисный аккаунт) | бессрочный | wordstat-weekly, wordstat-kontur |
| `YC_FOLDER_ID` | Yandex Cloud (ID каталога) | — | wordstat-weekly, wordstat-kontur |
| `GSC_CLIENT_ID` | Google Cloud | бессрочный | drive-sync.mjs — запасной OAuth |
| `GSC_CLIENT_SECRET` | Google Cloud | бессрочный | drive-sync.mjs — запасной OAuth |
| `GSC_REFRESH_TOKEN` | Google OAuth2 | бессрочный (test apps — 7 дней без верификации, но рефрешится) | drive-sync.mjs — запасной OAuth |
| `GOOGLE_DOCS_KEY` | Google Cloud service account | бессрочный | Drive + Docs + Sheets API — редакционный цикл |
| `GOOGLE_DOCS_FOLDER_ID` | строка | — | Корневая папка редакционного цикла в Drive |
| `BLOG_BASE_URL` | строка: домен принимающего проекта | — | `drive-sync.mjs make-doc` — во что разворачивать внутренние ссылки статей |
| `EDITOR_EMAILS` | строка: адреса через запятую | — | `drive-sync.mjs notify` — кому выдавать доступ к новой таблице и докам |
| `GITHUB_TOKEN` | автоматически | в каждом workflow | git push commit'ов |

`EDITOR_EMAILS` — не секрет в смысле безопасности, но и не место для
репозитория: он публичный, а это рабочие адреса живых людей. Держим там
же, где ключи: локально в `.env`, в Actions — секретом. Скрипты берут
адреса из окружения, в коде и документации их быть не должно.

## Приоритеты обновления

**По мере необходимости:**
- `GSC_REFRESH_TOKEN` — если приложение осталось в статусе Testing и
  токен истёк через 7 дней (см. `docs/google-api-setup.md`).
- `OPENROUTER_API_KEY` — нужен только если пользуетесь флагом `--llm`
  у `check-ai-markers.mjs`; без флага скрипт работает без ключа.

## Как добавить секрет в GitHub

1. **Settings → Secrets and variables → Actions** в репозитории
2. **New repository secret**
3. Имя — точно как в таблице выше (case-sensitive)
4. Значение — токен/ключ. Без кавычек, без `OAuth ` префикса, без пробелов

После сохранения — все workflow получают доступ автоматически.

---

## OPENROUTER_API_KEY

**Сервис:** агрегатор LLM, используется только опциональным флагом
`--llm` у `scripts/check-ai-markers.mjs` для более точной LLM-оценки
текста поверх регексных эвристик.

**Получение:**
1. Зарегистрироваться на [openrouter.ai](https://openrouter.ai/)
2. Пополнить баланс (хватает нескольких долларов — модель по
   умолчанию `anthropic/claude-haiku-4-5`, дешёвая)
3. [openrouter.ai/keys](https://openrouter.ai/keys) → **Create key**
4. Скопировать `sk-or-v1-...`

**Не обязателен.** Без него `check-ai-markers.mjs` работает — просто
без LLM-прохода, только по регексным эвристикам.

---

## YC_API_KEY + YC_FOLDER_ID

Wordstat работает через **Yandex Cloud Search API v2**.

**Использование:** `wordstat/fetch.mjs`, `wordstat/discover.mjs` —
weekly cron собирает частоты по 162 seed'ам.

**Как получить (чек-лист):**
1. Yandex Cloud → привязать платёжный аккаунт (без него 403/402).
2. Запомнить **ID каталога** (`b1ghs…`), не облака (`b1gl7…`) → `YC_FOLDER_ID`.
3. Создать **сервисный аккаунт**, выдать роль `search-api.webSearch.user`
   на каталог (распространяется ~1 минуту).
4. Создать **API-ключ** этого аккаунта → `YC_API_KEY`.
5. Проверка: `curl` к `/v2/wordstat/topRequests` с `numPhrases` должен
   вернуть `results`.

**Авторизация:** заголовок `Authorization: Api-Key <ключ>`, `folderId` в теле
каждого запроса. Сервис платный (тариф за запрос).

**Безопасность:** Api-Key = доступ к платному сервису под ваш счёт. При утечке —
удалить и пересоздать в том же сервисном аккаунте (роль сохранится).

**Гайд:** `docs/wordstat.md`.

---

## GSC_* — запасной OAuth для Google Drive

Исторически `GSC_CLIENT_ID`/`GSC_CLIENT_SECRET`/`GSC_REFRESH_TOKEN`
использовались для Google Search Console. Тот скрипт удалён вместе с
аналитикой сайта — теперь это запасной путь аутентификации для
`scripts/drive-sync.mjs`: если сервисный аккаунт (`GOOGLE_DOCS_KEY`)
упирается в `storageQuotaExceeded`, скрипт откатывается на этот OAuth.

**3 секрета нужны вместе:**
- `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET` — из Google Cloud OAuth client
- `GSC_REFRESH_TOKEN` — получается одноразовым обменом authorization code

**Получение и переполучение токена (с учётом текущих скоупов Drive/Docs/Sheets)**
— полная процедура в `docs/google-api-setup.md`, шаг 3. Там же — рабочая
замена мёртвого OOB-редиректа и разбор ошибок.

**Особенность:** для приложений в статусе **Testing** в Google Cloud
Console `refresh_token` живёт **7 дней**. Внутренним пользователям
(Google Workspace) или после публикации в Production это ограничение
не действует — подробнее в `docs/google-api-setup.md`, раздел
«Семидневный срок».

---

## GOOGLE_DOCS_KEY + GOOGLE_DOCS_FOLDER_ID

**Сервис:** Google Drive + Docs + Sheets API — рабочее место редактора
в редакционном цикле: таблица плана и по одному Google Doc на статью.

**Получение (10 минут, один раз):**

1. **Создать папку в Google Drive** — например «Контур — редакция».
   Открыть её, скопировать ID из URL:
   `https://drive.google.com/drive/folders/<ID>`
2. **Google Cloud Console** → APIs & Services → Library → включить
   **Google Drive API**, **Google Docs API**, **Google Sheets API**.
3. **Создать service account:**
   - APIs & Services → Credentials → Create credentials →
     Service account
   - Скачать JSON-ключ
4. **Поделиться папкой с service account email.** В Google Drive:
   ПКМ на папке → **Открыть доступ** → ввести `client_email`
   из JSON → роль **Редактор**.
5. **Прописать секреты:**
   - `GOOGLE_DOCS_KEY` = JSON service account как одна строка
     или base64
   - `GOOGLE_DOCS_FOLDER_ID` = ID папки из шага 1

**Альтернатива:** OAuth-токен `GSC_*` вместо сервисного аккаунта — см.
раздел «GSC_* — запасной OAuth» выше и `docs/google-api-setup.md`.

**Использование:** `scripts/drive-sync.mjs` — создание папки цикла и
таблицы плана, чтение решений редактора, выкладка статей доками, экспорт
обратно в markdown, комментарии. Подробности — `docs/editorial-cycle.md`,
`docs/google-api-setup.md`.

**Диагностика одной командой:** `node scripts/drive-sync.mjs check`.

### ⚠ Service Account даёт `storageQuotaExceeded`

**Симптом:** при первом запуске падает
`403 The user's Drive storage quota has been exceeded`.

**Причина:** Google service-account не имеет собственной квоты
Drive. Даже если папка расшарена с ним и принадлежит вашему
личному аккаунту с 15 ГБ — при создании файла объём учитывается
в квоте **создателя** (= service-account = 0 ГБ).

**Решение — переключиться на OAuth (`GSC_*`):**
1. Убедиться, что `GSC_CLIENT_ID`/`GSC_CLIENT_SECRET`/`GSC_REFRESH_TOKEN`
   заданы и включают скоуп `drive.file` (см. `docs/google-api-setup.md`).
2. `drive-sync.mjs` переключится на OAuth автоматически при отказе
   сервисного аккаунта — можно даже не убирать `GOOGLE_DOCS_KEY`.

Если у вас только service-account и нет OAuth-кредов — нужно либо
настроить `GSC_*`, либо подключить Workspace + Shared Drive.

---

---

## Что делать, если workflow упал по 401/403

| Код | Что значит | Что делать |
|---|---|---|
| 401 Unauthorized | Токен невалидный / истёк | Получить новый по гайду выше, обновить секрет |
| 403 Forbidden | Токен валидный, но прав не хватает | Проверить скоупы (`node scripts/drive-sync.mjs check`) или роль аккаунта |
| 429 Too Many Requests | Превышен лимит API | Подождать сутки или взять платный тариф |

---

## Backup-стратегия

Все секреты — внешние, репозиторий их не хранит. **Если потеряете
доступ к GitHub репо, восстановить токены придётся вручную** — все
шаги выше повторяются.

Рекомендация: храните **ClientID + последний токен** в зашифрованном
вэлте (1Password, Bitwarden, KeePass). Достаточно одной записи на
сервис — клиент_id можно переиспользовать, токен переполучить за 5 минут.
