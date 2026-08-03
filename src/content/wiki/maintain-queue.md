---
title: Очередь обновления статей — кандидаты из /monitor-rss
createdDate: "2026-05-19"
type: reference
status: draft
---

# Maintain queue

Очередь статей-кандидатов на обновление. Пополняется из `/monitor-rss`
с `--type guidelines` или `--type all` (поток методичек/разъяснений).
Читается `/maintain-content` Шаг 1а как приоритетный список.

После обработки записи в `/maintain-content` Шаг 1в удаляются.

## Формат записи

```
- <slug> — <что добавить из материала> (источник: <URL>)
```

Пример:
```
- 2026-05-01-ts-piot-shtrafy — Письмо ФНС № АБ-4-20/12345@ от 15.04.2026 уточняет порядок применения ч. 4 ст. 14.5 при отсутствии договора с ОФД (источник: https://nalog.gov.ru/...)
```

## Кандидаты на обновление

_(Пусто. Заполняется через `/monitor-rss --type guidelines`.)_

---

## Связано

* `.claude/commands/monitor-rss.md` — заполняет этот файл
* `.claude/commands/maintain-content.md` — читает Шагом 1а
