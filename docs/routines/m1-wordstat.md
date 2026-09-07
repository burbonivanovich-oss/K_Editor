# M1 — недельное обновление спроса

- **Расписание:** понедельник, 06:00 Europe/Berlin
- **Модель:** GPT-5.6 Luna
- **Окружение:** локальный Codex, Yandex из `repo/.env`

---

Работай в корне локального репозитория. Прочитай AGENTS.md и
docs/routines/codex-local.md. Возьми общую блокировку, проверь чистую
ветку main. GitHub, fetch, pull и push не используй.

Запусти по порядку, в каждом вызове загружая `.env`:

1. `node --env-file=.env scripts/wordstat/extract-keys.mjs`
2. `MAX_QUOTA=500 TOP_REQUESTS_LIMIT=1000 FRESH_DAYS=7 REGION_ID=225 node --env-file=.env scripts/wordstat/fetch.mjs`
3. `REGION_ID=225 NUM_PHRASES=2000 node --env-file=.env scripts/wordstat/discover.mjs`
4. `node --env-file=.env scripts/wordstat/diff-snapshots.mjs`
5. `node --env-file=.env scripts/wordstat/demand-watch.mjs`
6. `node --env-file=.env scripts/wordstat/prune-history.mjs`
7. `node --env-file=.env scripts/wordstat/cleanup-orphans.mjs --apply`

Квота — содержательный исход: сохрани уже полученные данные и назови,
где остановился. Закоммить локально только изменившиеся данные сообщением
`wordstat: локальное обновление <YYYY-MM-DD>`. Освободи блокировку.
Если изменений нет, коммит не создавай и оставайся тихим.
