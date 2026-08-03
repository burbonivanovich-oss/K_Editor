# Операционная карта модуля

Этот файл — единая точка входа, когда непонятно, что происходит с
модулем. Запустил утилиту → видишь, что в порядке, а где горит. Дальше —
по ссылкам в более детальную документацию.

## Ежедневная проверка состояния

```bash
node scripts/health-check.mjs
```

Отчёт по четырём блокам:
- ✓ зелёный — всё штатно
- ⚠ жёлтый — внимание, не критично
- ✗ красный — нужно чинить

Что проверяется:

- **Контент.** Сколько статей, сколько черновиков, сколько с будущим
  `pubDate`, у скольких нет маркера факт-чека.
- **Workflows.** Все ли скрипты, упомянутые в workflow, реально
  существуют (битая ссылка = красный).
- **Скрипты.** Сколько `.mjs`-файлов в `scripts/`.
- **Документация.** На месте ли ключевые `docs/*.md`.
- **Контент-план.** Статусы тем (`done`/`draft`/`planned`), сверка с
  реальными файлами в `src/content/blog/`, приоритеты, очередь P0.

JSON-вывод для пайплайнов:
```bash
node scripts/health-check.mjs --json
```

## Диагностика Google API

```bash
node scripts/drive-sync.mjs check
```

Путь аутентификации, реально выданные скоупы, доступность Drive/Sheets
API, запись в папку цикла. Настройка — `docs/google-api-setup.md`.

## Карта систем

| Подсистема | Где запускается | Документация |
|---|---|---|
| Wordstat: точечный + discovery | `wordstat-weekly.yml`, `wordstat-kontur.yml` | `docs/wordstat.md` |
| Редакционный цикл (план → батч → приёмка) | `/cycle-plan`, `/cycle-listen`, `/cycle-batch` | `docs/editorial-cycle.md` |

## Карта команд (slash-команды)

| Команда | Что делает | Когда |
|---|---|---|
| `/plan-content` | Контент-план + календарь | Раз в месяц |
| `/find-topics` | Темы из Wordstat-diff и пробелов | Перед новым материалом |
| `/create-article <тема>` | Полный цикл драфта со шлюзами | Каждая новая статья |
| `/new-post <тема>` | Быстрый черновик без шлюзов | Черновая проработка |
| `/factcheck <slug>` | Проверка фактов в одной статье | Перед передачей редактору |
| `/factcheck-batch` | Пакетная проверка 8–16 статей | Раз в неделю или при пачке |
| `/analyze-article <slug>` | Финальная оценка 0–100 | Перед `/cycle-batch` |
| `/cycle-plan` / `/cycle-listen` / `/cycle-batch` | Автоматический цикл с редактором | По расписанию |
| `/maintain-content` | Аудит и обновление старых статей | Раз в неделю |
| `/check-ai <slug>` | Детектор AI-маркеров | По подозрению |

Подробнее по каждой команде — `.claude/commands/*.md` и
`docs/tools.md` раздел «QA-инструментарий».

## Pre-commit гейт (локально)

При `git commit` срабатывает **factcheck-guard** — статья с
`draft: false` должна иметь маркер `.claude/factchecked/<slug>`.

Установка (один раз):
```bash
bash scripts/git-hooks/install.sh
```

Bypass (срочные правки):
```bash
SKIP_FACTCHECK_GUARD=1 git commit ...
```

## Если что-то горит

| Симптом | Куда смотреть | Что делать |
|---|---|---|
| Workflow не запустился | GitHub Actions → таб конкретного workflow → история | Триггер настроен? Секреты заполнены? |
| Wordstat не обновился | logs `wordstat-weekly.yml` / `wordstat-kontur.yml` | Токен `YC_API_KEY` жив? `docs/SECRETS.md` |
| Рутина цикла молчит | `node scripts/cycle-state.mjs get` | Состояние `awaiting_review`/потолок очереди? `docs/editorial-cycle.md` |
| `drive-sync.mjs` падает | `node scripts/drive-sync.mjs check` | Скоупы, включён ли Sheets API — `docs/google-api-setup.md` |
| Cron перестал срабатывать | Actions → конкретный workflow → история | GitHub отключает cron при отсутствии активности 60 дней. Любой push в main возобновляет |

## Регулярные ритуалы

| Когда | Что |
|---|---|
| Перед мержем PR | `node scripts/health-check.mjs` |
| Раз в месяц | Проверить срок жизни OAuth-токенов Google в `docs/SECRETS.md` |
| Раз в квартал | Прогнать `/maintain-content` по всему блогу |
