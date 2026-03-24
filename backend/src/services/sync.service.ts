/*
Module: sync.service
Role: Runs scoped incremental sync for Bitrix24 and Yandex with polling, manual sync-now, and optional webhook acceleration.
Source of Truth: backend/src/services/sync.service.ts

Uses:
  ./sqlite.service.ts:SQLiteService: true
  ./bitrix.service.ts:BitrixService: true
  ./yandex-caldav.service.ts:YandexCalDavService: true
  ../utils/conflict-resolver.ts:resolveConflict: true
  ../utils/transformer.ts: true

Used by:
  ../routes/onboarding.routes.ts:createOnboardingRouter: true
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
import { SQLiteService, type ConnectionSettings, type SyncState } from './sqlite.service';
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

type SyncExecutionPath = 'bitrix_webhook' | 'manual_sync' | 'scheduled_poll' | 'startup_initial' | 'settings_enabled';

interface SyncExecutionStats {
  processedBitrixEvents: number;
  processedYandexEvents: number;
  skippedRecurringEvents: number;
  outcomeReason: string;
}

export class SyncService {
  private pollingTimer: NodeJS.Timeout | null = null;
  private schedulerInFlight = false;
  private readonly connectionInFlight = new Set<string>();

  public constructor(
    private readonly sqliteService: SQLiteService,
    private readonly bitrixService: BitrixService,
    private readonly yandexService: YandexCalDavService,
  ) {}

  public startPollingLoop(schedule: PollingSchedule = { minDelayMs: 5 * 60 * 1000, maxDelayMs: 5 * 60 * 1000 }): void {
    if (this.pollingTimer) {
      return;
    }

    this.log('Starting polling loop.', {
      maxDelayMs: schedule.maxDelayMs,
      minDelayMs: schedule.minDelayMs,
    });

    void this.runSchedulerIteration('startup_initial').finally(() => {
      this.scheduleNextPoll(schedule);
    });
  }

  public getStatus(connectionId: string): SyncStatusResponse {
    const context = this.sqliteService.getConnectionContext(connectionId);
    if (!context) {
      throw new Error(`Connection ${connectionId} was not found.`);
    }

    const installationReady = this.isInstallationReady(context.connection.id);
    const state = this.sqliteService.getSyncState(connectionId);
    const mappings = this.sqliteService.listEventMappings(connectionId);
    const mappingsCount = mappings.filter((item) => item.status !== 'deleted').length;
    const deletedMappingsCount = mappings.length - mappingsCount;
    const statusHint = this.getStatusHint(context.connection, installationReady);
    const configured = statusHint === 'ready';
    const manualResync = this.getManualResyncPreflight(context.connection, installationReady);

    return {
      configured,
      mappingsCount,
      deletedMappingsCount,
      settingsReady: {
        bitrix: installationReady,
        yandex: Boolean(context.connection.yandexBaseUrl && context.connection.yandexUsername && context.connection.yandexPassword),
        syncEnabled: context.connection.syncEnabled,
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

  public async runManualResync(connectionId: string): Promise<ManualSyncResult> {
    return this.runManualSyncNow(connectionId);
  }

  public async runManualSyncNow(connectionId: string): Promise<ManualSyncResult> {
    const context = this.requireContext(connectionId);
    const preflight = this.getExecutionPreflight('manual_sync', context.connection, context.installationReady);
    if (!preflight.allowed) {
      const status = this.applyNoopPreflight(connectionId, 'manual_sync', preflight);
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

    const stats = await this.runSyncCycle(connectionId, 'manual_sync');
    return {
      ok: true,
      message: 'Manual sync completed.',
      noop: false,
      preflight,
      processedBitrixEvents: stats.processedBitrixEvents,
      processedYandexEvents: stats.processedYandexEvents,
      skippedRecurringEvents: stats.skippedRecurringEvents,
      status: this.getStatus(connectionId),
    };
  }

  public requestImmediateSync(connectionId: string, trigger: 'settings_enabled' | 'startup_initial' = 'settings_enabled'): void {
    void this.runSyncCycle(connectionId, trigger).catch((error: unknown) => {
      this.log('Immediate sync request failed.', {
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
        trigger,
      });
    });
  }

  public async handleBitrixWebhook(connectionId: string, payload: Record<string, unknown>): Promise<SyncStatusResponse> {
    const context = this.requireContext(connectionId);
    const descriptor = this.describeWebhookPayload(payload);
    const preflight = this.getExecutionPreflight('bitrix_webhook', context.connection, context.installationReady);
    if (!preflight.allowed) {
      return this.applyNoopPreflight(connectionId, 'bitrix_webhook', preflight);
    }

    this.sqliteService.updateSyncState(connectionId, {
      lastWebhookAt: new Date().toISOString(),
    });

    if (!descriptor.eventId) {
      this.sqliteService.updateSyncState(connectionId, {
        lastOutcomeReason: 'bitrix_webhook_without_event_id',
      });
      return this.getStatus(connectionId);
    }

    await this.runSyncCycle(connectionId, 'bitrix_webhook', payload);
    return this.getStatus(connectionId);
  }

  private async runSchedulerIteration(trigger: 'startup_initial' | 'scheduled_poll'): Promise<void> {
    if (this.schedulerInFlight) {
      this.log('Scheduler iteration skipped because a previous iteration is still running.');
      return;
    }

    this.schedulerInFlight = true;

    try {
      const activeConnections = this.sqliteService.listActiveConnections();
      this.log('Scheduler iteration started.', {
        activeConnections: activeConnections.length,
        trigger,
      });

      for (const item of activeConnections) {
        try {
          await this.runSyncCycle(item.connection.id, trigger);
        } catch (error: unknown) {
          this.log('Scheduled sync failed for connection.', {
            connectionId: item.connection.id,
            error: error instanceof Error ? error.message : 'Unknown error',
            trigger,
          });
        }
      }

      this.log('Scheduler iteration finished.', {
        activeConnections: activeConnections.length,
        trigger,
      });
    } finally {
      this.schedulerInFlight = false;
    }
  }

  private async runSyncCycle(connectionId: string, trigger: SyncExecutionPath, webhookPayload?: Record<string, unknown>): Promise<SyncExecutionStats> {
    if (this.connectionInFlight.has(connectionId)) {
      this.log('Skipping sync because connection is already in flight.', {
        connectionId,
        trigger,
      });
      return {
        processedBitrixEvents: 0,
        processedYandexEvents: 0,
        skippedRecurringEvents: 0,
        outcomeReason: `${trigger}_already_running`,
      };
    }

    const context = this.requireContext(connectionId);
    const preflight = this.getExecutionPreflight(trigger, context.connection, context.installationReady);
    if (!preflight.allowed) {
      this.applyNoopPreflight(connectionId, trigger, preflight);
      return {
        processedBitrixEvents: 0,
        processedYandexEvents: 0,
        skippedRecurringEvents: 0,
        outcomeReason: `${trigger}_${preflight.reason}_noop`,
      };
    }

    const previousState = this.sqliteService.getSyncState(connectionId);
    const startedAt = new Date().toISOString();
    this.connectionInFlight.add(connectionId);
    this.sqliteService.updateSyncState(connectionId, {
      activeDirection: trigger,
      lastErrorAt: null,
      lastErrorMessage: null,
      lastRunAt: startedAt,
      lastPollAt: trigger === 'bitrix_webhook' ? previousState.lastPollAt : startedAt,
      status: 'running',
    });

    this.log('Connection sync started.', {
      bitrixCursor: previousState.bitrixSyncCursor,
      connectionId,
      trigger,
      yandexCursor: previousState.yandexSyncCursor,
    });

    try {
      const stats = webhookPayload
        ? await this.runWebhookAcceleratedSync(connectionId, webhookPayload, previousState)
        : await this.runIncrementalSync(connectionId, previousState, startedAt);

      this.sqliteService.updateSyncState(connectionId, {
        activeDirection: null,
        bitrixSyncCursor: startedAt,
        lastOutcomeReason: stats.outcomeReason,
        lastProcessedBitrixEvents: stats.processedBitrixEvents,
        lastProcessedYandexEvents: stats.processedYandexEvents,
        lastSkippedRecurringEvents: stats.skippedRecurringEvents,
        lastSuccessAt: new Date().toISOString(),
        pollingFailureCount: 0,
        status: 'success',
        yandexSyncCursor: startedAt,
      });

      this.log('Connection sync completed.', {
        connectionId,
        processedBitrixEvents: stats.processedBitrixEvents,
        processedYandexEvents: stats.processedYandexEvents,
        skippedRecurringEvents: stats.skippedRecurringEvents,
        trigger,
      });

      return stats;
    } catch (error: unknown) {
      this.captureSyncError(connectionId, error);
      this.log('Connection sync failed.', {
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
        trigger,
      });
      throw error;
    } finally {
      this.connectionInFlight.delete(connectionId);
    }
  }

  private async runIncrementalSync(connectionId: string, previousState: SyncState, startedAt: string): Promise<SyncExecutionStats> {
    const bitrixEvents = await this.bitrixService.listEventsSince(connectionId, previousState.bitrixSyncCursor);
    let skippedRecurringEvents = 0;

    for (const event of bitrixEvents) {
      const skipped = await this.syncBitrixEvent(connectionId, event);
      skippedRecurringEvents += skipped ? 1 : 0;
    }

    const yandexResult = await this.runYandexIncrementalInternal(connectionId, previousState, startedAt);

    return {
      processedBitrixEvents: bitrixEvents.length,
      processedYandexEvents: yandexResult.processedEvents,
      skippedRecurringEvents: skippedRecurringEvents + yandexResult.skippedRecurringEvents,
      outcomeReason: 'incremental_sync_completed',
    };
  }

  private async runWebhookAcceleratedSync(connectionId: string, payload: Record<string, unknown>, previousState: SyncState): Promise<SyncExecutionStats> {
    const descriptor = this.describeWebhookPayload(payload);
    let skippedRecurringEvents = 0;
    let processedBitrixEvents = 0;

    if (descriptor.eventId) {
      if (descriptor.action === 'delete') {
        await this.handleBitrixDeletion(connectionId, descriptor.eventId);
        processedBitrixEvents = 1;
      } else {
        const event = await this.bitrixService.fetchEventById(connectionId, descriptor.eventId);
        if (event) {
          processedBitrixEvents = 1;
          const skipped = await this.syncBitrixEvent(connectionId, event);
          skippedRecurringEvents += skipped ? 1 : 0;
        }
      }
    }

    const yandexResult = await this.runYandexIncrementalInternal(connectionId, previousState, new Date().toISOString());

    return {
      processedBitrixEvents,
      processedYandexEvents: yandexResult.processedEvents,
      skippedRecurringEvents: skippedRecurringEvents + yandexResult.skippedRecurringEvents,
      outcomeReason: descriptor.action === 'delete' ? 'bitrix_webhook_delete_processed' : 'bitrix_webhook_upsert_processed',
    };
  }

  private async runYandexIncrementalInternal(connectionId: string, previousState: SyncState, startedAt: string): Promise<{ processedEvents: number; skippedRecurringEvents: number }> {
    const events = await this.yandexService.listEvents(connectionId);
    const currentUrls = new Set(events.map((event) => event.url));
    let processedEvents = 0;
    let skippedRecurringEvents = 0;

    for (const event of events) {
      if (!this.shouldProcessYandexEvent(connectionId, event, previousState.yandexSyncCursor)) {
        continue;
      }

      processedEvents += 1;
      const skipped = await this.syncYandexEvent(connectionId, event);
      skippedRecurringEvents += skipped ? 1 : 0;
    }

    const mappings = this.sqliteService.listEventMappings(connectionId);
    for (const mapping of mappings) {
      if (!mapping.yandexEventUrl || currentUrls.has(mapping.yandexEventUrl) || mapping.status === 'deleted') {
        continue;
      }

      if (mapping.bitrixEventId) {
        await this.bitrixService.deleteEvent(connectionId, mapping.bitrixEventId);
      }

      this.sqliteService.upsertEventMapping({
        ...mapping,
        deletedAt: startedAt,
        deletedBy: 'yandex',
        lastDecisionReason: 'yandex_missing_during_poll',
        lastSyncedAt: startedAt,
        lastWinner: 'yandex',
        status: 'deleted',
      });
    }

    return {
      processedEvents,
      skippedRecurringEvents,
    };
  }

  private shouldProcessYandexEvent(connectionId: string, event: YandexCalendarEvent, cursor: string | null): boolean {
    const mapping = this.sqliteService.getEventMappingByYandexUrl(connectionId, event.url);
    if (!mapping) {
      return true;
    }

    const fingerprint = buildYandexEventFingerprint(event);
    if (mapping.targetFingerprint !== fingerprint || mapping.status === 'deleted') {
      return true;
    }

    if (!cursor || !event.updatedAt) {
      return false;
    }

    const updatedAtMs = Date.parse(event.updatedAt);
    const cursorMs = Date.parse(cursor);
    return !Number.isNaN(updatedAtMs) && !Number.isNaN(cursorMs) && updatedAtMs > cursorMs;
  }

  private async syncBitrixEvent(connectionId: string, event: BitrixCalendarEvent): Promise<boolean> {
    if (shouldSkipRecurrence(event)) {
      this.noteRecurringSkip(connectionId, `Skipped Bitrix event ${event.id}: recurring events are unsupported in MVP.`);
      return true;
    }

    const mapping = this.sqliteService.getEventMappingByBitrixId(connectionId, event.id);
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

    this.sqliteService.updateSyncState(connectionId, { lastOutcomeReason: decision.reason });
    if (decision.action === 'skip') {
      return false;
    }

    if (decision.action === 'delete') {
      await this.handleBitrixDeletion(connectionId, event.id);
      return false;
    }

    const draft = transformBitrixEventToYandexDraft(event);
    const syncedEvent = decision.action === 'create' || !mapping?.yandexEventUrl
      ? await this.yandexService.createEvent(connectionId, draft)
      : await this.yandexService.updateEvent(connectionId, mapping.yandexEventUrl, draft);

    this.sqliteService.upsertEventMapping({
      connectionId,
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

  private async syncYandexEvent(connectionId: string, event: YandexCalendarEvent): Promise<boolean> {
    if (shouldSkipRecurrence(event)) {
      this.noteRecurringSkip(connectionId, `Skipped Yandex event ${event.uid}: recurring events are unsupported in MVP.`);
      return true;
    }

    const mapping = this.sqliteService.getEventMappingByYandexUrl(connectionId, event.url);
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

    this.sqliteService.updateSyncState(connectionId, { lastOutcomeReason: decision.reason });
    if (decision.action === 'skip') {
      return false;
    }

    const draft = transformYandexEventToBitrixDraft(event);
    const syncedEvent = decision.action === 'update' && mapping?.bitrixEventId
      ? await this.bitrixService.updateEvent(connectionId, mapping.bitrixEventId, draft)
      : await this.bitrixService.createEvent(connectionId, draft);

    this.sqliteService.upsertEventMapping({
      connectionId,
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

  private async handleBitrixDeletion(connectionId: string, eventId: string): Promise<void> {
    const mapping = this.sqliteService.getEventMappingByBitrixId(connectionId, eventId);
    const deletedAt = new Date().toISOString();

    if (mapping?.yandexEventUrl) {
      await this.yandexService.deleteEvent(connectionId, mapping.yandexEventUrl);
    }

    this.sqliteService.upsertEventMapping({
      connectionId,
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
    const data = typeof payload.data === 'object' && payload.data ? payload.data as Record<string, unknown> : {};
    const fields = typeof data.FIELDS === 'object' && data.FIELDS ? data.FIELDS as Record<string, unknown> : {};
    const eventId = fields.ID
      ? String(fields.ID)
      : data.id
        ? String(data.id)
        : payload.id
          ? String(payload.id)
          : null;

    return {
      action: eventName.includes('delete') ? 'delete' : 'upsert',
      eventId,
    };
  }

  private getStatusHint(settings: ConnectionSettings, installationReady: boolean): 'ready' | 'disabled' | 'not_configured' {
    if (!settings.syncEnabled) {
      return 'disabled';
    }

    return installationReady && Boolean(
      settings.bitrixCalendarId
      && settings.yandexBaseUrl
      && settings.yandexUsername
      && settings.yandexPassword
      && settings.yandexCalendarUrl,
    )
      ? 'ready'
      : 'not_configured';
  }

  private getExecutionPreflight(path: SyncExecutionPath, settings: ConnectionSettings, installationReady: boolean): ManualResyncPreflight {
    const reason = this.getStatusHint(settings, installationReady);
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

  private getManualResyncPreflight(settings: ConnectionSettings, installationReady: boolean): ManualResyncPreflight {
    return this.getExecutionPreflight('manual_sync', settings, installationReady);
  }

  private applyNoopPreflight(connectionId: string, path: SyncExecutionPath, preflight: ManualResyncPreflight): SyncStatusResponse {
    const attemptedAt = new Date().toISOString();
    const currentState = this.sqliteService.getSyncState(connectionId);

    this.sqliteService.updateSyncState(connectionId, {
      activeDirection: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      lastOutcomeReason: `${path}_${preflight.reason}_noop`,
      lastPollAt: path === 'scheduled_poll' || path === 'startup_initial' || path === 'settings_enabled' ? attemptedAt : currentState.lastPollAt,
      lastProcessedBitrixEvents: 0,
      lastProcessedYandexEvents: 0,
      lastRunAt: attemptedAt,
      lastSkippedRecurringEvents: 0,
      lastWebhookAt: path === 'bitrix_webhook' ? attemptedAt : currentState.lastWebhookAt,
      status: preflight.reason === 'disabled' ? 'disabled' : 'idle',
    });

    return this.getStatus(connectionId);
  }

  private getReadyMessage(path: SyncExecutionPath): string {
    switch (path) {
      case 'bitrix_webhook':
        return 'Bitrix webhook processing is ready to run.';
      case 'scheduled_poll':
      case 'startup_initial':
      case 'settings_enabled':
        return 'Scheduled sync is ready to run.';
      case 'manual_sync':
      default:
        return 'Manual sync is ready to run.';
    }
  }

  private getBlockedMessage(path: SyncExecutionPath, reason: ManualResyncPreflight['reason']): string {
    if (path === 'bitrix_webhook') {
      return reason === 'disabled'
        ? 'Bitrix webhook was ignored because sync is disabled.'
        : 'Bitrix webhook was ignored because Bitrix authorization and Yandex credentials are not fully configured.';
    }

    if (path === 'manual_sync') {
      return reason === 'disabled'
        ? 'Manual sync is unavailable while sync is disabled.'
        : 'Manual sync is unavailable until Bitrix authorization and Yandex credentials are configured.';
    }

    return reason === 'disabled'
      ? 'Scheduled sync skipped because sync is disabled.'
      : 'Scheduled sync skipped because Bitrix authorization and Yandex credentials are not fully configured.';
  }

  private captureSyncError(connectionId: string, error: unknown): void {
    const currentState = this.sqliteService.getSyncState(connectionId);
    this.sqliteService.updateSyncState(connectionId, {
      activeDirection: null,
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: error instanceof Error ? error.message : 'Unknown sync error.',
      lastOutcomeReason: 'sync_failed',
      pollingFailureCount: currentState.pollingFailureCount + 1,
      status: 'error',
    });
  }

  private noteRecurringSkip(connectionId: string, message: string): void {
    const currentState = this.sqliteService.getSyncState(connectionId);
    this.sqliteService.updateSyncState(connectionId, {
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: message,
      lastOutcomeReason: 'recurring_event_skipped',
      lastSkippedRecurringEvents: currentState.lastSkippedRecurringEvents + 1,
      status: 'success',
    });
  }

  private scheduleNextPoll(schedule: PollingSchedule): void {
    const delay = this.computeNextDelay(schedule);
    this.log('Next polling iteration scheduled.', { delayMs: delay });
    this.pollingTimer = setTimeout(() => {
      void this.runSchedulerIteration('scheduled_poll').finally(() => {
        this.scheduleNextPoll(schedule);
      });
    }, delay);
  }

  private computeNextDelay(schedule: PollingSchedule): number {
    const states = this.sqliteService.listActiveConnections().map((item) => this.sqliteService.getSyncState(item.connection.id));
    const maxFailureCount = states.reduce((max, state) => Math.max(max, state.pollingFailureCount), 0);
    const fixedDelay = Math.max(1, Math.min(schedule.minDelayMs, schedule.maxDelayMs));
    const cappedBackoffMultiplier = Math.min(4, Math.max(1, 2 ** maxFailureCount));
    return fixedDelay * cappedBackoffMultiplier;
  }

  private requireContext(connectionId: string): { connection: ConnectionSettings; installationReady: boolean } {
    const context = this.sqliteService.getConnectionContext(connectionId);
    if (!context) {
      throw new Error(`Connection ${connectionId} was not found.`);
    }

    return {
      connection: context.connection,
      installationReady: this.isInstallationReady(connectionId),
    };
  }

  private isInstallationReady(connectionId: string): boolean {
    const context = this.sqliteService.getConnectionContext(connectionId);
    return Boolean(context?.installation.accessToken && context.installation.status === 'active');
  }

  private log(message: string, meta?: Record<string, unknown>): void {
    if (meta) {
      console.info(`[sync-service] ${message}`, meta);
      return;
    }

    console.info(`[sync-service] ${message}`);
  }
}
