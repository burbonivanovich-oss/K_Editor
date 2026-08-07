# Инструменты, скрипты и автоматизация

Справочник по тулчейну модуля. Что куда писать при изменении — в конце
документа («Документация изменений»).

## QA-инструментарий

### Фактчек — `/factcheck <slug>`

Свой стек проверки фактов (без плагина claude-blog, который в облачном
эфемерном контейнере не выживает между сессиями).

- **`scripts/factcheck/extract-claims.mjs`** извлекает claims
  (даты, штрафы, ст. КоАП/УК/НК, номера ПП/Приказов/ФЗ, ссылки).
- **`/factcheck <slug>`** сверяет каждый claim с первоисточником через
  WebSearch/WebFetch, опираясь на `src/data/factcheck/sources.json`.
- **`/factcheck-batch [--count N] [--filter <topic>]`** — пакетный прогон
  8–16 статей через параллельный subagent dispatch (×6 быстрее, чем по одной).
- **`scripts/factcheck/audit-npa-references.mjs`** — регрессионный аудит
  упоминаний НПА против `sources.json.npaWhitelist`. Флаг `--strict` для CI.
- **`scripts/factcheck/audit-marker-hashes.mjs`** — для каждой `draft:
  false` статьи в закоммиченном дереве сверяет хеш маркера с
  содержимым файла. Флаг `--strict` для CI — ловит правки после
  факчека, которые проскочили мимо pre-commit-хука (`--no-verify`).
- **Решения** принимаются по `docs/editorial-policy.md` — классы A/B/C.
- **Результат:** `src/data/factcheck/results/<slug>.json`
  (`{claims, summary}`) + маркер `.claude/factchecked/<slug>`
  (`{date, hash, result, criticalMismatches, rulesVersion, report}`).

### Шлюзы качества

- **`scripts/release-article.mjs <slug>`** — финальный шлюз перед
  снятием `draft`. Детерминированный CLI (не промпт): приёмка в
  `editorial-cycle.json`, все аудиты, свежесть `/analyze-article`, хеш
  и возраст факчек-маркера — всё в одном месте и в одном порядке. Флаги
  `--dry-run`, `--json`, `--confirm-no-cycle` (для статей вне цикла).
- **`/analyze-article <slug>`** — оценка 0–100 по 6 категориям. Блокер,
  если балл < 70, маркер факт-чека старше 180 дней, либо упали
  `factcheck/audit-npa-references.mjs` или `audit/check-blog-links.mjs`.
- **`scripts/check-ai-markers.mjs`** — AI-маркеры в тексте: шаблонные
  фразы, пассивные конструкции, структурные признаки. Порог — 6/10.
  Дополнительно считает (не входит в скор/порог — справочно, до
  калибровки на реальном корпусе статей): однородность ритма
  предложений, симметрию H2-секций по объёму, повтор словосочетаний
  (n-граммы). См. `docs/audit-2026-08-05-ai-likeness.md`.
- **`scripts/check-seo.mjs`** — P0 (блокирует): title/description
  заполнены и в пределах длины, категория и 4+ тега, `seo.keywords`,
  хотя бы одна внутренняя ссылка, FAQ-блок. P1 (предупреждение): ключ
  из `seo.keywords` в title, число H2, промоблоки не по кластеру.
- **`scripts/check-stale-content.mjs`** — статьи, где даты и сроки могли
  устареть. Основа для `/maintain-content`.
- **`scripts/maintain-content-queue.mjs`** — детерминированная сборка
  очереди `/maintain-content`: `maintain-queue.md` + reviewDate/маркер
  факчека + динамика спроса по Wordstat (recent3/baseline6). Раньше эта
  арифметика считалась в промпте вручную.
- **Pre-commit hook** (`scripts/git-hooks/`) для статьи с `draft: false`
  блокирует коммит без маркера `.claude/factchecked/<slug>` и при
  P0-ошибках `check-seo.mjs`. Установка: `bash scripts/git-hooks/install.sh`.

Факт-чек обязателен до передачи статьи редактору. Подробности —
`docs/factcheck.md`, `docs/factcheck-history.md`, `docs/editorial-policy.md`.

### Расширенный QA: плагин claude-blog (опционально)

[claude-blog](https://github.com/AgriciDaniel/claude-blog) — внешний плагин.
**В облачном контейнере не сохраняется между сессиями.** Если работаете
локально и хотите им пользоваться — установите вручную в
`~/.claude/skills/`. В облачных сессиях используем свой `/factcheck`.

Полезные команды плагина, если он установлен:

- `/blog analyze <file>` — оценка 0–100 по 6 категориям, детектирует AI-текст.
- `/blog seo-check <file>` — SEO-чеклист: title, meta, H2, внутренние ссылки.
- `/blog factcheck` — **не используем**, есть свой `/factcheck`.

## Wordstat: два контура

Используется в workflow `wordstat-weekly.yml` и `wordstat-kontur.yml`.

- **A. Точечный** — `src/data/wordstat/keys.json` хранит частоты и тренды
  по нашим `seo.keywords` и «Целевому запросу» из контент-плана. Читают
  `/find-topics`, `/cluster-gaps`, `/maintain-content`.
- **B. Discovery** — `discoveries/<date>/*.json` хранят топ-2000 фраз
  вокруг каждого из 162 широких seed-ов. `diff-snapshots.mjs` каждую
  неделю сравнивает с предыдущим прогоном и пишет в
  `discoveries/diffs/<date>.md` отчёт NEW/RISING/FALLING/DROPPED.
  `/find-topics` читает свежий diff как главный источник идей.

**Лимиты API:** 1000 запросов/сутки на токен, 10 req/sec. Бюджет weekly
прогона — ~640 квот. Подробности — `docs/wordstat.md`.

## Редакционный цикл

- **`scripts/cycle-state.mjs`** — машина состояний цикла. Единственный
  способ менять `src/data/editorial-cycle.json`; руками JSON не править.
- **`scripts/drive-sync.mjs`** — мост в Google Drive: создание папки цикла
  и таблицы плана, чтение решений редактора, выкладка статей доками,
  экспорт дока обратно в markdown, чтение и закрытие комментариев.
  Диагностика доступа — подкоманда `check`.

Полное описание — `docs/editorial-cycle.md`, настройка доступа —
`docs/google-api-setup.md`.

## Вспомогательные скрипты (scripts/)

| Скрипт | Назначение |
|---|---|
| `console.mjs` | **Точка входа.** Панель состояния + меню запуска остальных скриптов |
| `health-check.mjs` | Единый отчёт состояния модуля: контент, workflow, скрипты, доки, контент-план, бизнес-инварианты выпуска (маркер факчека ↔ текст, released ↔ подтверждённый путь, released ↔ статус в контент-плане) |
| `generate-editorial-plan.mjs` | `content-plan-2026.md` → `editorial-plan.json` |
| `check-ai-markers.mjs` | AI-маркеры в тексте, скор 0–10 |
| `check-seo.mjs` | SEO-проверка текста статьи |
| `release-article.mjs` | Финальный шлюз: снимает draft после проверки всех гейтов |
| `check-stale-content.mjs` | Поиск статей с потенциально устаревшими сроками |
| `maintain-content-queue.mjs` | Очередь `/maintain-content`: сроки + динамика спроса |
| `cycle-state.mjs` | Машина состояний редакционного цикла |
| `drive-sync.mjs` | Google Drive: таблица плана, доки статей, комментарии |
| `wordstat/extract-keys.mjs` | Кандидаты из блога и контент-плана |
| `wordstat/fetch.mjs` | `/v1/dynamics` + `/v1/topRequests` (контур A) |
| `wordstat/discover.mjs` | Trend discovery: `/v1/topRequests` на 162 seed-а (контур B) |
| `wordstat/diff-snapshots.mjs` | Сравнение discovery-выгрузок неделя к неделе |
| `factcheck/extract-claims.mjs` | Regex-парсер дат, сумм, статей КоАП |
| `factcheck/audit-npa-references.mjs` | Регрессионный аудит ссылок на НПА |
| `factcheck/audit-marker-hashes.mjs` | Хеш факчек-маркера ↔ содержимое статьи в закоммиченном дереве |
| `factcheck/write-marker.mjs` | Пишет `.claude/factchecked/<slug>` с хешем статьи |
| `audit/linkgraph.mjs` | Граф перелинковки, сироты, кандидаты на ссылки |
| `audit/check-blog-links.mjs` | Битые внутренние ссылки |
| `audit/fix-broken-blog-links.mjs` | Автопочинка битых внутренних ссылок |
| `audit/check-market-duplication.mjs` | Стадия 1 `/create-article`: пересечение темы с каталогом kontur.ru/market (`src/data/interlinking/market-articles.json`) — не блокер, сигнал сузить угол и добавить перелинковку |
| `audit/set-review-dates.mjs` | Проставление `reviewDate` в frontmatter |

Запуск: `node scripts/<имя>.mjs`. Внешних зависимостей нет — только
встроенные модули Node. Скрипты с сетевыми вызовами поддерживают
`DRY_RUN=1` для отладки без запросов.

Не помнить всё это наизусть — `npm run console`: панель состояния и
пронумерованное меню. Пункты со стрелкой `→` выполняют агенты Claude,
консоль только выдаёт строку для вставки. Добавили или переименовали
скрипт — впишите пункт в `MENU` внутри `console.mjs` и прогоните
`node scripts/console.mjs check`: он ловит пункты, указывающие в никуда,
и задвоенные номера.

Ключи для скриптов с сетевыми вызовами лежат в секретах GitHub, локально
не прописаны — см. `docs/SECRETS.md`.

## Документация изменений

При изменении скрипта, агента или паттерна — **обновлять соответствующий
файл в `docs/` в той же PR**. Не накапливать долг.

| Что меняется | Какой doc обновить |
|---|---|
| Редакционный цикл, рутины, машина состояний | `docs/editorial-cycle.md` |
| Доступ к Google API, скоупы, токены | `docs/google-api-setup.md` |
| Wordstat API, частотность ключей | `docs/wordstat.md` |
| Factcheck pipeline, `extract-claims`, `sources.json`, аудит НПА | `docs/factcheck.md` |
| Backfill истории и системные паттерны факт-чека | `docs/factcheck-history.md` |
| CI, юнит-тесты | `docs/operations.md` (раздел «CI») |
| Редполитика, классы решений | `docs/editorial-policy.md` |
| Правила контента и стиля, frontmatter | `docs/content-rules.md` |
| Как добавить статью, термин, pillar | `docs/content-types.md` |
| Секреты GitHub | `docs/SECRETS.md` |
| Ритуалы и «что делать когда горит» | `docs/operations.md` |
| Post-mortem крупных сессий | `docs/archive/sessions/session-YYYY-MM-DD-postmortem.md` |
| Этот файл | `docs/tools.md` |

Если изменение не покрыто существующим документом — расширить ближайший
по теме или завести новый и добавить ссылку в `AGENTS.md`.

## Каталог CPA-блоков

`src/data/cpa-blocks.json` — блоки Контура, которые Стадия 7
`/create-article` предлагает под подводки в статье. Не редактируется
руками: пересобирается из выгрузки админки.

```bash
python3 scripts/import-cpa-blocks.py <выгрузка.xlsx>
python3 scripts/import-cpa-blocks.py <выгрузка.xlsx> --dry-run
```

Скрипт чистит описания от HTML, схлопывает дубли по тексту и посадочной
и проставляет `cluster` по адресу ссылки — по нему агент и подбирает
блок под кластер статьи. Блоки без посадочной отбрасываются: вести
читателя некуда. Блоки без заголовка остаются — у трети выгрузки это
голая кнопка со ссылкой, и она рабочая.

Требует `openpyxl` (`pip install openpyxl`). Гоняется по мере
поступления свежих выгрузок, в пайплайне не участвует.

### Проверка промоблоков в check-seo.mjs

`check-seo.mjs` разбирает маркеры `[Промоблок: <id>]` в теле статьи и
сверяет их с `src/data/cpa-blocks.json`:

- **P0** — `id` нет в каталоге. Выдуманный номер ведёт в никуда так же,
  как выдуманный номер постановления, а на глаз это не отличить.
- **P1** — блок из другого кластера, чем статья; один и тот же блок
  повторяется; подводок не 3.

Статья без промоблоков проверку не вызывает — она не обязательна для
материалов, под которые нет оффера.
