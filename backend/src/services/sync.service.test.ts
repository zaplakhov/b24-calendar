/*
Module: sync.service.test
Role: Verifies SQLite mapping persistence, scoped soft-fail sync behavior, and stale mapping healing.
Source of Truth: backend/src/services/sync.service.test.ts

Uses:
  node:test:test: true
  node:assert/strict: true
  node:fs: true
  node:os: true
  node:path: true
  better-sqlite3:Database: true
  ./sqlite.service.ts:SQLiteService: true
  ./sync.service.ts:SyncService: true
  ./yandex-caldav.service.ts:YandexCalendarObjectNotFoundError: true

Used by: none

Glossary: none
*/

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { SQLiteService } from './sqlite.service';
import { SyncService } from './sync.service';
import { YandexCalendarObjectNotFoundError } from './yandex-caldav.service';
import { buildYandexEventFingerprint, type BitrixCalendarEvent, type YandexCalendarEvent } from '../utils/transformer';

function makeTempDbPath(name: string): { cleanup: () => void; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `b24-calendar-${name}-`));
  return {
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
    dbPath: join(dir, 'test.sqlite'),
  };
}

function setupReadyConnection(sqliteService: SQLiteService) {
  const installation = sqliteService.upsertInstallation({
    accessToken: 'token',
    portalHost: 'example.bitrix24.ru',
    status: 'active',
  });
  const created = sqliteService.createOrUpdateConnection({
    bitrixUserId: '7',
    installationId: installation.id,
  });
  const connection = sqliteService.updateConnectionSettings(created.id, {
    bitrixCalendarId: '42',
    syncEnabled: true,
    yandexBaseUrl: 'https://caldav.yandex.ru',
    yandexCalendarUrl: 'https://caldav.yandex.ru/calendars/user/default/',
    yandexPassword: 'secret',
    yandexUsername: 'user',
  });
  return { connection, installation };
}

function createBitrixEvent(overrides: Partial<BitrixCalendarEvent> = {}): BitrixCalendarEvent {
  return {
    attendees: [],
    calendarId: '42',
    deleted: false,
    description: 'Description',
    endsAt: '2026-03-24T11:00:00.000Z',
    id: 'bitrix-1',
    isAllDay: false,
    location: null,
    organizer: null,
    preserved: { deferredReasonCodes: [], rawAttendees: [], rawOrganizer: null, rawProperties: {} },
    raw: {},
    recurrenceRule: null,
    startsAt: '2026-03-24T10:00:00.000Z',
    status: null,
    timezone: 'UTC',
    title: 'Bitrix event',
    transparency: null,
    updatedAt: '2026-03-24T09:30:00.000Z',
    ...overrides,
  };
}

function createYandexEvent(overrides: Partial<YandexCalendarEvent> = {}): YandexCalendarEvent {
  return {
    attendees: [],
    description: 'Description',
    endsAt: '2026-03-24T11:00:00.000Z',
    etag: 'etag-1',
    isAllDay: false,
    location: null,
    organizer: null,
    preserved: { deferredReasonCodes: [], rawAttendees: [], rawOrganizer: null, rawProperties: {} },
    rawIcs: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
    recurrenceRule: null,
    startsAt: '2026-03-24T10:00:00.000Z',
    status: 'CONFIRMED',
    summary: 'Yandex event',
    timezone: 'UTC',
    transparency: 'OPAQUE',
    uid: 'uid-1',
    updatedAt: '2026-03-24T09:30:00.000Z',
    url: 'https://caldav.yandex.ru/calendars/user/default/event-1.ics',
    ...overrides,
  };
}

test('sqlite mapping schema stores preserved and healing metadata additively', () => {
  const temp = makeTempDbPath('sqlite-schema');
  try {
    const legacy = new Database(temp.dbPath);
    legacy.exec(`
      CREATE TABLE bitrix_installations (id TEXT PRIMARY KEY, portal_host TEXT NOT NULL UNIQUE, member_id TEXT, access_token TEXT, refresh_token TEXT, expires_at TEXT, scope TEXT, application_token TEXT, status TEXT NOT NULL DEFAULT 'pending', last_error_message TEXT, installed_by_user_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE user_connections (id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, onboarding_token TEXT NOT NULL UNIQUE, bitrix_user_id TEXT NOT NULL, bitrix_user_name TEXT, bitrix_calendar_id TEXT, yandex_base_url TEXT, yandex_username TEXT, yandex_password TEXT, yandex_calendar_url TEXT, sync_enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE connection_sync_state (connection_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'idle', bitrix_sync_cursor TEXT, yandex_sync_cursor TEXT, polling_failure_count INTEGER NOT NULL DEFAULT 0, last_processed_bitrix_events INTEGER NOT NULL DEFAULT 0, last_processed_yandex_events INTEGER NOT NULL DEFAULT 0, last_skipped_recurring_events INTEGER NOT NULL DEFAULT 0, last_outcome_reason TEXT, last_run_at TEXT, last_success_at TEXT, last_error_at TEXT, last_error_message TEXT, last_webhook_at TEXT, last_poll_at TEXT, active_direction TEXT);
      CREATE TABLE connection_event_mappings (connection_id TEXT NOT NULL, bitrix_event_id TEXT, yandex_event_url TEXT, yandex_event_etag TEXT, yandex_event_uid TEXT, source_fingerprint TEXT, target_fingerprint TEXT, bitrix_updated_at TEXT, yandex_updated_at TEXT, last_winner TEXT, last_decision_reason TEXT, status TEXT NOT NULL DEFAULT 'synced', last_synced_at TEXT, deleted_at TEXT, deleted_by TEXT);
    `);
    legacy.close();

    const sqliteService = new SQLiteService(temp.dbPath);
    const { connection } = setupReadyConnection(sqliteService);
    sqliteService.upsertEventMapping({
      bitrixEventId: 'b-1',
      bitrixUpdatedAt: '2026-03-24T09:00:00.000Z',
      connectionId: connection.id,
      deferredReasonCodes: ['bitrix_attendees_deferred'],
      deletedAt: null,
      deletedBy: null,
      healingUrl: 'https://old.example/event.ics',
      lastDecisionReason: 'mapping_missing',
      lastHealedAt: '2026-03-24T09:05:00.000Z',
      lastHealingReason: 'stale_mapping_healed',
      lastSyncedAt: '2026-03-24T09:10:00.000Z',
      lastWinner: 'bitrix',
      preservedPayload: { preserved: true },
      sourceFingerprint: 'source',
      sourceTimezone: 'Europe/Moscow',
      status: 'synced',
      targetFingerprint: 'target',
      targetTimezone: 'UTC',
      yandexEventEtag: 'etag',
      yandexEventUid: 'uid-1',
      yandexEventUrl: 'https://caldav.yandex.ru/calendars/user/default/event.ics',
      yandexUpdatedAt: '2026-03-24T09:00:00.000Z',
    });

    const mapping = sqliteService.getEventMappingByBitrixId(connection.id, 'b-1');
    assert.ok(mapping);
    assert.equal(mapping?.lastHealingReason, 'stale_mapping_healed');
    assert.equal(mapping?.healingUrl, 'https://old.example/event.ics');
    assert.deepEqual(mapping?.deferredReasonCodes, ['bitrix_attendees_deferred']);
    assert.deepEqual(mapping?.preservedPayload, { preserved: true });
  } finally {
    temp.cleanup();
  }
});

test('sync service soft-skips out-of-scope and invalid Bitrix events while processing valid ones', async () => {
  const temp = makeTempDbPath('bitrix-soft-fail');
  const logEntries: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { logEntries.push(args); };

  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const { connection } = setupReadyConnection(sqliteService);
    const createdEvents: YandexCalendarEvent[] = [];

    const syncService = new SyncService(
      sqliteService,
      {
        deleteEvent: async () => undefined,
        listEventsSince: async () => [
          createBitrixEvent({ calendarId: '99', id: 'out-of-scope' }),
          createBitrixEvent({ endsAt: '', id: 'invalid', startsAt: '' }),
          createBitrixEvent({ id: 'valid' }),
        ],
      } as never,
      {
        createEvent: async (_connectionId: string, _draft: unknown) => {
          const event = createYandexEvent({ uid: 'uid-valid', url: 'https://caldav.yandex.ru/calendars/user/default/valid.ics' });
          createdEvents.push(event);
          return event;
        },
        listEventResults: async () => [],
      } as never,
    );

    const result = await syncService.runManualSyncNow(connection.id);
    assert.equal(result.ok, true);
    assert.equal(createdEvents.length, 1);
    assert.equal(sqliteService.listEventMappings(connection.id).length, 1);
    assert.equal(result.status.state.lastOutcomeReason, 'incremental_sync_completed');
    assert.match(JSON.stringify(logEntries), /bitrix_event_out_of_scope/);
    assert.match(JSON.stringify(logEntries), /bitrix_invalid_dates/);
  } finally {
    console.warn = originalWarn;
    temp.cleanup();
  }
});

test('sync service heals stale Yandex mappings by uid and rewrites mapping metadata', async () => {
  const temp = makeTempDbPath('stale-healing');
  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const { connection } = setupReadyConnection(sqliteService);
    sqliteService.upsertEventMapping({
      bitrixEventId: 'bitrix-1',
      bitrixUpdatedAt: '2026-03-24T09:00:00.000Z',
      connectionId: connection.id,
      deferredReasonCodes: [],
      deletedAt: null,
      deletedBy: null,
      healingUrl: null,
      lastDecisionReason: 'mapping_missing',
      lastHealedAt: null,
      lastHealingReason: null,
      lastSyncedAt: '2026-03-24T09:00:00.000Z',
      lastWinner: 'bitrix',
      preservedPayload: null,
      sourceFingerprint: 'source-1',
      sourceTimezone: 'UTC',
      status: 'synced',
      targetFingerprint: 'target-1',
      targetTimezone: 'UTC',
      yandexEventEtag: 'etag-old',
      yandexEventUid: 'uid-1',
      yandexEventUrl: 'https://caldav.yandex.ru/calendars/user/default/stale.ics',
      yandexUpdatedAt: '2026-03-24T09:00:00.000Z',
    });

    let updateCalls = 0;
    const syncService = new SyncService(
      sqliteService,
      {
        deleteEvent: async () => undefined,
        listEventsSince: async () => [createBitrixEvent()],
      } as never,
      {
        createEvent: async () => createYandexEvent(),
        findEventByUid: async () => createYandexEvent({ etag: 'etag-new', url: 'https://caldav.yandex.ru/calendars/user/default/healed.ics' }),
        listEventResults: async () => [],
        updateEvent: async (_connectionId: string, url: string) => {
          updateCalls += 1;
          if (url.endsWith('stale.ics')) {
            throw new YandexCalendarObjectNotFoundError(url);
          }
          return createYandexEvent({ etag: 'etag-new', url });
        },
      } as never,
    );

    const result = await syncService.runManualSyncNow(connection.id);
    const mapping = sqliteService.getEventMappingByBitrixId(connection.id, 'bitrix-1');
    assert.equal(result.ok, true);
    assert.equal(updateCalls, 2);
    assert.equal(mapping?.yandexEventUrl, 'https://caldav.yandex.ru/calendars/user/default/healed.ics');
    assert.equal(mapping?.lastHealingReason, 'stale_mapping_healed');
    assert.equal(mapping?.healingUrl, 'https://caldav.yandex.ru/calendars/user/default/stale.ics');
  } finally {
    temp.cleanup();
  }
});

test('sync service soft-skips invalid and recurring Yandex events while preserving valid inbound sync', async () => {
  const temp = makeTempDbPath('yandex-soft-fail');
  const logEntries: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { logEntries.push(args); };

  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const { connection } = setupReadyConnection(sqliteService);
    const createdBitrixEvents: BitrixCalendarEvent[] = [];

    const syncService = new SyncService(
      sqliteService,
      {
        createEvent: async () => {
          const event = createBitrixEvent({ id: 'created-from-yandex' });
          createdBitrixEvents.push(event);
          return event;
        },
        listEventsSince: async () => [],
      } as never,
      {
        listEventResults: async () => [
          { ok: false as const, issue: { kind: 'skip' as const, provider: 'yandex' as const, reason: 'recurrence_unsupported' as const } },
          { ok: false as const, issue: { kind: 'skip' as const, provider: 'yandex' as const, reason: 'yandex_invalid_dates' as const } },
          { ok: true as const, value: createYandexEvent() },
        ],
      } as never,
    );

    const result = await syncService.runManualSyncNow(connection.id);
    assert.equal(result.ok, true);
    assert.equal(createdBitrixEvents.length, 1);
    assert.equal(result.status.state.lastOutcomeReason, 'incremental_sync_completed_with_soft_failures');
    assert.match(JSON.stringify(logEntries), /recurrence_unsupported/);
    assert.match(JSON.stringify(logEntries), /yandex_invalid_dates/);
  } finally {
    console.warn = originalWarn;
    temp.cleanup();
  }
});

test('sync service does not treat mapped Yandex object as deleted when normalization fails', async () => {
  const temp = makeTempDbPath('yandex-normalization-does-not-delete');
  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const { connection } = setupReadyConnection(sqliteService);
    const mappedUrl = 'https://caldav.yandex.ru/calendars/user/default/mapped-invalid.ics';
    sqliteService.upsertEventMapping({
      bitrixEventId: 'bitrix-mapped',
      bitrixUpdatedAt: '2026-03-24T09:00:00.000Z',
      connectionId: connection.id,
      deferredReasonCodes: [],
      deletedAt: null,
      deletedBy: null,
      healingUrl: null,
      lastDecisionReason: 'mapping_missing',
      lastHealedAt: null,
      lastHealingReason: null,
      lastSyncedAt: '2026-03-24T09:00:00.000Z',
      lastWinner: 'yandex',
      preservedPayload: null,
      sourceFingerprint: 'source-mapped',
      sourceTimezone: 'UTC',
      status: 'synced',
      targetFingerprint: 'target-mapped',
      targetTimezone: 'UTC',
      yandexEventEtag: 'etag-mapped',
      yandexEventUid: 'uid-mapped',
      yandexEventUrl: mappedUrl,
      yandexUpdatedAt: '2026-03-24T09:00:00.000Z',
    });

    let deleteCalls = 0;
    const syncService = new SyncService(
      sqliteService,
      {
        deleteEvent: async () => {
          deleteCalls += 1;
        },
        listEventsSince: async () => [],
      } as never,
      {
        listEventResults: async () => [
          {
            ok: false as const,
            issue: {
              details: { url: mappedUrl },
              kind: 'skip' as const,
              provider: 'yandex' as const,
              reason: 'yandex_invalid_dates' as const,
            },
          },
        ],
      } as never,
    );

    const result = await syncService.runManualSyncNow(connection.id);
    const mapping = sqliteService.getEventMappingByBitrixId(connection.id, 'bitrix-mapped');

    assert.equal(result.ok, true);
    assert.equal(deleteCalls, 0);
    assert.equal(mapping?.status, 'synced');
    assert.equal(mapping?.deletedBy, null);
    assert.equal(mapping?.yandexEventUrl, mappedUrl);
  } finally {
    temp.cleanup();
  }
});

test('sync service preserves deferred Yandex -> Bitrix fields in inbound mapping metadata', async () => {
  const temp = makeTempDbPath('yandex-preserved-fields');
  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const { connection } = setupReadyConnection(sqliteService);
    const receivedDrafts: Array<Record<string, unknown>> = [];

    const syncService = new SyncService(
      sqliteService,
      {
        createEvent: async (_connectionId: string, draft: Record<string, unknown>) => {
          receivedDrafts.push(draft);
          return createBitrixEvent({ id: 'bitrix-inbound-created' });
        },
        listEventsSince: async () => [],
      } as never,
      {
        listEventResults: async () => [
          {
            ok: true as const,
            value: createYandexEvent({
              attendees: [{ email: 'guest@example.com', name: 'Guest', partstat: 'ACCEPTED', raw: 'mailto:guest@example.com', role: null }],
              location: 'Room 301',
              organizer: { email: 'owner@example.com', name: 'Owner', raw: 'mailto:owner@example.com' },
              status: 'CONFIRMED',
              timezone: 'Europe/Moscow',
              transparency: 'TRANSPARENT',
              uid: 'uid-preserved',
              url: 'https://caldav.yandex.ru/calendars/user/default/preserved.ics',
            }),
          },
        ],
      } as never,
    );

    const result = await syncService.runManualSyncNow(connection.id);
    const mapping = sqliteService.getEventMappingByYandexUrl(connection.id, 'https://caldav.yandex.ru/calendars/user/default/preserved.ics');

    assert.equal(result.ok, true);
    assert.equal(receivedDrafts.length, 1);
    assert.equal(receivedDrafts[0]?.location, null);
    assert.equal(receivedDrafts[0]?.organizer, null);
    assert.equal(receivedDrafts[0]?.status, null);
    assert.equal(receivedDrafts[0]?.transparency, null);
    assert.equal(receivedDrafts[0]?.timezone, null);
    assert.deepEqual(receivedDrafts[0]?.attendees, []);
    assert.deepEqual(mapping?.deferredReasonCodes, [
      'bitrix_location_deferred',
      'bitrix_organizer_deferred',
      'bitrix_status_deferred',
      'bitrix_transparency_deferred',
      'bitrix_timezone_deferred',
      'bitrix_attendees_deferred',
    ]);
    assert.deepEqual(mapping?.preservedPayload, {
      source: { deferredReasonCodes: [], rawAttendees: [], rawOrganizer: null, rawProperties: {} },
      target: {
        deferredReasonCodes: [
          'bitrix_location_deferred',
          'bitrix_organizer_deferred',
          'bitrix_status_deferred',
          'bitrix_transparency_deferred',
          'bitrix_timezone_deferred',
          'bitrix_attendees_deferred',
        ],
        rawAttendees: [{ email: 'guest@example.com', name: 'Guest', partstat: 'ACCEPTED', raw: 'mailto:guest@example.com', role: null }],
        rawOrganizer: 'mailto:owner@example.com',
        rawProperties: {
          location: ['Room 301'],
          organizer: ['mailto:owner@example.com'],
          status: ['CONFIRMED'],
          transparency: ['TRANSPARENT'],
          timezone: ['Europe/Moscow'],
        },
      },
    });
  } finally {
    temp.cleanup();
  }
});

test('sync service exposes mixed-run reviewer evidence with structured counters and reason codes', async () => {
  const temp = makeTempDbPath('mixed-run-evidence');
  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const { connection } = setupReadyConnection(sqliteService);
    sqliteService.upsertEventMapping({
      bitrixEventId: 'heal',
      bitrixUpdatedAt: '2026-03-24T09:00:00.000Z',
      connectionId: connection.id,
      deferredReasonCodes: [],
      deletedAt: null,
      deletedBy: null,
      healingUrl: null,
      lastDecisionReason: 'mapping_missing',
      lastHealedAt: null,
      lastHealingReason: null,
      lastSyncedAt: '2026-03-24T09:00:00.000Z',
      lastWinner: 'bitrix',
      preservedPayload: null,
      sourceFingerprint: 'source-heal',
      sourceTimezone: 'UTC',
      status: 'synced',
      targetFingerprint: buildYandexEventFingerprint(createYandexEvent({ uid: 'uid-heal', url: 'https://caldav.yandex.ru/calendars/user/default/healed.ics' })),
      targetTimezone: 'UTC',
      yandexEventEtag: 'etag-old',
      yandexEventUid: 'uid-heal',
      yandexEventUrl: 'https://caldav.yandex.ru/calendars/user/default/stale.ics',
      yandexUpdatedAt: '2026-03-24T09:00:00.000Z',
    });

    const syncService = new SyncService(
      sqliteService,
      {
        deleteEvent: async () => undefined,
        listEventsSince: async () => [
          createBitrixEvent({ id: 'heal' }),
          createBitrixEvent({ id: 'skip', startsAt: '', endsAt: '' }),
          createBitrixEvent({ id: 'error' }),
        ],
      } as never,
      {
        createEvent: async (_connectionId: string, draft: { uid?: string }) => {
          if (draft.uid?.includes('error@b24-calendar-sync.local')) {
            throw new Error('create failed');
          }

          return createYandexEvent({ uid: 'uid-created', url: 'https://caldav.yandex.ru/calendars/user/default/created.ics' });
        },
        findEventByUid: async () => createYandexEvent({ uid: 'uid-heal', url: 'https://caldav.yandex.ru/calendars/user/default/healed.ics' }),
        listEventResults: async () => [
          { ok: true as const, value: createYandexEvent({ uid: 'uid-heal', url: 'https://caldav.yandex.ru/calendars/user/default/healed.ics' }) },
        ],
        updateEvent: async (_connectionId: string, url: string) => {
          if (url.endsWith('stale.ics')) {
            throw new YandexCalendarObjectNotFoundError(url);
          }

          return createYandexEvent({ uid: 'uid-heal', url });
        },
      } as never,
    );

    const result = await syncService.runManualSyncNow(connection.id);
    const reviewerEvidence = result.status.reviewerEvidence.lastRun;

    assert.equal(result.ok, true);
    assert.equal(reviewerEvidence.outcomeReason, 'incremental_sync_completed_with_soft_failures');
    assert.deepEqual(reviewerEvidence.counters, {
      errorEvents: 1,
      healedMappings: 1,
      processedBitrixEvents: 3,
      processedYandexEvents: 0,
      skippedEvents: 1,
      skippedRecurringEvents: 0,
    });
    assert.deepEqual(reviewerEvidence.reasonCodes, {
      errors: ['bitrix_event_soft_failed'],
      healing: ['stale_mapping_healed'],
      skipped: ['bitrix_invalid_dates'],
    });
  } finally {
    temp.cleanup();
  }
});
test('resetConnectionSync clears stored observability and reviewer evidence', () => {
  const temp = makeTempDbPath('reset-reviewer-evidence');
  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const { connection } = setupReadyConnection(sqliteService);
    const syncService = new SyncService(sqliteService, {} as never, {} as never);
    sqliteService.updateSyncState(connection.id, {
      lastErrorMessage: 'stale error',
      lastOutcomeReason: 'incremental_sync_completed_with_soft_failures',
      lastProcessedBitrixEvents: 4,
      lastProcessedYandexEvents: 2,
      lastRunObservability: {
        counters: {
          errorEvents: 1,
          healedMappings: 1,
          processedBitrixEvents: 4,
          processedYandexEvents: 2,
          skippedEvents: 3,
          skippedRecurringEvents: 1,
        },
        reasonCodes: {
          errors: ['bitrix_event_soft_failed'],
          healing: ['stale_mapping_healed'],
          skipped: ['bitrix_invalid_dates'],
        },
      },
      lastSuccessAt: '2026-03-24T09:10:00.000Z',
      lastWebhookAt: '2026-03-24T09:11:00.000Z',
    });
    sqliteService.resetConnectionSync(connection.id);
    const state = sqliteService.getSyncState(connection.id);
    const reviewerEvidence = syncService.getStatus(connection.id).reviewerEvidence.lastRun;
    assert.equal(state.lastRunObservability, null);
    assert.equal(state.lastWebhookAt, null);
    assert.equal(state.lastOutcomeReason, null);
    assert.equal(state.lastErrorMessage, null);
    assert.deepEqual(reviewerEvidence.counters, {
      errorEvents: 0,
      healedMappings: 0,
      processedBitrixEvents: 0,
      processedYandexEvents: 0,
      skippedEvents: 0,
      skippedRecurringEvents: 0,
    });
    assert.deepEqual(reviewerEvidence.reasonCodes, { errors: [], healing: [], skipped: [] });
    assert.equal(reviewerEvidence.outcomeReason, null);
  } finally {
    temp.cleanup();
  }
});
test('webhook sync uses incremental-style outcome reason for healing and soft failures', async () => {
  const temp = makeTempDbPath('webhook-outcome-reason');
  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const { connection } = setupReadyConnection(sqliteService);
    sqliteService.upsertEventMapping({
      bitrixEventId: 'heal',
      bitrixUpdatedAt: '2026-03-24T09:00:00.000Z',
      connectionId: connection.id,
      deferredReasonCodes: [],
      deletedAt: null,
      deletedBy: null,
      healingUrl: null,
      lastDecisionReason: 'mapping_missing',
      lastHealedAt: null,
      lastHealingReason: null,
      lastSyncedAt: '2026-03-24T09:00:00.000Z',
      lastWinner: 'bitrix',
      preservedPayload: null,
      sourceFingerprint: 'source-heal',
      sourceTimezone: 'UTC',
      status: 'synced',
      targetFingerprint: 'target-heal',
      targetTimezone: 'UTC',
      yandexEventEtag: 'etag-old',
      yandexEventUid: 'uid-heal',
      yandexEventUrl: 'https://caldav.yandex.ru/calendars/user/default/stale.ics',
      yandexUpdatedAt: '2026-03-24T09:00:00.000Z',
    });
    const healingService = new SyncService(
      sqliteService,
      {
        deleteEvent: async () => undefined,
        fetchEventById: async () => createBitrixEvent({ id: 'heal' }),
      } as never,
      {
        createEvent: async () => createYandexEvent(),
        findEventByUid: async () => createYandexEvent({ uid: 'uid-heal', url: 'https://caldav.yandex.ru/calendars/user/default/healed.ics' }),
        listEventResults: async () => [],
        updateEvent: async (_connectionId: string, url: string) => {
          if (url.endsWith('stale.ics')) {
            throw new YandexCalendarObjectNotFoundError(url);
          }
          return createYandexEvent({ uid: 'uid-heal', url });
        },
      } as never,
    );
    const healingStatus = await healingService.handleBitrixWebhook(connection.id, {
      data: { FIELDS: { ID: 'heal' } },
      event: 'ONCALENDARENTRYADD',
    });
    assert.equal(healingStatus.state.lastOutcomeReason, 'incremental_sync_completed_with_healing');
    const softFailureService = new SyncService(
      sqliteService,
      {
        deleteEvent: async () => undefined,
        fetchEventById: async () => createBitrixEvent({ id: 'soft-fail' }),
      } as never,
      {
        createEvent: async () => createYandexEvent(),
        listEventResults: async () => [
          { ok: false as const, issue: { kind: 'skip' as const, provider: 'yandex' as const, reason: 'yandex_invalid_dates' as const } },
        ],
      } as never,
    );
    const softFailureStatus = await softFailureService.handleBitrixWebhook(connection.id, {
      data: { FIELDS: { ID: 'soft-fail' } },
      event: 'ONCALENDARENTRYUPDATE',
    });
    assert.equal(softFailureStatus.state.lastOutcomeReason, 'incremental_sync_completed_with_soft_failures');
  } finally {
    temp.cleanup();
  }
});

test('sync service debug trace reports recurring expected skip and cursor diagnostics', async () => {
  const temp = makeTempDbPath('debug-trace-recurring');
  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const { connection } = setupReadyConnection(sqliteService);
    const today = new Date();
    const startsAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 10, 0, 0)).toISOString();
    const endsAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 11, 0, 0)).toISOString();
    const syncService = new SyncService(
      sqliteService,
      {
        listEventsSince: async () => [createBitrixEvent({ endsAt, startsAt, id: 'bitrix-recurring', recurrenceRule: 'FREQ=DAILY;COUNT=2' })],
      } as never,
      {
        listEventResults: async () => [
          { ok: true as const, value: createYandexEvent({ endsAt, startsAt, uid: 'yandex-recurring', recurrenceRule: 'FREQ=DAILY;COUNT=2' }) },
        ],
      } as never,
    );

    const result = await syncService.runManualSyncNow(connection.id);
    const debugTrace = syncService.getDebugTrace(connection.id);

    assert.equal(result.ok, true);
    assert.equal(debugTrace.available, true);
    assert.equal(debugTrace.trace?.summary.expectedRecurringSkips, 2);
    assert.equal(debugTrace.trace?.cursorDiagnostics.bitrix.before, null);
    assert.match(String(debugTrace.trace?.cursorDiagnostics.bitrix.after), /T/);
    assert.ok((debugTrace.trace?.trail ?? []).some((item) => item.decision?.reason === 'recurrence_unsupported'));
  } finally {
    temp.cleanup();
  }
});

test('sync service preserves Bitrix cursor on fetch failure and reports provider call diagnostics', async () => {
  const temp = makeTempDbPath('debug-trace-bitrix-fetch-failure');
  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const { connection } = setupReadyConnection(sqliteService);
    const previousBitrixCursor = '2026-03-25T08:00:00.000Z';
    const previousYandexCursor = '2026-03-25T08:00:00.000Z';
    sqliteService.updateSyncState(connection.id, {
      bitrixSyncCursor: previousBitrixCursor,
      yandexSyncCursor: previousYandexCursor,
    });

    const syncService = new SyncService(
      sqliteService,
      {
        createEvent: async (_connectionId: string, draft: unknown) => createBitrixEvent({
          description: (draft as { description?: string }).description ?? 'Description',
          id: 'bitrix-created-from-yandex',
          title: (draft as { title?: string }).title ?? 'Yandex event',
        }),
        listEventsSince: async () => {
          throw new Error('QUERY_LIMIT_EXCEEDED');
        },
      } as never,
      {
        listEventResults: async () => [
          { ok: true as const, value: createYandexEvent({ uid: 'yandex-new', url: 'https://caldav.yandex.ru/calendars/user/default/yandex-new.ics' }) },
        ],
      } as never,
    );

    const result = await syncService.runManualSyncNow(connection.id);
    const state = sqliteService.getSyncState(connection.id);
    const debugTrace = syncService.getDebugTrace(connection.id);

    assert.equal(result.ok, true);
    assert.equal(result.processedYandexEvents, 1);
    assert.equal(state.bitrixSyncCursor, previousBitrixCursor);
    assert.notEqual(state.yandexSyncCursor, previousYandexCursor);
    assert.equal(state.lastOutcomeReason, 'incremental_sync_completed_with_soft_failures');
    assert.equal(debugTrace.trace?.summary.providerCallErrors.bitrix_list_events_failed, 1);
    assert.equal(debugTrace.trace?.cursorDiagnostics.bitrix.note, 'bitrix_cursor_preserved_due_to_fetch_failure');
  } finally {
    temp.cleanup();
  }
});

test('recurring expected skip does not populate last error message', async () => {
  const temp = makeTempDbPath('recurring-last-error');
  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const { connection } = setupReadyConnection(sqliteService);
    const today = new Date();
    const startsAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12, 0, 0)).toISOString();
    const endsAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 13, 0, 0)).toISOString();
    const syncService = new SyncService(
      sqliteService,
      {
        listEventsSince: async () => [createBitrixEvent({ endsAt, startsAt, id: 'bitrix-recurring-only', recurrenceRule: 'FREQ=DAILY;COUNT=2' })],
      } as never,
      {
        listEventResults: async () => [],
      } as never,
    );

    const result = await syncService.runManualSyncNow(connection.id);
    const state = sqliteService.getSyncState(connection.id);

    assert.equal(result.ok, true);
    assert.equal(state.lastErrorMessage, null);
    assert.equal(state.status, 'success');
    assert.equal(state.lastSkippedRecurringEvents, 1);
  } finally {
    temp.cleanup();
  }
});

test('sync service debug trace applies redaction and truncation markers for payload contract', () => {
  const temp = makeTempDbPath('debug-trace-redaction-truncation');
  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const { connection } = setupReadyConnection(sqliteService);
    const syncService = new SyncService(sqliteService, {} as never, {} as never);

    const oversizedTrail = Array.from({ length: 230 }, (_, index) => ({
      decision: { reason: 'mapping_missing' },
      eventKey: `event-${index}`,
    }));

    sqliteService.updateSyncState(connection.id, {
      lastDebugTrace: {
        runMeta: { status: 'success', trigger: 'manual_sync' },
        secretToken: 'top-secret',
        summary: { trailCount: oversizedTrail.length },
        trail: oversizedTrail,
      },
    });

    const debugTrace = syncService.getDebugTrace(connection.id);
    const markers = debugTrace.markers.map((item) => item.reason);

    assert.equal(debugTrace.available, true);
    assert.equal(debugTrace.truncated, true);
    assert.ok(markers.includes('redacted'));
    assert.ok(markers.includes('truncated_array'));
    assert.equal((debugTrace.trace?.trail as unknown[]).length, 200);
    assert.equal((debugTrace.trace as { secretToken?: string }).secretToken, '***redacted***');
  } finally {
    temp.cleanup();
  }
});
