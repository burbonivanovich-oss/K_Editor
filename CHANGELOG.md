# Changelog

## 2026-05-19 (часть 3) — Пакет D «Полировка»

Пять задач из P2 + дополнительные фиксы.

### #50 — `/plan-content` гибкий

* Окно дедлайна P0: 60 → **90 дней** (default).
* Лимит P0: 3 (default) + флаг `--p0-limit N` для override.
* Условие подъёма default до 5: 2 цикла подряд без падения балла
  `/analyze-article` ниже 75.

### #53 — cleanup orphaned keys

* `scripts/wordstat/cleanup-orphans.mjs` — dry-run + `--apply`.
* Идемпотентен. Сейчас orphans = 0 (single weekly прогон).

### #56 — нестандартные паттерны в extract-claims

3 новых типа claims:
* `NPA_PUNKT` — «п. 4», «пп. 2 ч. 1» без статьи (39 случаев в блоге)
* `DATE_CONTEXT` — «с начала года», «в I квартале» (5 случаев)
* `MONEY_WORDS` — «пятнадцать тысяч рублей» (0 случаев, на подстраховку)

Inventory: 2452 claims (было ~2390).

### Не сделано

* **#51** прогон `/find-topics` на втором weekly diff — blocked,
  ждём второго прогона `wordstat-weekly.yml`.
* **#52** ревизия `seeds.json` — blocked, ждём 2–3 прогонов.

### Также — #47 закрыт в этот день

* **#47** `/monitor-competitors` — trend detector по агрегаторам
  с журналом в `src/content/wiki/competitor-trends.md`.

---

## 2026-05-19 (часть 2) — Гигиена пайплайна публикации

Шесть P1-задач за один присест: формализация защит, которые до этого
работали неявно или дисциплиной.

### Гейты и хуки

* **#49 `/analyze-article`** — собственный аналог `/blog analyze`
  (плагин claude-blog в облачном контейнере не выживает между сессиями).
  Шкала 0–100 по 6 категориям: качество текста (20), SEO (20),
  E-E-A-T+factcheck (20), контент-граф (20), техника (20), AI Citation
  (бонус 10). `blocker: true` если балл < 70 / маркер фактчека старше
  180 дней / `audit-npa-references --strict` или `check-blog-links` упали.
  Гейт обязателен перед передачей статьи редактору, не обходить.
* **#57 Pre-commit hook** против `draft: false` без factcheck-маркера.
  `scripts/git-hooks/{pre-commit-factcheck-guard.mjs, pre-commit, install.sh}`.
  Установлен через `git config core.hooksPath` — без husky-зависимости.
  Bypass только через `git commit --no-verify` в крайних случаях.

### Batch фактчек оформлен

* **#55 `/factcheck-batch`** — то, что мы фактически делали 18 раз вручную
  через subagent dispatch при backfill'е 8→83/83, оформлено отдельным
  скиллом. Параметры `--count <N>`, `--filter <topic>`. Группировка по
  теме для переиспользования whitelist'а агентом. Шаблоны промптов для
  7 тематических кластеров (markirovka, ккт, ЕГАИС, Меркурий, налоги,
  персданные, маркетплейсы) с типовыми паттернами ошибок и реальными
  номерами норм. Тайминг 16 статей за ~15 минут — ×6 ускорение.

### Мониторинг

* **#45 `--window` в `/monitor-rss`.** Жёсткое 14 дней — мало для
  опорных статей с дедлайном через 3 месяца. Аргумент
  `--window 14d|30d|60d|90d`.
* **#46 Отдельный поток guidelines.** До этого письма ФНС/Минфина с
  разъяснениями попадали в `/plan-content` как новые темы, а должны —
  на обновление существующих. Аргумент `--type news|guidelines|all`.
  Шаг 3 классифицирует по 8 признакам. News → `/plan-content`,
  guidelines → `src/content/wiki/maintain-queue.md`.
  `/maintain-content` Шаг 1а читает maintain-queue как приоритетный
  список, Шаг 1в удаляет запись после обработки.

### Файлы за этот пакет

```
.claude/commands/
  analyze-article.md       (новый)
  factcheck-batch.md       (новый)
  monitor-rss.md           (--window, --type, новый формат отчёта)
  maintain-content.md      (Шаги 1а/1в — чтение maintain-queue)

scripts/git-hooks/
  pre-commit               (новый)
  pre-commit-factcheck-guard.mjs  (новый)
  install.sh               (новый)

src/content/wiki/maintain-queue.md     (новый)
```

### Что теперь нельзя сделать незаметно

* Закоммитить статью с `draft: false` без `/factcheck`.
  → Pre-commit hook упадёт.
* Опубликовать статью с битыми ссылками / незнакомыми НПА в whitelist.
  → `/analyze-article` поставит blocker.
* Опубликовать статью с баллом < 70 без явного решения.
  → Тот же blocker.

---

## 2026-05-19 — Backfill factcheck до 100% + жёсткий gate против фейковых НПА

29 коммитов на ветке `claude/review-backlog-1oz82`. Подробный разбор —
[`docs/archive/sessions/session-2026-05-19-postmortem.md`](./docs/archive/sessions/session-2026-05-19-postmortem.md).

### Контент

* **Factcheck покрытие 8 → 83/83 (100%).** 18 параллельных батчей,
  пойманы 12 фейковых НПА (5 ПП, 1 распоряжение, 3 ФЗ, ложная атрибуция
  приказа, отменённый ПП, реальный номер не той нормы), исправлено 70+
  системных ошибок фактологии (НДС 22%, лимиты УСН/ПСН, ст. 15.12 ч. 2 КоАП,
  ФСРАР → РАТК, маркировка кег с 01.04.2023 и др.).
  См. [`docs/factcheck-history.md`](./docs/factcheck-history.md).
* **reviewDate проставлен в 67 статьях** (pubDate + 90 дней, синхрон с
  quarterly re-factcheck).
* **Опорные материалы (pillar) ссылаются на 46 weak-статей** (1 входящая → 2+).
  До правок ни один опорный материал не содержал ссылок на блог.
* **0 сирот** в linkgraph (61 → 0): часть закрылась после фикса битых
  ссылок (#60), остальное — точечные вставки в донорах.

### Пайплайн

* **`research-specialist` обязателен для тем с НПА** (категории
  `ts-piot`, `markirovka`, `zakonodatelstvo`, `kkt`, `egais`).
  Поводом — 12 фейковых НПА за сессию. `/create-article` Стадия 1
  не запустит writer без research-brief'а с
  `frontmatter.sources[].verified=true`.
* **`content-writer` имеет правило про whitelist:** запрещено
  генерировать номера НПА из памяти; разрешено только из
  `brief.sources[]` + `sources.json.npaWhitelist`.
* **`extract-claims.mjs` расширен** типами `NPA_UK`, `NPA_NK`,
  `NPA_PP_NUMBERED`, `NPA_PRIKAZ`.
* **`audit-npa-references.mjs`** (новый) — регрессионный аудит против
  whitelist, флаг `--strict` для CI. Прогон в `/create-article` Стадия 3
  до запуска `/factcheck`.
* **`sources.json` v2** с whitelist'ом: 14 ФЗ + 11 ПП + 5 Приказов +
  1 Распоряжение + ст. КоАП/УК.
* **`/maintain-content` Шаг 2а-bis** — трендовый анализ Wordstat
  (формула `recent3 / baseline6`, пороги ≥ 2 → «обновить», ≤ 0.5 → «архив»).
* **`/maintain-content` Шаг 1** — re-factcheck по маркеру старше 90 дней
  (quarterly cycle).
* **`/create-article` Стадия 2а** — автоперелинковка: ≥ 3 исходящих +
  ≥ 1 входящая обязательны до следующей стадии.
* **`/monitor-rss` Шаг 4** разделён на три порога дублей: ≥ 0.9 →
  «обновить», 0.6–0.9 → «ручная оценка», < 0.6 → «новая статья».

### Инфраструктура

* **196 битых внутренних ссылок** в 59 файлах исправлены через
  `scripts/audit/fix-broken-blog-links.mjs` (формат `/blog/<slug-без-даты>/`
  не совпадал с реальным идентификатором записи блога). Регрессионный
  чек — `scripts/audit/check-blog-links.mjs`. GitHub Issue #30.
* **Новые скрипты:**
  * `scripts/audit/fix-broken-blog-links.mjs`
  * `scripts/audit/check-blog-links.mjs`
  * `scripts/audit/set-review-dates.mjs`
  * `scripts/factcheck/audit-npa-references.mjs`
* **Новые docs:** `docs/factcheck-history.md`,
  `docs/archive/sessions/session-2026-05-19-postmortem.md`.

### GitHub Issues

Номера ниже — трекер предыдущего репозитория проекта, до импорта модуля
в `K_Editor` 03.08.2026. Ссылок нет намеренно: это чужой репозиторий.

* **Закрыты:** #30 (битые ссылки), #31 (research-specialist gate).
* **Локальный backlog → done:** #22, #24, #41, #44, #48, #54,
  #58/#39, #59, #60, #61.

### Метрики до / после

| Метрика | До | После |
|---|---|---|
| Factcheck покрытие | 8/83 (10%) | **83/83 (100%)** |
| Битых ссылок | 196 | 0 |
| Сирот в linkgraph | 61 | 0 |
| Pillar → блог ссылок | 0 | 46 |
| Статей с reviewDate | 16 | 83 |
| Фейковых НПА в whitelist (защита) | 0 | 32 |

### Известные открытые вопросы

* 37 ФЗ + 18 ПП показаны `audit-npa-references.mjs` как «незнакомые» —
  материал на следующий цикл верификации (вероятно бо́льшая часть
  реальные, надо просто добавить в whitelist).
* Семантическая проверка «номер не той темы» в `audit-npa-references.mjs`
  ещё не реализована — это закроет 12-й тип ошибки (реальный ПП в
  неправильном контексте). См. `docs/factcheck-history.md` → «Открытые риски».
* Pre-commit hook против `draft: false` без factcheck-маркера (#57) —
  гигиена дисциплины 100% покрытия.

---

## Что убрано из истории 2026-08-03

При сужении проекта до модуля-помощника редактора (без сайта, сборки,
монетизации, аналитики трафика) из этого changelog убраны записи,
целиком описывавшие Astro-сайт: план интерактивных контент-форматов
(флагман-симулятор, Lottie-анимации, drag-and-drop, #33), Pagefind,
TOC, Open Graph для Telegram через `BaseHead.astro`. Позже отдельно
убран embeddings/similarity-пайплайн (JINA/OPENAI ключи фактически не
использовались). Полные записи — в git-истории файла.
