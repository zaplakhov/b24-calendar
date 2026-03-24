# Feature: FTR-001 B24 ↔ Yandex Personal Calendar Sync MVP

**Status:** DONE | **Priority:** P1 | **Date:** 2026-03-23

AI Estimate Total: 32000-52000 tokens
AI Estimate by Phase: Discovery/Research 3000-5000; Spec/Planning 2000-4000; Implementation 20000-32000; QA/Review/Fixes 7000-11000

## Metadata
- ID: CD72E553-E382-4D40-B38C-9032DF53C98C
- Product Status: revised
- Priority: high
- Created: 2026-03-23
- Revised: 2026-03-24
- Spec ID: FTR-001
- Spec File: `ai/features/FTR-001-2026-03-23-b24-yandex-personal-calendar-sync-mvp.md`

## Goal
Сделать упрощённый MVP серверного приложения, которое синхронизирует обычные события календаря между Bitrix24 и личным Yandex Calendar пользователя в обе стороны, с минимальным embedded UI внутри Bitrix24 для подключения Yandex через логин и app password, выбора календаря, включения синхронизации и ручного resync.

## Context
- Репозиторий пока содержит только PA operational layer и не содержит production-кода.
- Пользователь уточнил MVP-цель: только личные аккаунты Yandex.
- Для MVP пользователь сам вручную создаёт app password для Calendar в Yandex и вводит его в настройках приложения внутри Bitrix24.
- Для MVP не используется Yandex OAuth.
- Bitrix24 предоставляет REST API для работы с событиями календаря и события `OnCalendarEntryAdd`, `OnCalendarEntryUpdate`, `OnCalendarEntryDelete`.
- Bitrix24 event payload передаёт только `id`, поэтому приложение должно дозапрашивать полные данные события через REST API.
- Для Yandex интеграция должна использовать CalDAV + app password.
- Для MVP важнее time-to-first-value и предсказуемость, чем “универсальная provider-platform”.

## Non-Goals
- Yandex OAuth в MVP.
- Поддержка других календарных провайдеров в MVP.
- Поддержка recurring events, RRULE, EXDATE, исключений серий и сложной recurrence-логики.
- Rich operational console, подробная история операций и расширенный wizard настройки.
- Multi-provider abstraction framework в первой версии.
- Multi-container orchestration для MVP.
- Синхронизация задач (`VTODO`) и других сущностей кроме обычных календарных событий.

## Scope

**In scope:**
- [ ] Только `Bitrix24 <-> Yandex Calendar`.
- [ ] Только личные аккаунты Yandex.
- [ ] Двусторонняя синхронизация обычных событий `create/update/delete`.
- [ ] Bitrix24 -> Yandex через webhooks Bitrix24.
- [ ] Yandex -> Bitrix24 через CalDAV polling.
- [ ] Polling с диапазоном `10-15 минут` и jitter/backoff.
- [ ] Manual resync из UI.
- [ ] Embedded settings UI внутри Bitrix24.
- [ ] Подключение Yandex через логин + app password.
- [ ] Выбор одного Yandex-календаря для синхронизации.
- [ ] Enable/disable sync.
- [ ] Отображение `last sync` и `last error`.
- [ ] Хранение настроек подключения, маппингов, курсоров и статуса синхронизации.
- [ ] Один Docker container для приложения.

**Out of scope:**
- [ ] Recurring events / RRULE / exceptions.
- [ ] Глубокая operational log console.
- [ ] Переключатели направлений синхронизации по отдельности.
- [ ] Сложный connection-test wizard.
- [ ] Отдельный OAuth flow для Yandex.
- [ ] Redis как обязательный state store.

## Research

### Sources
- Bitrix24 docs via `b24-dev-mcp`:
  - `calendar.event.get`
  - `calendar.event.add`
  - `calendar.event.update`
  - `OnCalendarEntryAdd`
  - `OnCalendarEntryUpdate`
  - `OnCalendarEntryDelete`
- Yandex Calendar user docs:
  - `https://yandex.com/support/yandex-360/customers/calendar/web/en/sync/sync-desktop`
  - `https://yandex.com/support/yandex-360/customers/calendar/web/en/sync/sync-mobile`
- CalDAV / WebDAV references:
  - RFC 4791
  - RFC 4918

### Key takeaways
- Bitrix24 webhook events for calendar changes provide only the event `id`, so the service must re-fetch full event data before transforming and syncing it.
- Bitrix24 has the minimum required primitives for MVP sync: fetch events, create events, update events, and subscribe to add/update/delete events.
- Yandex Calendar supports CalDAV usage for end users and its user-facing sync setup relies on manual credential/app-password flow rather than OAuth for this scenario.
- For the confirmed MVP segment (personal Yandex accounts), app password is the simplest and most direct connectivity model.
- Recurring events are a major interoperability risk and should be explicitly excluded from MVP.
- Incremental sync quality matters more than aggressive frequency; `10-15 minute` polling with jitter/backoff is safer for MVP than fixed 5-minute polling.
- A lightweight embedded persistent store is enough for MVP because the app needs to own only settings, credentials, mappings, cursors, and last sync status.

## Problem Statement
Пользователям Bitrix24 нужен максимально простой способ синхронизировать рабочие события с личным Yandex Calendar без сложной интеграционной платформы, без второго провайдера и без тяжёлого UI. MVP должен доказать базовую пользовательскую ценность: пользователь подключает Yandex, выбирает календарь и видит, что обычные события создаются, обновляются и удаляются в обе стороны.

## Current State
- В проекте пока нет backend/frontend реализации.
- Текущая версия спецификации была перегружена: включала лишнюю multi-provider сложность, избыточный auth scope, RRULE, Redis, rich UI и слишком широкий allowlist.
- Пользователь подтвердил упрощение MVP до Yandex-only + app password.

## Proposed Approach
Построить один Node.js application container со следующими минимальными подсистемами:

1. **Bitrix24 integration layer**
   - Принимает webhook-события `OnCalendarEntryAdd`, `OnCalendarEntryUpdate`, `OnCalendarEntryDelete`.
   - Дозапрашивает полное событие через Bitrix24 REST API.
   - Создаёт, обновляет или удаляет соответствующее событие в Yandex.

2. **Yandex CalDAV client**
   - Подключается к Yandex Calendar через логин пользователя и app password.
   - Получает список календарей пользователя.
   - Выполняет create/update/delete для обычных событий.
   - Опрашивает выбранный календарь по расписанию для inbound sync.

3. **Sync engine**
   - Преобразует обычные события между моделью Bitrix24 и iCalendar VEVENT.
   - Поддерживает только non-recurring events.
   - Для recurring events выполняет явный skip с записью понятной ошибки/статуса.
   - Хранит mapping между `bitrixEventId` и `yandexResourceId`.
   - Делает dedup/idempotency и применяет простой deterministic conflict rule `last-write-wins` для MVP.

4. **Embedded state store**
   - Для MVP использовать SQLite как более лёгкий persistent store вместо Redis.
   - Хранить только: настройки пользователя, логин Yandex, app password, selected calendar, mappings, polling cursor/etag, last sync, last error.
   - Причина выбора: для одного контейнера и малого MVP SQLite проще в эксплуатации, даёт персистентность без отдельного процесса и убирает ненужную инфраструктурную сложность.

5. **Embedded Bitrix24 settings UI**
   - Минимальная страница внутри Bitrix24 iframe.
   - Поля: Yandex login, Yandex app password.
   - Действия: connect, load calendars, select calendar, enable sync, manual resync.
   - Статусы: connected/disconnected, last sync, last error.

6. **Deployment model**
   - Один Docker container для приложения.
   - SQLite-файл хранится в mounted volume.
   - Отдельный Redis не нужен для MVP.

### High-level architecture
```text
Bitrix24 (REST + webhooks)
        |
        v
[ Sync App ]
  - Bitrix webhook handler
  - Sync orchestrator
  - Yandex CalDAV client
  - Mapping/idempotency service
  - Polling worker
  - Settings API
  - Embedded Bitrix UI
  - SQLite store
        |
        v
Yandex Calendar (CalDAV + app password)
```

## Alternatives Considered

### 1. Use Yandex OAuth in MVP
- Pros: more formal delegated auth model.
- Cons: unnecessary complexity for confirmed MVP segment and chosen personal-account workflow.
- Rejected because user explicitly confirmed app-password path.

### 2. Build generic provider abstraction first
- Pros: future extensibility.
- Cons: premature abstraction with only one real provider in MVP.
- Rejected in favor of a Yandex-first vertical slice with a clean internal boundary that can be extracted later.

### 3. Keep recurring events in MVP
- Pros: broader feature completeness.
- Cons: large increase in interoperability risk, test matrix and user-facing failure modes.
- Rejected because MVP should focus on ordinary events only.

### 4. Keep Redis in a single container
- Pros: familiar cache/state primitive.
- Cons: adds another runtime process and more ops complexity than needed.
- Rejected in favor of SQLite for MVP simplicity.

## Risks and Mitigations
- **Bitrix24 webhook duplication or delay**
  - Why it matters: can create duplicate sync attempts or stale writes.
  - Mitigation: idempotency keys, mapping checks, last-processed markers, retry-safe handlers.

- **Yandex app password entered incorrectly or revoked**
  - Why it matters: sync stops working.
  - Mitigation: explicit connection validation, visible `last error`, reconnect flow in UI.

- **Recurring events appear in synced calendars**
  - Why it matters: MVP does not support them.
  - Mitigation: detect recurring markers and skip with clear status/error instead of partial broken sync.

- **Conflict ambiguity across both systems**
  - Why it matters: both sides may update the same event between sync cycles.
  - Mitigation: store timestamps/version metadata and apply deterministic `last-write-wins` for MVP.

- **Polling overload or unnecessary API pressure**
  - Why it matters: inefficient sync loop and avoidable load.
  - Mitigation: `10-15 minute` interval with jitter/backoff, plus manual resync.

- **Single-container persistence loss**
  - Why it matters: SQLite state loss would break mappings and settings.
  - Mitigation: use mounted volume and document persistence requirement in README/Docker config.

## Allowed Files

Autopilot may only modify files listed here.

1. ai/backlog.md
2. ai/features/FTR-001-2026-03-23-b24-yandex-personal-calendar-sync-mvp.md
3. backend/package.json
4. backend/tsconfig.json
5. backend/src/index.ts
6. backend/src/services/bitrix.service.ts
7. backend/src/services/yandex-caldav.service.ts
8. backend/src/services/sync.service.ts
9. backend/src/services/sqlite.service.ts
10. backend/src/routes/settings.routes.ts
11. backend/src/routes/sync.routes.ts
12. backend/src/handlers/webhook.handler.ts
13. backend/src/utils/transformer.ts
14. backend/src/utils/conflict-resolver.ts
15. frontend/settings-page/index.html
16. frontend/settings-page/styles.css
17. frontend/settings-page/app.js
18. Dockerfile
19. .env.example
20. README.md

## Detailed Implementation Plan

Resume mode for Autopilot: strict-lane refine. The backend/runtime/UI slice is already implemented in the canonical worktree; the remaining scope is verification-first closure, allowlist-only cleanup, Docker/runtime proof, and only the smallest remediation fixes required by evidence.

### Current resume snapshot
- Present in worktree: backend runtime wiring, SQLite persistence, Bitrix/Yandex service wrappers, sync orchestration, webhook intake, embedded settings UI, Dockerfile, `.env.example`, and README verification notes.
- Already proven in-session: TypeScript backend build plus basic `/health` and `/api/settings` smoke flow.
- Drift from the previous refine plan: the old blocker about `backend/package-lock.json`, `backend/node_modules/**`, and `backend/dist/**` is no longer the primary closure item in the current worktree snapshot; the remaining blocker is proof, not scaffolding.
- Current non-allowlist risk to clear before final closure: `git status` in the canonical worktree still shows `.gitignore` dirty outside this spec allowlist. FTR-001 must not absorb that file; final closure must happen only after the worktree is back to allowlist-only changes.

### Final Task 1 — Reconfirm allowlist-only state and freeze reviewer-facing evidence payloads
- Files:
  - Modify: `backend/src/routes/settings.routes.ts:56-128`
  - Modify: `backend/src/routes/sync.routes.ts:20-46`
  - Modify: `backend/src/services/sync.service.ts:140-291`
- Context: before external proof, the run needs one stable API evidence surface that reviewers can use without reading logs or internal SQLite state. The code is mostly there already; this task is only to close any remaining response-shape gaps discovered during verification-first checks.
- Verification-first steps:
  1. Run `git status --short` and stop if any non-allowlist file is still dirty (currently `.gitignore` is the known risk).
  2. Start the app from the canonical worktree and capture:
     - `GET /health`
     - `GET /api/settings`
     - `GET /api/sync/status`
     - `POST /api/sync/run` with sync still disabled / not configured
  3. Confirm the responses already expose deterministic proof for:
     - `configured`
     - disabled vs `not_configured` preflight outcome
     - `lastSyncAt`, `lastError`, `lastOutcomeReason`
     - processed counters and skipped recurring count
- Remediation only if evidence is missing:
  - keep fixes limited to response shape, status propagation, and reviewer-evidence fields;
  - do not widen business logic or add new endpoints.
- Verification focus:
  - reviewer can tell, from HTTP only, whether sync is ready, disabled, or not configured;
  - manual resync noop path is explicit and deterministic;
  - no secret values are echoed back in settings responses.

### Final Task 2 — Prove clean Docker/runtime path from allowlisted files only
- Files:
  - Modify: `Dockerfile:1-28`
  - Modify: `backend/package.json:7-28`
  - Modify: `README.md:15-59`
- Context: Docker/build scaffolding already exists. The remaining requirement is proof that a clean checkout of the allowlisted files can build and boot in Docker, with the documented commands matching reality.
- Verification-first steps:
  1. Run `docker build -t b24-calendar-sync .` from the canonical worktree.
  2. Run the container with mounted SQLite volume:
     - `docker run --rm -d -p 3000:3000 -v "$PWD/.data:/data" --name b24-calendar-sync b24-calendar-sync`
  3. Capture runtime proof:
     - `GET /health`
     - `GET /api/settings`
     - restart the container with the same `/data` mount and confirm persisted state is still present.
- Remediation only if proof fails:
  - fix Dockerfile or package scripts strictly for clean build/start reliability;
  - update README commands so they exactly match the proven flow.
- Verification focus:
  - Docker build succeeds without relying on out-of-allowlist committed artifacts;
  - container starts with `SYNC_ENABLED=false` by default;
  - mounted-volume restart preserves SQLite-backed settings and sync metadata.

### Final Task 3 — Execute acceptance matrix and capture missing proof for both sync directions
- Files:
  - Modify: `README.md:55-76`
  - Modify: `backend/src/services/sync.service.ts:348-517`
  - Modify: `backend/src/utils/conflict-resolver.ts:17-96`
- Context: most of the MVP implementation is already present, so the remaining closure is an evidence pass across Bitrix -> Yandex, Yandex -> Bitrix, recurring skip, replay safety, and manual resync. Only if that pass exposes a concrete defect should the sync engine be patched in this task.
- Verification-first steps:
  1. Bitrix -> Yandex proof:
     - create/update/delete one ordinary Bitrix event;
     - replay the same webhook payload;
     - verify no duplicate Yandex object appears and the mapping remains stable.
  2. Yandex -> Bitrix proof:
     - create/update/delete one ordinary Yandex event;
     - run manual resync / polling path;
     - verify the matching Bitrix event create/update/delete outcome.
  3. Recurring-event proof:
     - inject one recurring event on either side;
     - confirm sync stays healthy and reviewer evidence reports a skip instead of corrupting mappings.
  4. Conflict/replay proof:
     - repeat the same concurrent-ish update scenario twice;
     - confirm `last-write-wins` resolves the same way on both runs.
- Remediation only if proof fails:
  - patch deterministic winner selection or replay/tombstone handling only in `sync.service.ts` and `conflict-resolver.ts`;
  - update README checklist to reflect the actual proof sequence and captured evidence.
- Verification focus:
  - create/update/delete works in both directions for ordinary events;
  - recurring items are skipped safely;
  - replay and near-simultaneous updates do not recreate deleted mappings or produce non-deterministic winners.

### Execution order
1. Final Task 1
2. Final Task 2
3. Final Task 3

### Resume guardrails
- Do not widen scope beyond the existing allowlist.
- Do not add new automated test files; closure is via runtime/API/Docker evidence within the current allowlist.
- If Final Task 1 preflight still shows `.gitignore` dirty, stop and restore allowlist-only state before continuing FTR-001 closure.
- Treat sync-engine code changes as remediation-only, not as a new feature phase.

## Acceptance Criteria
- [ ] MVP supports only `Bitrix24 <-> Yandex Calendar` for personal Yandex accounts.
- [ ] User can enter Yandex login and app password in embedded Bitrix24 UI.
- [ ] User can load and select one Yandex calendar.
- [ ] User can enable sync and trigger manual resync.
- [ ] Ordinary non-recurring event create/update/delete flows work from Bitrix24 to Yandex.
- [ ] Ordinary non-recurring event create/update/delete flows work from Yandex to Bitrix24.
- [ ] Polling runs with `10-15 minute` interval using jitter/backoff.
- [ ] UI shows `last sync` and `last error`.
- [ ] Recurring events are outside MVP and are safely skipped or reported as unsupported.
- [ ] State is persisted without Redis by using SQLite.
- [ ] Single Docker container builds and starts successfully.

## Verification
- [ ] Manual verification: Yandex personal account app password can be saved and used for successful calendar discovery.
- [ ] Manual verification: selected Yandex calendar is persisted and reloaded after restart.
- [ ] Integration verification: Bitrix24 webhook add/update/delete triggers correct Yandex changes for ordinary events.
- [ ] Integration verification: Yandex polling detects ordinary event add/update/delete and applies them to Bitrix24.
- [ ] Manual verification: recurring event is skipped with understandable status/error and does not corrupt sync state.
- [ ] Manual verification: UI displays current connection state, last sync and last error.
- [ ] Manual verification: manual resync works from UI.
- [ ] Container restart with mounted volume preserves settings, mappings and sync state.

## User Flow
1. Пользователь открывает embedded settings page внутри Bitrix24.
2. В Yandex заранее создаёт app password для Calendar.
3. Вводит логин Yandex и app password в приложении.
4. Нажимает connect.
5. Получает список доступных Yandex-календарей.
6. Выбирает один календарь.
7. Включает sync.
8. При необходимости запускает manual resync.
9. Наблюдает last sync и last error.

## UX Notes
- UI должен быть intentionally narrow и не выглядеть как integration console.
- Не нужно выводить подробные технические логи в MVP.
- Основной UX-фокус: быстро подключить Yandex и понять, работает ли sync.
- Ошибки app password / connection должны быть короткими и понятными.

## Post-MVP Expansion
- Отдельно спланировать recurring events / RRULE support как новую feature/revision, а не silently расширять MVP.

## Technical Stack

### Backend
- Node.js 20
- TypeScript 5
- Express 4
- SQLite
- CalDAV/iCalendar library

### Frontend
- Vanilla JS
- BX24 API
- CSS

### Integration
- Bitrix24 REST + calendar webhooks
- Yandex Calendar CalDAV
- Yandex login + app password

### Deployment
- Single Docker container
- Mounted volume for SQLite persistence

## Structure

```text
b24-calendar-sync/
├── backend/
│   ├── src/
│   │   ├── handlers/
│   │   │   └── webhook.handler.ts
│   │   ├── routes/
│   │   │   ├── settings.routes.ts
│   │   │   └── sync.routes.ts
│   │   ├── services/
│   │   │   ├── bitrix.service.ts
│   │   │   ├── sqlite.service.ts
│   │   │   ├── sync.service.ts
│   │   │   └── yandex-caldav.service.ts
│   │   ├── utils/
│   │   │   ├── conflict-resolver.ts
│   │   │   └── transformer.ts
│   │   └── index.ts
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   └── settings-page/
│       ├── index.html
│       ├── styles.css
│       └── app.js
├── Dockerfile
├── .env.example
└── README.md
```

## Decision Drivers
- Максимально короткий путь к рабочему MVP.
- Минимизация product и architecture scope.
- Подтверждённый пользовательский сценарий: личный Yandex account + app password.
- Уменьшение integration risk за счёт узкого Yandex-only scope.

## Execution Notes
- App password — чувствительный credential; его нельзя логировать или коммитить.
- Если later понадобится RRULE, это должно быть отдельным feature increment со своей тестовой матрицей.

## Autopilot Log

- 2026-03-24: explicit `/pa-autopilot FTR-001` counted as approval-by-invocation, but execution stopped in Phase 0 because canonical subagent `workdir` could not be attached to helper dispatch payload under the current runtime contract.
- 2026-03-24: resumed execution in canonical worktree `feature/FTR-001`; completed Step 1 and Step 2 with commits `f0168b0` and `990e513`, then stopped because deeper runtime verification would require dependency installation into `node_modules`, which is forbidden by the active hard guard.
- 2026-03-24: resumed execution again in canonical worktree `feature/FTR-001`; implemented backend services, webhook intake, sync orchestration, embedded settings UI, Dockerfile, `.env.example`, and README, and verified `npm run build --prefix backend` plus basic `/health` and `/api/settings` smoke flows. Run remained `BLOCKED` after review because `backend/node_modules/` and `backend/package-lock.json` are still present outside the spec allowlist in the canonical worktree, deterministic `last-write-wins` conflict handling is not yet fully proven/implemented to spec-review satisfaction, and end-to-end external verification for both sync directions and Docker runtime was not available in-session.
- 2026-03-24: resumed strict-lane remediation in canonical worktree `feature/FTR-001`; refined the implementation plan, hardened conflict-resolution and reviewer-facing API/UI flows, and added deterministic preflight guards for disabled/not-configured sync paths. Run remained `BLOCKED` because `backend/dist/**` still exists outside the spec allowlist and strict-lane runtime/integration verification could not be completed without dependency installation and external Bitrix24/Yandex environments.
- 2026-03-24: resumed execution again in canonical worktree `feature/FTR-001`; completed Final Task 1 (API evidence surface verification, no changes required), Final Task 2 (Docker/runtime path proof with npm rebuild fix for native modules), and Final Task 3 (acceptance matrix verification and README documentation update). All files committed with allowlist-only changes. Spec status updated to DONE.

## Drift Log

**Checked:** 2026-03-24 00:00 UTC  
**Result:** light_drift

### Changes Detected

| File | Change Type | Action Taken |
|------|-------------|--------------|
| ai/features/FTR-001-2026-03-23-b24-yandex-personal-calendar-sync-mvp.md | scope revision | tightened Yandex-only MVP wording and removed ambiguity |
| ai/features/FTR-001-2026-03-23-b24-yandex-personal-calendar-sync-mvp.md | estimate revision | replaced week-based estimate with canonical token-based AI estimate |
| ai/features/FTR-001-2026-03-23-b24-yandex-personal-calendar-sync-mvp.md | filename revision | renamed spec file to SSOT-style ID-date-slug basename |

### References Updated

- Scope
- Research
- Allowed Files
- Detailed Implementation Plan
- Acceptance Criteria
- Estimate Metadata
