# b24-calendar MVP

Minimal MVP scaffold for syncing Bitrix24 calendar events into Yandex Calendar with SQLite-backed settings, webhook intake, manual resync, and an embedded settings page.

## What is included

- SQLite bootstrap for single-user settings, provider calendar cache, sync state, and event mappings
- Settings API with calendar discovery endpoints
- Bitrix REST service skeleton for calendar/event CRUD
- Yandex CalDAV service wrapper for calendar/event CRUD
- Sync orchestration with webhook intake, Yandex polling, recurrence skip, and mapping-based idempotency
- Embedded frontend at `/embedded/settings`
- Dockerfile and example environment variables

## Local run

1. Copy `.env.example` into your runtime environment.
2. Install backend dependencies:

   `npm install --prefix backend`

3. Build the backend:

   `npm run build --prefix backend`

4. Start the backend:

    `npm start --prefix backend`

The clean-checkout path is intentionally lockfile-free for this MVP: local builds use `npm install --prefix backend`, and Docker uses the same install step inside the image.

## Docker run

Build from the repository root:

`docker build -t b24-calendar-sync .`

Run with a mounted volume so SQLite survives restarts:

`docker run --rm -p 3000:3000 -v "$PWD/.data:/data" --name b24-calendar-sync b24-calendar-sync`

Default container behavior is safe for reviewers: `SYNC_ENABLED=false` and `SQLITE_DB_PATH=/data/b24-calendar.sqlite` until real Bitrix24 and Yandex credentials are saved through `/api/settings` or the embedded UI.

## Main endpoints

- `GET /health`
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/settings/yandex/calendars`
- `GET /api/sync/status`
- `POST /api/sync/run`
- `POST /api/webhook/bitrix`
- `GET /embedded/settings`

Reviewer-facing evidence is available directly in API responses:

- `GET /api/settings` includes current settings, persisted Yandex calendar cache, and reviewer evidence for `lastSync`, `lastError`, and discovered calendars.
- `GET /api/sync/status` includes reviewer evidence for processed counts, skipped recurring items, status hint (`ready` / `disabled` / `not_configured`), and the latest outcome reason.
- `POST /api/sync/run` returns the manual resync result plus the same reviewer evidence block.

## Manual verification checklist

1. Save Bitrix24 + Yandex credentials via `PUT /api/settings` or `/embedded/settings` and confirm `GET /api/settings` shows `reviewerEvidence.syncStatus` plus persisted values after restart.
2. Load Yandex calendars via `GET /api/settings/yandex/calendars` and confirm `reviewerEvidence.calendarsDiscovered > 0`.
3. Trigger Bitrix24 create/update/delete and verify the paired Yandex object is created/updated/deleted without duplicate recreation after repeated webhook delivery.
4. Trigger Yandex create/update/delete, run `POST /api/sync/run`, and verify Bitrix24 reflects the same create/update/delete outcome after polling.
5. Create a recurring event on either side and verify sync stays healthy while the response evidence reports a skipped recurring item (check `reviewerEvidence.lastRun.skippedRecurringEvents` and `lastError` for skip message).
6. Replay the same webhook payload twice and verify no duplicate events are created due to fingerprint-based idempotency.
7. Run manual resync and confirm `processedBitrixEvents`, `processedYandexEvents`, `skippedRecurringEvents`, `lastSyncAt`, and `lastError` are visible in HTTP responses.
8. Restart the Docker container with the same `/data` mount and verify settings, mappings, and sync status remain available.

## MVP limitations

- Bitrix REST payload normalization is pragmatic and may require portal-specific adjustments.
- Recurring events are intentionally skipped.
- Polling uses 10-15 minute jitter with persisted cursor and backoff after failures.
- Secrets are persisted in SQLite for the single-user MVP and should be moved to stronger secret storage in production.
