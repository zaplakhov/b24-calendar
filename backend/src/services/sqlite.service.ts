/*
Module: sqlite.service
Role: Boots the SQLite database and persists single-user settings, provider calendars, sync state, and event mappings.
Source of Truth: backend/src/services/sqlite.service.ts

Uses:
  better-sqlite3:Database: true
  node:fs: true
  node:path: true

Used by:
  ../index.ts:createApp: true
  ../routes/settings.routes.ts:createSettingsRouter: true
  ../services/bitrix.service.ts:BitrixService: true
  ../services/yandex-caldav.service.ts:YandexCalDavService: true
  ../services/sync.service.ts:SyncService: true

Glossary: none
*/

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type ProviderType = 'bitrix' | 'yandex';
export type SyncRuntimeStatus = 'idle' | 'running' | 'success' | 'error' | 'disabled';
const DEFAULT_YANDEX_CALDAV_BASE_URL = 'https://caldav.yandex.ru';

export interface AppSettings { bitrixWebhookUrl: string; bitrixUserId: string; bitrixAuthToken: string; bitrixCalendarId: string; yandexBaseUrl: string; yandexUsername: string; yandexPassword: string; yandexCalendarUrl: string; syncEnabled: boolean; }
export interface PersistedCalendar { provider: ProviderType; id: string; name: string; color: string | null; url: string | null; payload: Record<string, unknown>; }
export interface SyncState { status: SyncRuntimeStatus; lastRunAt: string | null; lastSuccessAt: string | null; lastErrorAt: string | null; lastErrorMessage: string | null; lastWebhookAt: string | null; lastPollAt: string | null; activeDirection: string | null; yandexSyncCursor: string | null; pollingFailureCount: number; lastProcessedBitrixEvents: number; lastProcessedYandexEvents: number; lastSkippedRecurringEvents: number; lastOutcomeReason: string | null; }
export interface EventMappingRecord { bitrixEventId: string | null; yandexEventUrl: string | null; yandexEventEtag: string | null; yandexEventUid: string | null; sourceFingerprint: string | null; targetFingerprint: string | null; bitrixUpdatedAt: string | null; yandexUpdatedAt: string | null; lastWinner: 'bitrix' | 'yandex' | null; lastDecisionReason: string | null; status: string; lastSyncedAt: string | null; deletedAt: string | null; deletedBy: 'bitrix' | 'yandex' | null; }
interface SettingsRow { bitrix_webhook_url: string | null; bitrix_user_id: string | null; bitrix_auth_token: string | null; bitrix_calendar_id: string | null; yandex_base_url: string | null; yandex_username: string | null; yandex_password: string | null; yandex_calendar_url: string | null; sync_enabled: number | null; }
interface CalendarRow { provider: ProviderType; external_id: string; display_name: string; color: string | null; resource_url: string | null; payload_json: string | null; }
interface SyncStateRow { status: SyncRuntimeStatus; last_run_at: string | null; last_success_at: string | null; last_error_at: string | null; last_error_message: string | null; last_webhook_at: string | null; last_poll_at: string | null; active_direction: string | null; yandex_sync_cursor: string | null; polling_failure_count: number | null; last_processed_bitrix_events: number | null; last_processed_yandex_events: number | null; last_skipped_recurring_events: number | null; last_outcome_reason: string | null; }
interface MappingRow { bitrix_event_id: string | null; yandex_event_url: string | null; yandex_event_etag: string | null; yandex_event_uid: string | null; source_fingerprint: string | null; target_fingerprint: string | null; bitrix_updated_at: string | null; yandex_updated_at: string | null; last_winner: 'bitrix' | 'yandex' | null; last_decision_reason: string | null; status: string; last_synced_at: string | null; deleted_at: string | null; deleted_by: 'bitrix' | 'yandex' | null; }

const DEFAULT_SETTINGS: AppSettings = {
  bitrixWebhookUrl: process.env.BITRIX_WEBHOOK_URL ?? '',
  bitrixUserId: process.env.BITRIX_USER_ID ?? '',
  bitrixAuthToken: process.env.BITRIX_AUTH_TOKEN ?? '',
  bitrixCalendarId: process.env.BITRIX_CALENDAR_ID ?? '',
  yandexBaseUrl: process.env.YANDEX_BASE_URL ?? DEFAULT_YANDEX_CALDAV_BASE_URL,
  yandexUsername: process.env.YANDEX_USERNAME ?? '',
  yandexPassword: process.env.YANDEX_PASSWORD ?? '',
  yandexCalendarUrl: process.env.YANDEX_CALENDAR_URL ?? '',
  syncEnabled: (process.env.SYNC_ENABLED ?? '').toLowerCase() === 'true',
};

const DEFAULT_SYNC_STATE: SyncState = { status: 'idle', lastRunAt: null, lastSuccessAt: null, lastErrorAt: null, lastErrorMessage: null, lastWebhookAt: null, lastPollAt: null, activeDirection: null, yandexSyncCursor: null, pollingFailureCount: 0, lastProcessedBitrixEvents: 0, lastProcessedYandexEvents: 0, lastSkippedRecurringEvents: 0, lastOutcomeReason: null };

function resolveDatabasePath(rawPath = process.env.SQLITE_DB_PATH): string {
  if (rawPath && rawPath.trim().length > 0) return resolve(rawPath);
  return resolve(process.cwd(), 'data', 'b24-calendar.sqlite');
}

function normalizeNullableString(value: string | null | undefined): string {
  return value ?? '';
}

function parseCalendarPayload(payload: string | null): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export class SQLiteService {
  private readonly database: Database.Database;

  public constructor(databasePath = resolveDatabasePath()) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.bootstrap();
  }

  public getSettings(): AppSettings {
    const row = this.database
      .prepare<[], SettingsRow>('SELECT bitrix_webhook_url, bitrix_user_id, bitrix_auth_token, bitrix_calendar_id, yandex_base_url, yandex_username, yandex_password, yandex_calendar_url, sync_enabled FROM app_settings WHERE id = 1')
      .get();

    if (!row) return { ...DEFAULT_SETTINGS };

    return {
      bitrixWebhookUrl: normalizeNullableString(row.bitrix_webhook_url) || DEFAULT_SETTINGS.bitrixWebhookUrl,
      bitrixUserId: normalizeNullableString(row.bitrix_user_id) || DEFAULT_SETTINGS.bitrixUserId,
      bitrixAuthToken: normalizeNullableString(row.bitrix_auth_token) || DEFAULT_SETTINGS.bitrixAuthToken,
      bitrixCalendarId: normalizeNullableString(row.bitrix_calendar_id) || DEFAULT_SETTINGS.bitrixCalendarId,
      yandexBaseUrl: normalizeNullableString(row.yandex_base_url) || DEFAULT_SETTINGS.yandexBaseUrl,
      yandexUsername: normalizeNullableString(row.yandex_username) || DEFAULT_SETTINGS.yandexUsername,
      yandexPassword: normalizeNullableString(row.yandex_password) || DEFAULT_SETTINGS.yandexPassword,
      yandexCalendarUrl: normalizeNullableString(row.yandex_calendar_url) || DEFAULT_SETTINGS.yandexCalendarUrl,
      syncEnabled: row.sync_enabled === null ? DEFAULT_SETTINGS.syncEnabled : Boolean(row.sync_enabled),
    };
  }

  public updateSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = { ...current, ...patch };

    this.database
      .prepare(
        `
          UPDATE app_settings
          SET bitrix_webhook_url = @bitrixWebhookUrl,
              bitrix_user_id = @bitrixUserId,
              bitrix_auth_token = @bitrixAuthToken,
              bitrix_calendar_id = @bitrixCalendarId,
              yandex_base_url = @yandexBaseUrl,
              yandex_username = @yandexUsername,
              yandex_password = @yandexPassword,
              yandex_calendar_url = @yandexCalendarUrl,
              sync_enabled = @syncEnabled
          WHERE id = 1
        `,
      )
      .run({
        ...next,
        syncEnabled: next.syncEnabled ? 1 : 0,
      });

    return next;
  }

  public getProviderCalendars(provider: ProviderType): PersistedCalendar[] {
    const rows = this.database
      .prepare<[ProviderType], CalendarRow>('SELECT provider, external_id, display_name, color, resource_url, payload_json FROM provider_calendars WHERE provider = ? ORDER BY display_name COLLATE NOCASE ASC')
      .all(provider);

    return rows.map((row) => ({ provider: row.provider, id: row.external_id, name: row.display_name, color: row.color, url: row.resource_url, payload: parseCalendarPayload(row.payload_json) }));
  }

  public replaceProviderCalendars(provider: ProviderType, calendars: PersistedCalendar[]): PersistedCalendar[] {
    const replaceCalendars = this.database.transaction((items: PersistedCalendar[]) => {
      this.database.prepare<[ProviderType]>('DELETE FROM provider_calendars WHERE provider = ?').run(provider);

      const insertStatement = this.database.prepare(
        `
          INSERT INTO provider_calendars (provider, external_id, display_name, color, resource_url, payload_json)
          VALUES (@provider, @id, @name, @color, @url, @payload)
        `,
      );

      for (const calendar of items) insertStatement.run({ provider: calendar.provider, id: calendar.id, name: calendar.name, color: calendar.color, url: calendar.url, payload: JSON.stringify(calendar.payload) });
    });

    replaceCalendars(calendars);
    return this.getProviderCalendars(provider);
  }

  public getSyncState(): SyncState {
    const row = this.database
      .prepare<[], SyncStateRow>('SELECT status, last_run_at, last_success_at, last_error_at, last_error_message, last_webhook_at, last_poll_at, active_direction, yandex_sync_cursor, polling_failure_count, last_processed_bitrix_events, last_processed_yandex_events, last_skipped_recurring_events, last_outcome_reason FROM sync_state WHERE id = 1')
      .get();

    if (!row) return { ...DEFAULT_SYNC_STATE };

    return {
      status: row.status,
      lastRunAt: row.last_run_at,
      lastSuccessAt: row.last_success_at,
      lastErrorAt: row.last_error_at,
      lastErrorMessage: row.last_error_message,
      lastWebhookAt: row.last_webhook_at,
      lastPollAt: row.last_poll_at,
      activeDirection: row.active_direction,
      yandexSyncCursor: row.yandex_sync_cursor,
      pollingFailureCount: row.polling_failure_count ?? 0,
      lastProcessedBitrixEvents: row.last_processed_bitrix_events ?? 0,
      lastProcessedYandexEvents: row.last_processed_yandex_events ?? 0,
      lastSkippedRecurringEvents: row.last_skipped_recurring_events ?? 0,
      lastOutcomeReason: row.last_outcome_reason,
    };
  }

  public updateSyncState(patch: Partial<SyncState>): SyncState {
    const current = this.getSyncState();
    const next: SyncState = { ...current, ...patch };

    this.database
      .prepare(
        `
          UPDATE sync_state
          SET status = @status,
              last_run_at = @lastRunAt,
              last_success_at = @lastSuccessAt,
              last_error_at = @lastErrorAt,
              last_error_message = @lastErrorMessage,
              last_webhook_at = @lastWebhookAt,
              last_poll_at = @lastPollAt,
              active_direction = @activeDirection,
              yandex_sync_cursor = @yandexSyncCursor,
              polling_failure_count = @pollingFailureCount,
              last_processed_bitrix_events = @lastProcessedBitrixEvents,
              last_processed_yandex_events = @lastProcessedYandexEvents,
              last_skipped_recurring_events = @lastSkippedRecurringEvents,
              last_outcome_reason = @lastOutcomeReason
            WHERE id = 1
        `,
      )
      .run(next);

    return next;
  }

  public listEventMappings(): EventMappingRecord[] {
    const rows = this.database
      .prepare<[], MappingRow>("SELECT bitrix_event_id, yandex_event_url, yandex_event_etag, yandex_event_uid, source_fingerprint, target_fingerprint, bitrix_updated_at, yandex_updated_at, last_winner, last_decision_reason, status, last_synced_at, deleted_at, deleted_by FROM event_mappings ORDER BY COALESCE(last_synced_at, deleted_at, '') DESC")
      .all();
    return rows.map((row) => this.mapMappingRow(row));
  }

  public getEventMappingByBitrixId(bitrixEventId: string): EventMappingRecord | null {
    const row = this.database
      .prepare<[string], MappingRow>('SELECT bitrix_event_id, yandex_event_url, yandex_event_etag, yandex_event_uid, source_fingerprint, target_fingerprint, bitrix_updated_at, yandex_updated_at, last_winner, last_decision_reason, status, last_synced_at, deleted_at, deleted_by FROM event_mappings WHERE bitrix_event_id = ?')
      .get(bitrixEventId);

    return row ? this.mapMappingRow(row) : null;
  }

  public getEventMappingByYandexUrl(yandexEventUrl: string): EventMappingRecord | null {
    const row = this.database
      .prepare<[string], MappingRow>('SELECT bitrix_event_id, yandex_event_url, yandex_event_etag, yandex_event_uid, source_fingerprint, target_fingerprint, bitrix_updated_at, yandex_updated_at, last_winner, last_decision_reason, status, last_synced_at, deleted_at, deleted_by FROM event_mappings WHERE yandex_event_url = ?')
      .get(yandexEventUrl);

    return row ? this.mapMappingRow(row) : null;
  }

  public upsertEventMapping(record: EventMappingRecord): EventMappingRecord {
    const existing = (record.bitrixEventId ? this.getEventMappingByBitrixId(record.bitrixEventId) : null)
      ?? (record.yandexEventUrl ? this.getEventMappingByYandexUrl(record.yandexEventUrl) : null);
    const nextRecord = existing ? { ...existing, ...record } : record;
    const updateByBitrix = this.database.prepare(
      `UPDATE event_mappings
         SET yandex_event_url = @yandexEventUrl,
             yandex_event_etag = @yandexEventEtag,
             yandex_event_uid = @yandexEventUid,
             source_fingerprint = @sourceFingerprint,
             target_fingerprint = @targetFingerprint,
             bitrix_updated_at = @bitrixUpdatedAt,
             yandex_updated_at = @yandexUpdatedAt,
             last_winner = @lastWinner,
             last_decision_reason = @lastDecisionReason,
             status = @status,
             last_synced_at = @lastSyncedAt,
             deleted_at = @deletedAt,
             deleted_by = @deletedBy
       WHERE bitrix_event_id = @bitrixEventId`,
    );
    const updateByYandex = this.database.prepare(
      `UPDATE event_mappings
         SET bitrix_event_id = @bitrixEventId,
             yandex_event_etag = @yandexEventEtag,
             yandex_event_uid = @yandexEventUid,
             source_fingerprint = @sourceFingerprint,
             target_fingerprint = @targetFingerprint,
             bitrix_updated_at = @bitrixUpdatedAt,
             yandex_updated_at = @yandexUpdatedAt,
             last_winner = @lastWinner,
             last_decision_reason = @lastDecisionReason,
             status = @status,
             last_synced_at = @lastSyncedAt,
             deleted_at = @deletedAt,
             deleted_by = @deletedBy
       WHERE yandex_event_url = @yandexEventUrl`,
    );
    const insert = this.database.prepare(
      `INSERT INTO event_mappings (
         bitrix_event_id, yandex_event_url, yandex_event_etag, yandex_event_uid, source_fingerprint, target_fingerprint,
         bitrix_updated_at, yandex_updated_at, last_winner, last_decision_reason, status, last_synced_at, deleted_at, deleted_by
       ) VALUES (
         @bitrixEventId, @yandexEventUrl, @yandexEventEtag, @yandexEventUid, @sourceFingerprint, @targetFingerprint,
         @bitrixUpdatedAt, @yandexUpdatedAt, @lastWinner, @lastDecisionReason, @status, @lastSyncedAt, @deletedAt, @deletedBy
       )`,
    );

    if (existing?.bitrixEventId) updateByBitrix.run(nextRecord);
    else if (existing?.yandexEventUrl) updateByYandex.run(nextRecord);
    else insert.run(nextRecord);

    if (nextRecord.bitrixEventId) return this.getEventMappingByBitrixId(nextRecord.bitrixEventId) ?? nextRecord;
    if (nextRecord.yandexEventUrl) return this.getEventMappingByYandexUrl(nextRecord.yandexEventUrl) ?? nextRecord;
    return nextRecord;
  }

  public deleteEventMapping(bitrixEventId: string | null, yandexEventUrl: string | null): void {
    if (bitrixEventId) {
      this.database.prepare<[string]>('DELETE FROM event_mappings WHERE bitrix_event_id = ?').run(bitrixEventId);
      return;
    }
    if (yandexEventUrl) this.database.prepare<[string]>('DELETE FROM event_mappings WHERE yandex_event_url = ?').run(yandexEventUrl);
  }

  private bootstrap(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        bitrix_webhook_url TEXT,
        bitrix_user_id TEXT,
        bitrix_auth_token TEXT,
        bitrix_calendar_id TEXT,
        yandex_base_url TEXT,
        yandex_username TEXT,
        yandex_password TEXT,
        yandex_calendar_url TEXT,
        sync_enabled INTEGER NOT NULL DEFAULT 0
      );

      INSERT OR IGNORE INTO app_settings (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS provider_calendars (
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        color TEXT,
        resource_url TEXT,
        payload_json TEXT,
        PRIMARY KEY (provider, external_id)
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL DEFAULT 'idle',
        last_run_at TEXT,
        last_success_at TEXT,
        last_error_at TEXT,
        last_error_message TEXT,
        last_webhook_at TEXT,
        last_poll_at TEXT,
        active_direction TEXT,
        yandex_sync_cursor TEXT,
        polling_failure_count INTEGER NOT NULL DEFAULT 0,
        last_processed_bitrix_events INTEGER NOT NULL DEFAULT 0,
        last_processed_yandex_events INTEGER NOT NULL DEFAULT 0,
        last_skipped_recurring_events INTEGER NOT NULL DEFAULT 0,
        last_outcome_reason TEXT
      );

      INSERT OR IGNORE INTO sync_state (id, status) VALUES (1, 'idle');

      CREATE TABLE IF NOT EXISTS event_mappings (
        bitrix_event_id TEXT UNIQUE,
        yandex_event_url TEXT UNIQUE,
        yandex_event_etag TEXT,
        yandex_event_uid TEXT,
        source_fingerprint TEXT,
        target_fingerprint TEXT,
        bitrix_updated_at TEXT,
        yandex_updated_at TEXT,
        last_winner TEXT,
        last_decision_reason TEXT,
        status TEXT NOT NULL DEFAULT 'synced',
        last_synced_at TEXT,
        deleted_at TEXT,
        deleted_by TEXT
      );
    `);

    this.ensureSyncStateColumns();
    this.ensureEventMappingColumns();
  }

  private mapMappingRow(row: MappingRow): EventMappingRecord {
    return { bitrixEventId: row.bitrix_event_id, yandexEventUrl: row.yandex_event_url, yandexEventEtag: row.yandex_event_etag, yandexEventUid: row.yandex_event_uid, sourceFingerprint: row.source_fingerprint, targetFingerprint: row.target_fingerprint, bitrixUpdatedAt: row.bitrix_updated_at, yandexUpdatedAt: row.yandex_updated_at, lastWinner: row.last_winner, lastDecisionReason: row.last_decision_reason, status: row.status, lastSyncedAt: row.last_synced_at, deletedAt: row.deleted_at, deletedBy: row.deleted_by };
  }

  private ensureSyncStateColumns(): void {
    const columns = this.database.prepare<[], { name: string }>('PRAGMA table_info(sync_state)').all().map((column) => column.name);

    if (!columns.includes('yandex_sync_cursor')) {
      this.database.exec('ALTER TABLE sync_state ADD COLUMN yandex_sync_cursor TEXT');
    }

    if (!columns.includes('polling_failure_count')) {
      this.database.exec('ALTER TABLE sync_state ADD COLUMN polling_failure_count INTEGER NOT NULL DEFAULT 0');
    }

    if (!columns.includes('last_processed_bitrix_events')) this.database.exec('ALTER TABLE sync_state ADD COLUMN last_processed_bitrix_events INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('last_processed_yandex_events')) this.database.exec('ALTER TABLE sync_state ADD COLUMN last_processed_yandex_events INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('last_skipped_recurring_events')) this.database.exec('ALTER TABLE sync_state ADD COLUMN last_skipped_recurring_events INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('last_outcome_reason')) this.database.exec('ALTER TABLE sync_state ADD COLUMN last_outcome_reason TEXT');
  }

  private ensureEventMappingColumns(): void {
    const columns = this.database.prepare<[], { name: string }>('PRAGMA table_info(event_mappings)').all().map((column) => column.name);

    if (!columns.includes('bitrix_updated_at')) this.database.exec('ALTER TABLE event_mappings ADD COLUMN bitrix_updated_at TEXT');
    if (!columns.includes('yandex_updated_at')) this.database.exec('ALTER TABLE event_mappings ADD COLUMN yandex_updated_at TEXT');
    if (!columns.includes('last_winner')) this.database.exec('ALTER TABLE event_mappings ADD COLUMN last_winner TEXT');
    if (!columns.includes('last_decision_reason')) this.database.exec('ALTER TABLE event_mappings ADD COLUMN last_decision_reason TEXT');
    if (!columns.includes('deleted_at')) this.database.exec('ALTER TABLE event_mappings ADD COLUMN deleted_at TEXT');
    if (!columns.includes('deleted_by')) this.database.exec('ALTER TABLE event_mappings ADD COLUMN deleted_by TEXT');
  }
}
