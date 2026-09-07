# M2 — узкий спрос и контроль источников

- **Расписание:** понедельник и вторник, 07:00 Europe/Berlin
- **Модель:** GPT-5.6 Luna
- **Окружение:** локальный Codex, Yandex из `repo/.env`, сеть

---

Работай в корне локального репозитория. Прочитай AGENTS.md и
docs/routines/codex-local.md. Возьми общую блокировку, проверь чистую
ветку main. GitHub, fetch, pull и push не используй.

В понедельник обнови узкий Wordstat:

1. `SEEDS_FILE=seeds-kontur.json WS_NS=kontur REGION_ID=225 NUM_PHRASES=2000 node --env-file=.env scripts/wordstat/discover.mjs`
2. `WS_NS=kontur node --env-file=.env scripts/wordstat/diff-snapshots.mjs`
3. `node --env-file=.env scripts/wordstat/prune-history.mjs`
4. Локальный коммит изменившихся данных:
   `wordstat-kontur: локальное обновление <YYYY-MM-DD>`.

Во вторник проверь источники:

1. `node --env-file=.env scripts/factcheck/watch-sources.mjs --refresh --stale 180`
2. `node --env-file=.env scripts/factcheck/watch-sources.mjs --queue`
3. Локальный коммит изменившейся очереди и снимков:
   `источники: локальный обход <YYYY-MM-DD>`.

Ненулевой код обхода может означать непустую очередь, а не поломку.
Не исправляй статьи в этой задаче. Освободи блокировку. Сообщай только
о квоте, ошибке или новой очереди перепроверки.
