/*
Module: sqlite.service
Role: Persists Bitrix installations, per-user connections, scoped sync state, provider calendars, and event mappings.
Source of Truth: backend/src/services/sqlite.service.ts

Uses:
  better-sqlite3:Database: true
  node:crypto:randomBytes: true
  node:crypto:randomUUID: true
  node:fs: true
  node:path: true

Used by:
  ../index.ts:createApp: true
  ../routes/onboarding.routes.ts:createOnboardingRouter: true
  ../routes/bitrix.routes.ts:createBitrixRouter: true
  ../services/bitrix-auth.service.ts:BitrixAuthService: true
  ../services/bitrix.service.ts:BitrixService: true
  ../services/yandex-caldav.service.ts:YandexCalDavService: true
  ../services/sync.service.ts:SyncService: true

Glossary: none
*/

import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type ProviderType = 'bitrix' | 'yandex';
export type SyncRuntimeStatus = 'idle' | 'running' | 'success' | 'error' | 'disabled';
export type InstallationStatus = 'pending' | 'active' | 'uninstalled';

const DEFAULT_YANDEX_CALDAV_BASE_URL = 'https://caldav.yandex.ru';

export interface BitrixInstallation {
  id: string;
  portalHost: string;
  memberId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string | null;
  applicationToken: string | null;
  status: InstallationStatus;
  lastErrorMessage: string | null;
  installedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionSettings {
  id: string;
  installationId: string;
  onboardingToken: string;
  bitrixUserId: string;
  bitrixUserName: string | null;
  bitrixCalendarId: string;
  yandexBaseUrl: string;
  yandexUsername: string;
  yandexPassword: string;
  yandexCalendarUrl: string;
  syncEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionContext {
  installation: BitrixInstallation;
  connection: ConnectionSettings;
}

export interface PersistedCalendar {
  provider: ProviderType;
  id: string;
  name: string;
  color: string | null;
  url: string | null;
  payload: Record<string, unknown>;
}

export interface SyncState {
  status: SyncRuntimeStatus;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  lastWebhookAt: string | null;
  lastPollAt: string | null;
  activeDirection: string | null;
  bitrixSyncCursor: string | null;
  yandexSyncCursor: string | null;
  pollingFailureCount: number;
  lastProcessedBitrixEvents: number;
  lastProcessedYandexEvents: number;
  lastSkippedRecurringEvents: number;
  lastOutcomeReason: string | null;
}

export interface EventMappingRecord {
  connectionId: string;
  bitrixEventId: string | null;
  yandexEventUrl: string | null;
  yandexEventEtag: string | null;
  yandexEventUid: string | null;
  sourceFingerprint: string | null;
  targetFingerprint: string | null;
  bitrixUpdatedAt: string | null;
  yandexUpdatedAt: string | null;
  lastWinner: 'bitrix' | 'yandex' | null;
  lastDecisionReason: string | null;
  status: string;
  lastSyncedAt: string | null;
  deletedAt: string | null;
  deletedBy: 'bitrix' | 'yandex' | null;
}

interface InstallationRow {
  id: string;
  portal_host: string;
  member_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  scope: string | null;
  application_token: string | null;
  status: InstallationStatus;
  last_error_message: string | null;
  installed_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ConnectionRow {
  id: string;
  installation_id: string;
  onboarding_token: string;
  bitrix_user_id: string;
  bitrix_user_name: string | null;
  bitrix_calendar_id: string | null;
  yandex_base_url: string | null;
  yandex_username: string | null;
  yandex_password: string | null;
  yandex_calendar_url: string | null;
  sync_enabled: number;
  created_at: string;
  updated_at: string;
}

interface CalendarRow {
  provider: ProviderType;
  external_id: string;
  display_name: string;
  color: string | null;
  resource_url: string | null;
  payload_json: string | null;
}

interface SyncStateRow {
  status: SyncRuntimeStatus;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_message: string | null;
  last_webhook_at: string | null;
  last_poll_at: string | null;
  active_direction: string | null;
  bitrix_sync_cursor: string | null;
  yandex_sync_cursor: string | null;
  polling_failure_count: number | null;
  last_processed_bitrix_events: number | null;
  last_processed_yandex_events: number | null;
  last_skipped_recurring_events: number | null;
  last_outcome_reason: string | null;
}

interface MappingRow {
  connection_id: string;
  bitrix_event_id: string | null;
  yandex_event_url: string | null;
  yandex_event_etag: string | null;
  yandex_event_uid: string | null;
  source_fingerprint: string | null;
  target_fingerprint: string | null;
  bitrix_updated_at: string | null;
  yandex_updated_at: string | null;
  last_winner: 'bitrix' | 'yandex' | null;
  last_decision_reason: string | null;
  status: string;
  last_synced_at: string | null;
  deleted_at: string | null;
  deleted_by: 'bitrix' | 'yandex' | null;
}

const DEFAULT_SYNC_STATE: SyncState = {
  status: 'idle',
  lastRunAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  lastWebhookAt: null,
  lastPollAt: null,
  activeDirection: null,
  bitrixSyncCursor: null,
  yandexSyncCursor: null,
  pollingFailureCount: 0,
  lastProcessedBitrixEvents: 0,
  lastProcessedYandexEvents: 0,
  lastSkippedRecurringEvents: 0,
  lastOutcomeReason: null,
};

function resolveDatabasePath(rawPath = process.env.SQLITE_DB_PATH): string {
  if (rawPath && rawPath.trim().length > 0) {
    return resolve(rawPath);
  }

  return resolve(process.cwd(), 'data', 'b24-calendar.sqlite');
}

function normalizeNullableString(value: string | null | undefined): string {
  return value ?? '';
}

function parseCalendarPayload(payload: string | null): Record<string, unknown> {
  if (!payload) {
    return {};
  }

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function newPublicToken(): string {
  return randomBytes(24).toString('hex');
}

function normalizePortalHost(portalHost: string): string {
  return portalHost
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

export class SQLiteService {
  private readonly database: Database.Database;

  public constructor(databasePath = resolveDatabasePath()) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.bootstrap();
  }

  public upsertInstallation(input: {
    portalHost: string;
    memberId?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
    expiresAt?: string | null;
    scope?: string | null;
    applicationToken?: string | null;
    status?: InstallationStatus;
    lastErrorMessage?: string | null;
    installedByUserId?: string | null;
  }): BitrixInstallation {
    const portalHost = normalizePortalHost(input.portalHost);
    const existing = this.getInstallationByPortalHost(portalHost)
      ?? (input.memberId ? this.getInstallationByMemberId(input.memberId) : null);
    const timestamp = nowIso();

    if (existing) {
      const next = {
        ...existing,
        portalHost,
        memberId: input.memberId ?? existing.memberId,
        accessToken: input.accessToken ?? existing.accessToken,
        refreshToken: input.refreshToken ?? existing.refreshToken,
        expiresAt: input.expiresAt ?? existing.expiresAt,
        scope: input.scope ?? existing.scope,
        applicationToken: input.applicationToken ?? existing.applicationToken,
        status: input.status ?? existing.status,
        lastErrorMessage: input.lastErrorMessage ?? existing.lastErrorMessage,
        installedByUserId: input.installedByUserId ?? existing.installedByUserId,
        updatedAt: timestamp,
      };

      this.database.prepare(
        `UPDATE bitrix_installations
           SET portal_host = @portalHost,
               member_id = @memberId,
               access_token = @accessToken,
               refresh_token = @refreshToken,
               expires_at = @expiresAt,
               scope = @scope,
               application_token = @applicationToken,
               status = @status,
               last_error_message = @lastErrorMessage,
               installed_by_user_id = @installedByUserId,
               updated_at = @updatedAt
         WHERE id = @id`,
      ).run(next);

      return this.getInstallationById(existing.id) ?? next;
    }

    const created: BitrixInstallation = {
      id: randomUUID(),
      portalHost,
      memberId: input.memberId ?? null,
      accessToken: input.accessToken ?? null,
      refreshToken: input.refreshToken ?? null,
      expiresAt: input.expiresAt ?? null,
      scope: input.scope ?? null,
      applicationToken: input.applicationToken ?? null,
      status: input.status ?? 'pending',
      lastErrorMessage: input.lastErrorMessage ?? null,
      installedByUserId: input.installedByUserId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.database.prepare(
      `INSERT INTO bitrix_installations (
         id, portal_host, member_id, access_token, refresh_token, expires_at, scope,
         application_token, status, last_error_message, installed_by_user_id, created_at, updated_at
       ) VALUES (
         @id, @portalHost, @memberId, @accessToken, @refreshToken, @expiresAt, @scope,
         @applicationToken, @status, @lastErrorMessage, @installedByUserId, @createdAt, @updatedAt
       )`,
    ).run(created);

    return created;
  }

  public updateInstallationStatus(installationId: string, patch: Partial<Omit<BitrixInstallation, 'id' | 'createdAt'>>): BitrixInstallation {
    const current = this.getInstallationById(installationId);
    if (!current) {
      throw new Error(`Bitrix installation ${installationId} was not found.`);
    }

    return this.upsertInstallation({
      portalHost: patch.portalHost ?? current.portalHost,
      memberId: patch.memberId ?? current.memberId,
      accessToken: patch.accessToken ?? current.accessToken,
      refreshToken: patch.refreshToken ?? current.refreshToken,
      expiresAt: patch.expiresAt ?? current.expiresAt,
      scope: patch.scope ?? current.scope,
      applicationToken: patch.applicationToken ?? current.applicationToken,
      status: patch.status ?? current.status,
      lastErrorMessage: patch.lastErrorMessage ?? current.lastErrorMessage,
      installedByUserId: patch.installedByUserId ?? current.installedByUserId,
    });
  }

  public getInstallationById(installationId: string): BitrixInstallation | null {
    const row = this.database.prepare<[string], InstallationRow>('SELECT * FROM bitrix_installations WHERE id = ?').get(installationId);
    return row ? this.mapInstallationRow(row) : null;
  }

  public getInstallationByPortalHost(portalHost: string): BitrixInstallation | null {
    const row = this.database.prepare<[string], InstallationRow>('SELECT * FROM bitrix_installations WHERE portal_host = ?').get(normalizePortalHost(portalHost));
    return row ? this.mapInstallationRow(row) : null;
  }

  public getInstallationByMemberId(memberId: string): BitrixInstallation | null {
    const row = this.database.prepare<[string], InstallationRow>('SELECT * FROM bitrix_installations WHERE member_id = ?').get(memberId);
    return row ? this.mapInstallationRow(row) : null;
  }

  public listInstallations(): BitrixInstallation[] {
    const rows = this.database.prepare<[], InstallationRow>('SELECT * FROM bitrix_installations ORDER BY created_at DESC').all();
    return rows.map((row) => this.mapInstallationRow(row));
  }

  public createOrUpdateConnection(input: {
    installationId: string;
    bitrixUserId: string;
    bitrixUserName?: string | null;
  }): ConnectionSettings {
    const existing = this.getConnectionByInstallationAndUser(input.installationId, input.bitrixUserId);
    const timestamp = nowIso();

    if (existing) {
      this.database.prepare(
        `UPDATE user_connections
           SET bitrix_user_name = @bitrixUserName,
               updated_at = @updatedAt
         WHERE id = @id`,
      ).run({
        id: existing.id,
        bitrixUserName: input.bitrixUserName ?? existing.bitrixUserName,
        updatedAt: timestamp,
      });

      return this.getConnectionById(existing.id) ?? existing;
    }

    const created: ConnectionSettings = {
      id: randomUUID(),
      installationId: input.installationId,
      onboardingToken: newPublicToken(),
      bitrixUserId: input.bitrixUserId,
      bitrixUserName: input.bitrixUserName ?? null,
      bitrixCalendarId: '',
      yandexBaseUrl: process.env.YANDEX_BASE_URL ?? DEFAULT_YANDEX_CALDAV_BASE_URL,
      yandexUsername: '',
      yandexPassword: '',
      yandexCalendarUrl: '',
      syncEnabled: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.database.prepare(
      `INSERT INTO user_connections (
         id, installation_id, onboarding_token, bitrix_user_id, bitrix_user_name, bitrix_calendar_id,
         yandex_base_url, yandex_username, yandex_password, yandex_calendar_url, sync_enabled, created_at, updated_at
       ) VALUES (
         @id, @installationId, @onboardingToken, @bitrixUserId, @bitrixUserName, @bitrixCalendarId,
         @yandexBaseUrl, @yandexUsername, @yandexPassword, @yandexCalendarUrl, @syncEnabled, @createdAt, @updatedAt
       )`,
    ).run({
      ...created,
      syncEnabled: created.syncEnabled ? 1 : 0,
    });

    return created;
  }

  public getConnectionById(connectionId: string): ConnectionSettings | null {
    const row = this.database.prepare<[string], ConnectionRow>('SELECT * FROM user_connections WHERE id = ?').get(connectionId);
    return row ? this.mapConnectionRow(row) : null;
  }

  public getConnectionByOnboardingToken(onboardingToken: string): ConnectionSettings | null {
    const row = this.database.prepare<[string], ConnectionRow>('SELECT * FROM user_connections WHERE onboarding_token = ?').get(onboardingToken);
    return row ? this.mapConnectionRow(row) : null;
  }

  public getConnectionByInstallationAndUser(installationId: string, bitrixUserId: string): ConnectionSettings | null {
    const row = this.database.prepare<[string, string], ConnectionRow>('SELECT * FROM user_connections WHERE installation_id = ? AND bitrix_user_id = ?').get(installationId, bitrixUserId);
    return row ? this.mapConnectionRow(row) : null;
  }

  public getConnectionContext(connectionId: string): ConnectionContext | null {
    const connection = this.getConnectionById(connectionId);
    if (!connection) {
      return null;
    }

    const installation = this.getInstallationById(connection.installationId);
    if (!installation) {
      return null;
    }

    return {
      connection,
      installation,
    };
  }

  public getConnectionContextByToken(onboardingToken: string): ConnectionContext | null {
    const connection = this.getConnectionByOnboardingToken(onboardingToken);
    if (!connection) {
      return null;
    }

    return this.getConnectionContext(connection.id);
  }

  public updateConnectionSettings(connectionId: string, patch: Partial<Omit<ConnectionSettings, 'id' | 'installationId' | 'onboardingToken' | 'createdAt'>>): ConnectionSettings {
    const current = this.getConnectionById(connectionId);
    if (!current) {
      throw new Error(`Connection ${connectionId} was not found.`);
    }

    const next: ConnectionSettings = {
      ...current,
      ...patch,
      updatedAt: nowIso(),
      yandexBaseUrl: patch.yandexBaseUrl ?? current.yandexBaseUrl ?? DEFAULT_YANDEX_CALDAV_BASE_URL,
    };

    this.database.prepare(
      `UPDATE user_connections
         SET bitrix_user_name = @bitrixUserName,
             bitrix_calendar_id = @bitrixCalendarId,
             yandex_base_url = @yandexBaseUrl,
             yandex_username = @yandexUsername,
             yandex_password = @yandexPassword,
             yandex_calendar_url = @yandexCalendarUrl,
             sync_enabled = @syncEnabled,
             updated_at = @updatedAt
       WHERE id = @id`,
    ).run({
      ...next,
      syncEnabled: next.syncEnabled ? 1 : 0,
    });

    return this.getConnectionById(connectionId) ?? next;
  }

  public listConnectionsForInstallation(installationId: string): ConnectionSettings[] {
    const rows = this.database.prepare<[string], ConnectionRow>('SELECT * FROM user_connections WHERE installation_id = ? ORDER BY created_at ASC').all(installationId);
    return rows.map((row) => this.mapConnectionRow(row));
  }

  public listActiveConnections(): ConnectionContext[] {
    const rows = this.database.prepare<[], ConnectionRow>('SELECT * FROM user_connections WHERE sync_enabled = 1 ORDER BY updated_at DESC').all();
    return rows
      .map((row) => this.mapConnectionRow(row))
      .map((connection) => this.getConnectionContext(connection.id))
      .filter((item): item is ConnectionContext => Boolean(item?.installation.status === 'active'));
  }

  public getProviderCalendars(connectionId: string, provider: ProviderType): PersistedCalendar[] {
    const rows = this.database
      .prepare<[string, ProviderType], CalendarRow>('SELECT provider, external_id, display_name, color, resource_url, payload_json FROM connection_provider_calendars WHERE connection_id = ? AND provider = ? ORDER BY display_name COLLATE NOCASE ASC')
      .all(connectionId, provider);

    return rows.map((row) => ({
      provider: row.provider,
      id: row.external_id,
      name: row.display_name,
      color: row.color,
      url: row.resource_url,
      payload: parseCalendarPayload(row.payload_json),
    }));
  }

  public replaceProviderCalendars(connectionId: string, provider: ProviderType, calendars: PersistedCalendar[]): PersistedCalendar[] {
    const replaceCalendars = this.database.transaction((items: PersistedCalendar[]) => {
      this.database.prepare<[string, ProviderType]>('DELETE FROM connection_provider_calendars WHERE connection_id = ? AND provider = ?').run(connectionId, provider);

      const insertStatement = this.database.prepare(
        `INSERT INTO connection_provider_calendars (connection_id, provider, external_id, display_name, color, resource_url, payload_json)
         VALUES (@connectionId, @provider, @id, @name, @color, @url, @payload)`,
      );

      for (const calendar of items) {
        insertStatement.run({
          connectionId,
          provider: calendar.provider,
          id: calendar.id,
          name: calendar.name,
          color: calendar.color,
          url: calendar.url,
          payload: JSON.stringify(calendar.payload),
        });
      }
    });

    replaceCalendars(calendars);
    return this.getProviderCalendars(connectionId, provider);
  }

  public getSyncState(connectionId: string): SyncState {
    this.ensureScopedSyncState(connectionId);
    const row = this.database
      .prepare<[string], SyncStateRow>('SELECT status, last_run_at, last_success_at, last_error_at, last_error_message, last_webhook_at, last_poll_at, active_direction, bitrix_sync_cursor, yandex_sync_cursor, polling_failure_count, last_processed_bitrix_events, last_processed_yandex_events, last_skipped_recurring_events, last_outcome_reason FROM connection_sync_state WHERE connection_id = ?')
      .get(connectionId);

    if (!row) {
      return { ...DEFAULT_SYNC_STATE };
    }

    return {
      status: row.status,
      lastRunAt: row.last_run_at,
      lastSuccessAt: row.last_success_at,
      lastErrorAt: row.last_error_at,
      lastErrorMessage: row.last_error_message,
      lastWebhookAt: row.last_webhook_at,
      lastPollAt: row.last_poll_at,
      activeDirection: row.active_direction,
      bitrixSyncCursor: row.bitrix_sync_cursor,
      yandexSyncCursor: row.yandex_sync_cursor,
      pollingFailureCount: row.polling_failure_count ?? 0,
      lastProcessedBitrixEvents: row.last_processed_bitrix_events ?? 0,
      lastProcessedYandexEvents: row.last_processed_yandex_events ?? 0,
      lastSkippedRecurringEvents: row.last_skipped_recurring_events ?? 0,
      lastOutcomeReason: row.last_outcome_reason,
    };
  }

  public updateSyncState(connectionId: string, patch: Partial<SyncState>): SyncState {
    const current = this.getSyncState(connectionId);
    const next: SyncState = { ...current, ...patch };

    this.database.prepare(
      `UPDATE connection_sync_state
         SET status = @status,
             last_run_at = @lastRunAt,
             last_success_at = @lastSuccessAt,
             last_error_at = @lastErrorAt,
             last_error_message = @lastErrorMessage,
              last_webhook_at = @lastWebhookAt,
              last_poll_at = @lastPollAt,
              active_direction = @activeDirection,
              bitrix_sync_cursor = @bitrixSyncCursor,
              yandex_sync_cursor = @yandexSyncCursor,
             polling_failure_count = @pollingFailureCount,
             last_processed_bitrix_events = @lastProcessedBitrixEvents,
             last_processed_yandex_events = @lastProcessedYandexEvents,
             last_skipped_recurring_events = @lastSkippedRecurringEvents,
             last_outcome_reason = @lastOutcomeReason
       WHERE connection_id = @connectionId`,
    ).run({
      connectionId,
      ...next,
    });

    return next;
  }

  public listEventMappings(connectionId: string): EventMappingRecord[] {
    const rows = this.database
      .prepare<[string], MappingRow>("SELECT connection_id, bitrix_event_id, yandex_event_url, yandex_event_etag, yandex_event_uid, source_fingerprint, target_fingerprint, bitrix_updated_at, yandex_updated_at, last_winner, last_decision_reason, status, last_synced_at, deleted_at, deleted_by FROM connection_event_mappings WHERE connection_id = ? ORDER BY COALESCE(last_synced_at, deleted_at, '') DESC")
      .all(connectionId);

    return rows.map((row) => this.mapMappingRow(row));
  }

  public getEventMappingByBitrixId(connectionId: string, bitrixEventId: string): EventMappingRecord | null {
    const row = this.database
      .prepare<[string, string], MappingRow>('SELECT connection_id, bitrix_event_id, yandex_event_url, yandex_event_etag, yandex_event_uid, source_fingerprint, target_fingerprint, bitrix_updated_at, yandex_updated_at, last_winner, last_decision_reason, status, last_synced_at, deleted_at, deleted_by FROM connection_event_mappings WHERE connection_id = ? AND bitrix_event_id = ?')
      .get(connectionId, bitrixEventId);

    return row ? this.mapMappingRow(row) : null;
  }

  public getEventMappingByYandexUrl(connectionId: string, yandexEventUrl: string): EventMappingRecord | null {
    const row = this.database
      .prepare<[string, string], MappingRow>('SELECT connection_id, bitrix_event_id, yandex_event_url, yandex_event_etag, yandex_event_uid, source_fingerprint, target_fingerprint, bitrix_updated_at, yandex_updated_at, last_winner, last_decision_reason, status, last_synced_at, deleted_at, deleted_by FROM connection_event_mappings WHERE connection_id = ? AND yandex_event_url = ?')
      .get(connectionId, yandexEventUrl);

    return row ? this.mapMappingRow(row) : null;
  }

  public upsertEventMapping(record: EventMappingRecord): EventMappingRecord {
    const existing = (record.bitrixEventId ? this.getEventMappingByBitrixId(record.connectionId, record.bitrixEventId) : null)
      ?? (record.yandexEventUrl ? this.getEventMappingByYandexUrl(record.connectionId, record.yandexEventUrl) : null);
    const nextRecord = existing ? { ...existing, ...record } : record;

    if (existing) {
      this.database.prepare(
        `UPDATE connection_event_mappings
           SET bitrix_event_id = @bitrixEventId,
               yandex_event_url = @yandexEventUrl,
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
         WHERE connection_id = @connectionId
           AND (
             (bitrix_event_id = @existingBitrixEventId AND @existingBitrixEventId IS NOT NULL)
             OR (yandex_event_url = @existingYandexEventUrl AND @existingYandexEventUrl IS NOT NULL)
           )`,
      ).run({
        ...nextRecord,
        existingBitrixEventId: existing.bitrixEventId,
        existingYandexEventUrl: existing.yandexEventUrl,
      });
    } else {
      this.database.prepare(
        `INSERT INTO connection_event_mappings (
           connection_id, bitrix_event_id, yandex_event_url, yandex_event_etag, yandex_event_uid,
           source_fingerprint, target_fingerprint, bitrix_updated_at, yandex_updated_at, last_winner,
           last_decision_reason, status, last_synced_at, deleted_at, deleted_by
         ) VALUES (
           @connectionId, @bitrixEventId, @yandexEventUrl, @yandexEventEtag, @yandexEventUid,
           @sourceFingerprint, @targetFingerprint, @bitrixUpdatedAt, @yandexUpdatedAt, @lastWinner,
           @lastDecisionReason, @status, @lastSyncedAt, @deletedAt, @deletedBy
         )`,
      ).run(nextRecord);
    }

    if (nextRecord.bitrixEventId) {
      return this.getEventMappingByBitrixId(nextRecord.connectionId, nextRecord.bitrixEventId) ?? nextRecord;
    }

    if (nextRecord.yandexEventUrl) {
      return this.getEventMappingByYandexUrl(nextRecord.connectionId, nextRecord.yandexEventUrl) ?? nextRecord;
    }

    return nextRecord;
  }

  public resetConnectionSync(connectionId: string): void {
    this.ensureScopedSyncState(connectionId);
    this.database.prepare<[string]>('DELETE FROM connection_event_mappings WHERE connection_id = ?').run(connectionId);
    this.database.prepare(
      `UPDATE connection_sync_state
         SET status = 'idle',
             last_run_at = NULL,
             last_success_at = NULL,
             last_error_at = NULL,
             last_error_message = NULL,
             last_poll_at = NULL,
             active_direction = NULL,
             bitrix_sync_cursor = NULL,
             yandex_sync_cursor = NULL,
             polling_failure_count = 0,
             last_processed_bitrix_events = 0,
             last_processed_yandex_events = 0,
             last_skipped_recurring_events = 0,
             last_outcome_reason = NULL
       WHERE connection_id = ?`,
    ).run(connectionId);
  }

  public countConnections(): number {
    const row = this.database.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM user_connections').get();
    return row?.count ?? 0;
  }

  public countActiveConnections(): number {
    const row = this.database.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM user_connections WHERE sync_enabled = 1').get();
    return row?.count ?? 0;
  }

  private bootstrap(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS bitrix_installations (
        id TEXT PRIMARY KEY,
        portal_host TEXT NOT NULL UNIQUE,
        member_id TEXT UNIQUE,
        access_token TEXT,
        refresh_token TEXT,
        expires_at TEXT,
        scope TEXT,
        application_token TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error_message TEXT,
        installed_by_user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_connections (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        onboarding_token TEXT NOT NULL UNIQUE,
        bitrix_user_id TEXT NOT NULL,
        bitrix_user_name TEXT,
        bitrix_calendar_id TEXT,
        yandex_base_url TEXT,
        yandex_username TEXT,
        yandex_password TEXT,
        yandex_calendar_url TEXT,
        sync_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (installation_id, bitrix_user_id),
        FOREIGN KEY (installation_id) REFERENCES bitrix_installations(id)
      );

      CREATE TABLE IF NOT EXISTS connection_provider_calendars (
        connection_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        color TEXT,
        resource_url TEXT,
        payload_json TEXT,
        PRIMARY KEY (connection_id, provider, external_id),
        FOREIGN KEY (connection_id) REFERENCES user_connections(id)
      );

      CREATE TABLE IF NOT EXISTS connection_sync_state (
        connection_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',
        last_run_at TEXT,
        last_success_at TEXT,
        last_error_at TEXT,
        last_error_message TEXT,
        last_webhook_at TEXT,
        last_poll_at TEXT,
        active_direction TEXT,
        bitrix_sync_cursor TEXT,
        yandex_sync_cursor TEXT,
        polling_failure_count INTEGER NOT NULL DEFAULT 0,
        last_processed_bitrix_events INTEGER NOT NULL DEFAULT 0,
        last_processed_yandex_events INTEGER NOT NULL DEFAULT 0,
        last_skipped_recurring_events INTEGER NOT NULL DEFAULT 0,
        last_outcome_reason TEXT,
        FOREIGN KEY (connection_id) REFERENCES user_connections(id)
      );

      CREATE TABLE IF NOT EXISTS connection_event_mappings (
        connection_id TEXT NOT NULL,
        bitrix_event_id TEXT,
        yandex_event_url TEXT,
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
        deleted_by TEXT,
        FOREIGN KEY (connection_id) REFERENCES user_connections(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS connection_event_mappings_bitrix_idx
      ON connection_event_mappings (connection_id, bitrix_event_id)
      WHERE bitrix_event_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS connection_event_mappings_yandex_idx
      ON connection_event_mappings (connection_id, yandex_event_url)
      WHERE yandex_event_url IS NOT NULL;
    `);

    this.ensureConnectionSyncStateColumns();
  }

  private ensureConnectionSyncStateColumns(): void {
    const columns = this.database.prepare<[], { name: string }>('PRAGMA table_info(connection_sync_state)').all().map((column) => column.name);

    if (!columns.includes('bitrix_sync_cursor')) {
      this.database.exec('ALTER TABLE connection_sync_state ADD COLUMN bitrix_sync_cursor TEXT');
    }
  }

  private ensureScopedSyncState(connectionId: string): void {
    this.database.prepare(
      `INSERT OR IGNORE INTO connection_sync_state (
         connection_id, status, polling_failure_count, last_processed_bitrix_events,
         last_processed_yandex_events, last_skipped_recurring_events
       ) VALUES (?, 'idle', 0, 0, 0, 0)`,
    ).run(connectionId);
  }

  private mapInstallationRow(row: InstallationRow): BitrixInstallation {
    return {
      id: row.id,
      portalHost: row.portal_host,
      memberId: row.member_id,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      scope: row.scope,
      applicationToken: row.application_token,
      status: row.status,
      lastErrorMessage: row.last_error_message,
      installedByUserId: row.installed_by_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapConnectionRow(row: ConnectionRow): ConnectionSettings {
    return {
      id: row.id,
      installationId: row.installation_id,
      onboardingToken: row.onboarding_token,
      bitrixUserId: row.bitrix_user_id,
      bitrixUserName: row.bitrix_user_name,
      bitrixCalendarId: normalizeNullableString(row.bitrix_calendar_id),
      yandexBaseUrl: normalizeNullableString(row.yandex_base_url) || DEFAULT_YANDEX_CALDAV_BASE_URL,
      yandexUsername: normalizeNullableString(row.yandex_username),
      yandexPassword: normalizeNullableString(row.yandex_password),
      yandexCalendarUrl: normalizeNullableString(row.yandex_calendar_url),
      syncEnabled: Boolean(row.sync_enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapMappingRow(row: MappingRow): EventMappingRecord {
    return {
      connectionId: row.connection_id,
      bitrixEventId: row.bitrix_event_id,
      yandexEventUrl: row.yandex_event_url,
      yandexEventEtag: row.yandex_event_etag,
      yandexEventUid: row.yandex_event_uid,
      sourceFingerprint: row.source_fingerprint,
      targetFingerprint: row.target_fingerprint,
      bitrixUpdatedAt: row.bitrix_updated_at,
      yandexUpdatedAt: row.yandex_updated_at,
      lastWinner: row.last_winner,
      lastDecisionReason: row.last_decision_reason,
      status: row.status,
      lastSyncedAt: row.last_synced_at,
      deletedAt: row.deleted_at,
      deletedBy: row.deleted_by,
    };
  }
}
