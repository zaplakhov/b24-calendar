/*
Module: sync.service
Role: Orchestrates Bitrix-to-Yandex syncing, Yandex polling, status updates, and mapping-based idempotency for the MVP.
Source of Truth: backend/src/services/sync.service.ts

Uses:
  ./sqlite.service.ts:SQLiteService: true
  ./bitrix.service.ts:BitrixService: true
  ./yandex-caldav.service.ts:YandexCalDavService: true
  ../utils/transformer.ts: true
  ../utils/conflict-resolver.ts:resolveConflict: true

Used by:
  ../routes/settings.routes.ts:createSettingsRouter: true
  ../routes/sync.routes.ts:createSyncRouter: true
  ../handlers/webhook.handler.ts:createBitrixWebhookHandler: true
  ../index.ts:createApp: true

Glossary: none
*/

import { resolveConflict } from '../utils/conflict-resolver';
import {
  buildBitrixEventFingerprint,
  buildYandexEventFingerprint,
  shouldSkipRecurrence,
  transformBitrixEventToYandexDraft,
  transformYandexEventToBitrixDraft,
  type BitrixCalendarEvent,
  type YandexCalendarEvent,
} from '../utils/transformer';
import { BitrixService } from './bitrix.service';
import {
  SQLiteService,
  type AppSettings,
  type SyncState,
} from './sqlite.service';
import { YandexCalDavService } from './yandex-caldav.service';

export interface SyncStatusResponse {
  configured: boolean;
  mappingsCount: number;
  deletedMappingsCount: number;
  settingsReady: {
    bitrix: boolean;
    yandex: boolean;
    syncEnabled: boolean;
  };
  state: SyncState;
  manualResync: ManualResyncPreflight;
  reviewerEvidence: {
    lastSyncAt: string | null;
    lastError: string | null;
    lastRun: {
      processedBitrixEvents: number;
      processedYandexEvents: number;
      skippedRecurringEvents: number;
      outcomeReason: string | null;
    };
    statusHint: 'ready' | 'disabled' | 'not_configured';
    manualResync: ManualResyncPreflight;
  };
}

export interface ManualResyncPreflight {
  allowed: boolean;
  message: string;
  reason: 'ready' | 'disabled' | 'not_configured';
}

export interface ManualSyncResult {
  ok: boolean;
  message: string;
  noop: boolean;
  processedBitrixEvents: number;
  processedYandexEvents: number;
  skippedRecurringEvents: number;
  preflight: ManualResyncPreflight;
  status: SyncStatusResponse;
}

export interface PollingSchedule {
  maxDelayMs: number;
  minDelayMs: number;
}

interface WebhookDescriptor {
  action: 'delete' | 'upsert';
  eventId: string | null;
}

type SyncExecutionPath = 'bitrix_webhook' | 'manual_resync' | 'yandex_poll';

export class SyncService {
  private pollingTimer: NodeJS.Timeout | null = null;
  private pollingInFlight = false;

  public constructor(
    private readonly sqliteService: SQLiteService,
    private readonly bitrixService: BitrixService,
    private readonly yandexService: YandexCalDavService,
  ) {}

  public startPollingLoop(schedule: PollingSchedule = { minDelayMs: 10 * 60 * 1000, maxDelayMs: 15 * 60 * 1000 }): void {
    if (this.pollingTimer) {
      return;
    }

    const run = async (): Promise<void> => {
      this.pollingTimer = null;

      if (this.pollingInFlight) {
        this.scheduleNextPoll(schedule);
        return;
      }

      const settings = this.sqliteService.getSettings();
      const preflight = this.getExecutionPreflight('yandex_poll', settings);
      if (!preflight.allowed) {
        this.applyNoopPreflight('yandex_poll', preflight);
        this.scheduleNextPoll(schedule);
        return;
      }

      this.pollingInFlight = true;

      try {
        await this.runYandexPolling();
      } catch {
        // Error is already persisted into sync state by runYandexPolling.
      } finally {
        this.pollingInFlight = false;
        this.scheduleNextPoll(schedule);
      }
    };

    this.scheduleNextPoll(schedule, run);
  }

  public getStatus(): SyncStatusResponse {
    const settings = this.sqliteService.getSettings();
    const state = this.sqliteService.getSyncState();
    const mappings = this.sqliteService.listEventMappings();
    const mappingsCount = mappings.filter((item) => item.status !== 'deleted').length;
    const deletedMappingsCount = mappings.length - mappingsCount;
    const statusHint = this.getStatusHint(settings);
    const configured = statusHint === 'ready';
    const manualResync = this.getManualResyncPreflight(settings);

    return {
      configured,
      mappingsCount,
      deletedMappingsCount,
      settingsReady: {
        bitrix: Boolean(settings.bitrixWebhookUrl),
        yandex: Boolean(settings.yandexBaseUrl && settings.yandexUsername && settings.yandexPassword),
        syncEnabled: settings.syncEnabled,
      },
      state,
      manualResync,
      reviewerEvidence: {
        lastSyncAt: state.lastSuccessAt,
        lastError: state.lastErrorMessage,
        lastRun: {
          processedBitrixEvents: state.lastProcessedBitrixEvents,
          processedYandexEvents: state.lastProcessedYandexEvents,
          skippedRecurringEvents: state.lastSkippedRecurringEvents,
          outcomeReason: state.lastOutcomeReason,
        },
        statusHint,
        manualResync,
      },
    };
  }

  public async runManualResync(): Promise<ManualSyncResult> {
    const preflight = this.getExecutionPreflight('manual_resync');
    if (!preflight.allowed) {
      const status = this.applyNoopPreflight('manual_resync', preflight);
      return {
        ok: true,
        message: preflight.message,
        noop: true,
        preflight,
        processedBitrixEvents: 0,
        processedYandexEvents: 0,
        skippedRecurringEvents: 0,
        status,
      };
    }

    const startedAt = new Date().toISOString();
    this.sqliteService.updateSyncState({
      activeDirection: 'full',
      lastErrorMessage: null,
      lastRunAt: startedAt,
      status: 'running',
    });

    try {
      const bitrixEvents = await this.bitrixService.listEventsSince(null);
      let skippedRecurringEvents = 0;

      for (const event of bitrixEvents) {
        const skipped = await this.syncBitrixEvent(event);
        skippedRecurringEvents += skipped ? 1 : 0;
      }

      const yandexResult = await this.runYandexPollingInternal();

      this.sqliteService.updateSyncState({
        activeDirection: null,
        lastOutcomeReason: 'manual_resync_completed',
        lastProcessedBitrixEvents: bitrixEvents.length,
        lastProcessedYandexEvents: yandexResult.processedEvents,
        lastSkippedRecurringEvents: skippedRecurringEvents + yandexResult.skippedRecurringEvents,
        pollingFailureCount: 0,
        lastSuccessAt: new Date().toISOString(),
        status: 'success',
      });

      return {
        ok: true,
        message: 'Manual resync completed.',
        noop: false,
        preflight,
        processedBitrixEvents: bitrixEvents.length,
        processedYandexEvents: yandexResult.processedEvents,
        skippedRecurringEvents: skippedRecurringEvents + yandexResult.skippedRecurringEvents,
        status: this.getStatus(),
      };
    } catch (error: unknown) {
      this.captureSyncError(error);
      throw error;
    }
  }

  public async runYandexPolling(): Promise<ManualSyncResult> {
    const preflight = this.getExecutionPreflight('yandex_poll');
    if (!preflight.allowed) {
      const status = this.applyNoopPreflight('yandex_poll', preflight);

      return {
        ok: true,
        message: preflight.message,
        noop: true,
        preflight,
        processedBitrixEvents: 0,
        processedYandexEvents: 0,
        skippedRecurringEvents: 0,
        status,
      };
    }

    const startedAt = new Date().toISOString();
    this.sqliteService.updateSyncState({
      activeDirection: 'yandex_poll',
      lastErrorMessage: null,
      lastPollAt: startedAt,
      lastRunAt: startedAt,
      status: 'running',
    });

    try {
      const result = await this.runYandexPollingInternal();

      this.sqliteService.updateSyncState({
        activeDirection: null,
        lastOutcomeReason: 'yandex_poll_completed',
        lastProcessedBitrixEvents: 0,
        lastProcessedYandexEvents: result.processedEvents,
        lastSkippedRecurringEvents: result.skippedRecurringEvents,
        pollingFailureCount: 0,
        lastSuccessAt: new Date().toISOString(),
        status: 'success',
      });

      return {
        ok: true,
        message: 'Yandex polling completed.',
        noop: false,
        preflight,
        processedBitrixEvents: 0,
        processedYandexEvents: result.processedEvents,
        skippedRecurringEvents: result.skippedRecurringEvents,
        status: this.getStatus(),
      };
    } catch (error: unknown) {
      this.captureSyncError(error);
      throw error;
    }
  }

  public async handleBitrixWebhook(payload: Record<string, unknown>): Promise<SyncStatusResponse> {
    const descriptor = this.describeWebhookPayload(payload);
    const preflight = this.getExecutionPreflight('bitrix_webhook');
    if (!preflight.allowed) {
      return this.applyNoopPreflight('bitrix_webhook', preflight);
    }

    this.sqliteService.updateSyncState({
      lastWebhookAt: new Date().toISOString(),
      lastErrorMessage: null,
      status: 'running',
      activeDirection: 'bitrix_webhook',
    });

    try {
      if (!descriptor.eventId) {
        this.sqliteService.updateSyncState({
          activeDirection: null,
          lastOutcomeReason: 'bitrix_webhook_without_event_id',
          lastProcessedBitrixEvents: 0,
          lastProcessedYandexEvents: 0,
          lastSkippedRecurringEvents: 0,
          status: 'success',
        });

        return this.getStatus();
      }

      if (descriptor.action === 'delete') {
        await this.handleBitrixDeletion(descriptor.eventId);
      } else {
        const event = await this.bitrixService.fetchEventById(descriptor.eventId);

        if (event) {
          await this.syncBitrixEvent(event);
        }
      }

      this.sqliteService.updateSyncState({
        activeDirection: null,
        lastOutcomeReason: descriptor.action === 'delete' ? 'bitrix_webhook_delete_processed' : 'bitrix_webhook_upsert_processed',
        lastProcessedBitrixEvents: 1,
        lastProcessedYandexEvents: 0,
        lastSuccessAt: new Date().toISOString(),
        status: 'success',
      });

      return this.getStatus();
    } catch (error: unknown) {
      this.captureSyncError(error);
      throw error;
    }
  }

  private async runYandexPollingInternal(): Promise<{ processedEvents: number; skippedRecurringEvents: number }> {
    const events = await this.yandexService.listEvents();
    const currentUrls = new Set(events.map((event) => event.url));
    const cursor = await this.yandexService.getSelectedCalendarCursor();
    let skippedRecurringEvents = 0;

    for (const event of events) {
      const skipped = await this.syncYandexEvent(event);
      skippedRecurringEvents += skipped ? 1 : 0;
    }

    const mappings = this.sqliteService.listEventMappings();
    for (const mapping of mappings) {
      if (!mapping.yandexEventUrl || currentUrls.has(mapping.yandexEventUrl)) {
        continue;
      }

      if (mapping.status === 'deleted') continue;

      if (mapping.bitrixEventId) {
        await this.bitrixService.deleteEvent(mapping.bitrixEventId);
      }

      this.sqliteService.upsertEventMapping({
        ...mapping,
        deletedAt: new Date().toISOString(),
        deletedBy: 'yandex',
        lastDecisionReason: 'yandex_missing_during_poll',
        lastSyncedAt: new Date().toISOString(),
        lastWinner: 'yandex',
        status: 'deleted',
      });
    }

    this.sqliteService.updateSyncState({
      lastPollAt: new Date().toISOString(),
      yandexSyncCursor: cursor,
    });

    return {
      processedEvents: events.length,
      skippedRecurringEvents,
    };
  }

  private async syncBitrixEvent(event: BitrixCalendarEvent): Promise<boolean> {
    if (shouldSkipRecurrence(event)) {
      this.noteRecurringSkip(`Skipped Bitrix event ${event.id}: recurring events are unsupported in MVP.`);
      return true;
    }

    const mapping = this.sqliteService.getEventMappingByBitrixId(event.id);
    const fingerprint = buildBitrixEventFingerprint(event);
    const decision = resolveConflict({
      sourceProvider: 'bitrix',
      mapping,
      sourceDeleted: event.deleted,
      sourceFingerprint: fingerprint,
      sourceUpdatedAt: event.updatedAt,
      sourceVersion: event.id,
      targetPresent: Boolean(mapping?.yandexEventUrl),
    });

    this.sqliteService.updateSyncState({ lastOutcomeReason: decision.reason });

    if (decision.action === 'skip') {
      return false;
    }

    if (decision.action === 'delete') {
      await this.handleBitrixDeletion(event.id);
      return false;
    }

    const draft = transformBitrixEventToYandexDraft(event);
    const syncedEvent = decision.action === 'create' || !mapping?.yandexEventUrl
      ? await this.yandexService.createEvent(draft)
      : await this.yandexService.updateEvent(mapping.yandexEventUrl, draft);

    this.sqliteService.upsertEventMapping({
      bitrixEventId: event.id,
      bitrixUpdatedAt: event.updatedAt,
      deletedAt: null,
      deletedBy: null,
      lastDecisionReason: decision.reason,
      lastSyncedAt: new Date().toISOString(),
      lastWinner: 'bitrix',
      sourceFingerprint: fingerprint,
      status: 'synced',
      targetFingerprint: buildYandexEventFingerprint(syncedEvent),
      yandexUpdatedAt: syncedEvent.updatedAt,
      yandexEventEtag: syncedEvent.etag,
      yandexEventUid: syncedEvent.uid,
      yandexEventUrl: syncedEvent.url,
    });

    return false;
  }

  private async syncYandexEvent(event: YandexCalendarEvent): Promise<boolean> {
    if (shouldSkipRecurrence(event)) {
      this.noteRecurringSkip(`Skipped Yandex event ${event.uid}: recurring events are unsupported in MVP.`);
      return true;
    }

    const mapping = this.sqliteService.getEventMappingByYandexUrl(event.url);
    const fingerprint = buildYandexEventFingerprint(event);
    const decision = resolveConflict({
      sourceProvider: 'yandex',
      mapping,
      sourceDeleted: false,
      sourceFingerprint: fingerprint,
      sourceUpdatedAt: event.updatedAt,
      sourceVersion: event.etag ?? event.uid ?? event.url,
      targetPresent: Boolean(mapping?.bitrixEventId),
    });

    this.sqliteService.updateSyncState({ lastOutcomeReason: decision.reason });
    if (decision.action === 'skip') return false;

    const draft = transformYandexEventToBitrixDraft(event);
    const syncedEvent = decision.action === 'update' && mapping?.bitrixEventId
      ? await this.bitrixService.updateEvent(mapping.bitrixEventId, draft)
      : await this.bitrixService.createEvent(draft);

    this.sqliteService.upsertEventMapping({
      bitrixEventId: syncedEvent.id,
      bitrixUpdatedAt: syncedEvent.updatedAt,
      deletedAt: null,
      deletedBy: null,
      lastDecisionReason: decision.reason,
      lastSyncedAt: new Date().toISOString(),
      lastWinner: 'yandex',
      sourceFingerprint: buildBitrixEventFingerprint(syncedEvent),
      status: 'synced',
      targetFingerprint: fingerprint,
      yandexUpdatedAt: event.updatedAt,
      yandexEventEtag: event.etag,
      yandexEventUid: event.uid,
      yandexEventUrl: event.url,
    });

    return false;
  }

  private async handleBitrixDeletion(eventId: string): Promise<void> {
    const mapping = this.sqliteService.getEventMappingByBitrixId(eventId);
    const deletedAt = new Date().toISOString();

    if (mapping?.yandexEventUrl) {
      await this.yandexService.deleteEvent(mapping.yandexEventUrl);
    }

    this.sqliteService.upsertEventMapping({
      bitrixEventId: eventId,
      bitrixUpdatedAt: deletedAt,
      deletedAt,
      deletedBy: 'bitrix',
      lastDecisionReason: 'source_deleted',
      lastSyncedAt: deletedAt,
      lastWinner: 'bitrix',
      sourceFingerprint: mapping?.sourceFingerprint ?? null,
      status: 'deleted',
      targetFingerprint: mapping?.targetFingerprint ?? null,
      yandexUpdatedAt: mapping?.yandexUpdatedAt ?? null,
      yandexEventEtag: mapping?.yandexEventEtag ?? null,
      yandexEventUid: mapping?.yandexEventUid ?? null,
      yandexEventUrl: mapping?.yandexEventUrl ?? null,
    });
  }

  private describeWebhookPayload(payload: Record<string, unknown>): WebhookDescriptor {
    const eventName = String(payload.event ?? payload.eventName ?? '').toLowerCase();
    const data = typeof payload.data === 'object' && payload.data ? (payload.data as Record<string, unknown>) : {};
    const fields = typeof data.FIELDS === 'object' && data.FIELDS ? (data.FIELDS as Record<string, unknown>) : {};
    const eventId = fields.ID
      ? String(fields.ID)
      : data.id
        ? String(data.id)
        : payload.id
          ? String(payload.id)
          : null;

    const action = eventName.includes('delete') ? 'delete' : 'upsert';

    return {
      action,
      eventId,
    };
  }

  private isConfigured(settings: AppSettings): boolean {
    return Boolean(
      settings.bitrixWebhookUrl
        && settings.yandexBaseUrl
        && settings.yandexUsername
        && settings.yandexPassword,
    );
  }

  private getStatusHint(settings: AppSettings): 'ready' | 'disabled' | 'not_configured' {
    if (!settings.syncEnabled) {
      return 'disabled';
    }

    return this.isConfigured(settings) ? 'ready' : 'not_configured';
  }

  private getExecutionPreflight(
    path: SyncExecutionPath,
    settings = this.sqliteService.getSettings(),
  ): ManualResyncPreflight {
    const reason = this.getStatusHint(settings);

    if (reason === 'ready') {
      return {
        allowed: true,
        message: this.getReadyMessage(path),
        reason,
      };
    }

    return {
      allowed: false,
      message: this.getBlockedMessage(path, reason),
      reason,
    };
  }

  private getManualResyncPreflight(settings = this.sqliteService.getSettings()): ManualResyncPreflight {
    return this.getExecutionPreflight('manual_resync', settings);
  }

  private applyNoopPreflight(path: SyncExecutionPath, preflight: ManualResyncPreflight): SyncStatusResponse {
    const attemptedAt = new Date().toISOString();
    const currentState = this.sqliteService.getSyncState();

    this.sqliteService.updateSyncState({
      activeDirection: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      lastOutcomeReason: `${path}_${preflight.reason}_noop`,
      lastPollAt: path === 'yandex_poll' ? attemptedAt : currentState.lastPollAt,
      lastProcessedBitrixEvents: 0,
      lastProcessedYandexEvents: 0,
      lastRunAt: path === 'manual_resync' || path === 'yandex_poll' ? attemptedAt : currentState.lastRunAt,
      lastSkippedRecurringEvents: 0,
      lastWebhookAt: path === 'bitrix_webhook' ? attemptedAt : currentState.lastWebhookAt,
      status: preflight.reason === 'disabled' ? 'disabled' : 'idle',
    });

    return this.getStatus();
  }

  private getReadyMessage(path: SyncExecutionPath): string {
    switch (path) {
      case 'bitrix_webhook':
        return 'Bitrix webhook processing is ready to run.';
      case 'yandex_poll':
        return 'Yandex polling is ready to run.';
      case 'manual_resync':
      default:
        return 'Manual resync is ready to run.';
    }
  }

  private getBlockedMessage(
    path: SyncExecutionPath,
    reason: ManualResyncPreflight['reason'],
  ): string {
    if (path === 'bitrix_webhook') {
      return reason === 'disabled'
        ? 'Bitrix webhook was ignored because sync is disabled.'
        : 'Bitrix webhook was ignored because sync is not fully configured.';
    }

    if (path === 'yandex_poll') {
      return reason === 'disabled'
        ? 'Yandex polling skipped because sync is disabled.'
        : 'Yandex polling skipped because Bitrix webhook and Yandex credentials are not fully configured.';
    }

    return reason === 'disabled'
      ? 'Manual resync is unavailable while sync is disabled.'
      : 'Manual resync is unavailable until Bitrix webhook and Yandex credentials are configured.';
  }

  private captureSyncError(error: unknown): void {
    const currentState = this.sqliteService.getSyncState();
    this.sqliteService.updateSyncState({
      activeDirection: null,
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: error instanceof Error ? error.message : 'Unknown sync error.',
      lastOutcomeReason: 'sync_failed',
      pollingFailureCount: currentState.pollingFailureCount + 1,
      status: 'error',
    });
  }

  private noteRecurringSkip(message: string): void {
    const currentState = this.sqliteService.getSyncState();
    this.sqliteService.updateSyncState({
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: message,
      lastOutcomeReason: 'recurring_event_skipped',
      lastSkippedRecurringEvents: currentState.lastSkippedRecurringEvents + 1,
      status: 'success',
    });
  }

  private scheduleNextPoll(schedule: PollingSchedule, callback?: () => Promise<void>): void {
    const nextRun = callback ?? (() => Promise.resolve());
    const delay = this.computeNextDelay(schedule);
    this.pollingTimer = setTimeout(() => {
      void nextRun();
    }, delay);
  }

  private computeNextDelay(schedule: PollingSchedule): number {
    const { pollingFailureCount } = this.sqliteService.getSyncState();
    const minDelay = Math.max(1, schedule.minDelayMs);
    const maxDelay = Math.max(minDelay, schedule.maxDelayMs);
    const jitterDelay = Math.round(minDelay + Math.random() * (maxDelay - minDelay));
    const cappedBackoffMultiplier = Math.min(4, Math.max(1, 2 ** pollingFailureCount));

    return jitterDelay * cappedBackoffMultiplier;
  }
}
