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
  normalizeBitrixEventForSync,
  type NormalizationDescriptor,
  type NormalizationReasonCode,
  transformBitrixEventToYandexDraft,
  transformYandexEventToBitrixDraft,
  type BitrixCalendarEvent,
  type YandexCalendarEvent,
} from '../utils/transformer';
import { BitrixService } from './bitrix.service';
import { SQLiteService, type ConnectionSettings, type SyncRunObservability, type SyncState } from './sqlite.service';
import { YandexCalDavService, YandexCalendarNormalizationError, YandexCalendarObjectNotFoundError } from './yandex-caldav.service';
import { syncDebug, syncError, syncInfo, syncVerbose, syncWarn } from '../utils/sync-debug';

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
      counters: SyncRunObservability['counters'];
      processedBitrixEvents: number;
      processedYandexEvents: number;
      reasonCodes: SyncRunObservability['reasonCodes'];
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
  observability: SyncRunObservability;
  processedBitrixEvents: number;
  processedYandexEvents: number;
  skippedRecurringEvents: number;
  outcomeReason: string;
}

interface EventSyncResult {
  healed?: boolean;
  healingReason?: string;
  reason?: string;
  skipped: boolean;
}

interface SyncRunObservabilityAccumulator {
  counters: SyncRunObservability['counters'];
  reasonCodes: {
    errors: Set<string>;
    healing: Set<string>;
    skipped: Set<string>;
  };
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
          counters: state.lastRunObservability?.counters ?? this.createEmptyRunObservability().counters,
          processedBitrixEvents: state.lastProcessedBitrixEvents,
          processedYandexEvents: state.lastProcessedYandexEvents,
          reasonCodes: state.lastRunObservability?.reasonCodes ?? this.createEmptyRunObservability().reasonCodes,
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

  private createEmptyRunObservability(): SyncRunObservability {
    return {
      counters: {
        errorEvents: 0,
        healedMappings: 0,
        processedBitrixEvents: 0,
        processedYandexEvents: 0,
        skippedEvents: 0,
        skippedRecurringEvents: 0,
      },
      reasonCodes: {
        errors: [],
        healing: [],
        skipped: [],
      },
    };
  }

  private createObservabilityAccumulator(): SyncRunObservabilityAccumulator {
    const empty = this.createEmptyRunObservability();
    return {
      counters: { ...empty.counters },
      reasonCodes: {
        errors: new Set<string>(),
        healing: new Set<string>(),
        skipped: new Set<string>(),
      },
    };
  }

  private finalizeObservability(accumulator: SyncRunObservabilityAccumulator): SyncRunObservability {
    return {
      counters: accumulator.counters,
      reasonCodes: {
        errors: [...accumulator.reasonCodes.errors],
        healing: [...accumulator.reasonCodes.healing],
        skipped: [...accumulator.reasonCodes.skipped],
      },
    };
  }

  private computeOutcomeReason(
    baseReason: string,
    hadSoftFailures: boolean,
    observability: Pick<SyncRunObservability, 'counters'> | SyncRunObservabilityAccumulator,
  ): string {
    if (hadSoftFailures) {
      return 'incremental_sync_completed_with_soft_failures';
    }

    if (observability.counters.healedMappings > 0) {
      return 'incremental_sync_completed_with_healing';
    }

    return baseReason;
  }

  private noteSkip(accumulator: SyncRunObservabilityAccumulator, reason: NormalizationReasonCode | string): void {
    accumulator.counters.skippedEvents += 1;
    if (reason === 'recurrence_unsupported') {
      accumulator.counters.skippedRecurringEvents += 1;
    }
    accumulator.reasonCodes.skipped.add(reason);
  }

  private noteError(accumulator: SyncRunObservabilityAccumulator, reason: string): void {
    accumulator.counters.errorEvents += 1;
    accumulator.reasonCodes.errors.add(reason);
  }

  private noteHealing(accumulator: SyncRunObservabilityAccumulator, reason: string): void {
    accumulator.counters.healedMappings += 1;
    accumulator.reasonCodes.healing.add(reason);
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
        observability: this.createEmptyRunObservability(),
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
        observability: this.createEmptyRunObservability(),
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
        lastRunObservability: stats.observability,
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
    let hadSoftFailures = false;
    const observability = this.createObservabilityAccumulator();
    observability.counters.processedBitrixEvents = bitrixEvents.length;

    syncDebug({
      bitrixCursor: previousState.bitrixSyncCursor,
      connectionId,
      count: bitrixEvents.length,
      events: bitrixEvents.map((event) => ({
        calendarId: event.calendarId,
        endsAt: event.endsAt,
        eventId: event.id,
        isAllDay: event.isAllDay,
        startsAt: event.startsAt,
        title: event.title,
      })),
      phase: 'sync.bitrixEvents.received',
      selectedCalendarId: this.sqliteService.getConnectionById(connectionId)?.bitrixCalendarId ?? null,
    });

    for (const event of bitrixEvents) {
      try {
        const result = await this.syncBitrixEvent(connectionId, event);
        if (result.skipped && result.reason) {
          this.noteSkip(observability, result.reason);
        }
        if (result.healed && result.healingReason) {
          this.noteHealing(observability, result.healingReason);
        }
      } catch (error: unknown) {
        hadSoftFailures = true;
        this.noteError(observability, 'bitrix_event_soft_failed');
        syncWarn('Bitrix event failed during sync and was skipped.', {
          connectionId,
          error: error instanceof Error ? error.message : 'Unknown error',
          eventId: event.id,
          phase: 'sync.bitrixEvent.error',
          reason: 'bitrix_event_soft_failed',
        });
      }
    }

    const yandexResult = await this.runYandexIncrementalInternal(connectionId, previousState, startedAt, observability);
    hadSoftFailures = hadSoftFailures || yandexResult.hadSoftFailures;

    syncDebug({
      connectionId,
      hadSoftFailures,
      healedMappings: observability.counters.healedMappings,
      phase: 'sync.incremental.completed',
      processedBitrixEvents: bitrixEvents.length,
      processedYandexEvents: yandexResult.processedEvents,
      skippedRecurringEvents: observability.counters.skippedRecurringEvents,
    });

    const outcomeReason = this.computeOutcomeReason('incremental_sync_completed', hadSoftFailures, observability);

    syncInfo('[sync-operational] incremental summary', {
      connectionId,
      counters: observability.counters,
      phase: 'sync.incremental.summary',
      reasonCodes: this.finalizeObservability(observability).reasonCodes,
      reason: outcomeReason,
    });

    return {
      observability: this.finalizeObservability(observability),
      processedBitrixEvents: bitrixEvents.length,
      processedYandexEvents: yandexResult.processedEvents,
      skippedRecurringEvents: observability.counters.skippedRecurringEvents,
      outcomeReason,
    };
  }

  private async runWebhookAcceleratedSync(connectionId: string, payload: Record<string, unknown>, previousState: SyncState): Promise<SyncExecutionStats> {
    const descriptor = this.describeWebhookPayload(payload);
    let processedBitrixEvents = 0;
    let hadSoftFailures = false;
    const observability = this.createObservabilityAccumulator();

    if (descriptor.eventId) {
      if (descriptor.action === 'delete') {
        await this.handleBitrixDeletion(connectionId, descriptor.eventId);
        processedBitrixEvents = 1;
        observability.counters.processedBitrixEvents = 1;
      } else {
        const event = await this.bitrixService.fetchEventById(connectionId, descriptor.eventId);
        if (event) {
          processedBitrixEvents = 1;
          observability.counters.processedBitrixEvents = 1;
          try {
            const result = await this.syncBitrixEvent(connectionId, event);
            if (result.skipped && result.reason) {
              this.noteSkip(observability, result.reason);
            }
            if (result.healed && result.healingReason) {
              this.noteHealing(observability, result.healingReason);
            }
          } catch (error: unknown) {
            hadSoftFailures = true;
            this.noteError(observability, 'bitrix_event_soft_failed');
            syncWarn('Bitrix webhook event failed during sync and was skipped.', {
              connectionId,
              error: error instanceof Error ? error.message : 'Unknown error',
              eventId: event.id,
              phase: 'sync.bitrixWebhook.error',
              reason: 'bitrix_event_soft_failed',
            });
          }
        }
      }
    }

    const yandexResult = await this.runYandexIncrementalInternal(connectionId, previousState, new Date().toISOString(), observability);
    hadSoftFailures = hadSoftFailures || yandexResult.hadSoftFailures;
    const outcomeReason = this.computeOutcomeReason(
      descriptor.action === 'delete' ? 'bitrix_webhook_delete_processed' : 'bitrix_webhook_upsert_processed',
      hadSoftFailures,
      observability,
    );

    return {
      observability: this.finalizeObservability(observability),
      processedBitrixEvents,
      processedYandexEvents: yandexResult.processedEvents,
      skippedRecurringEvents: observability.counters.skippedRecurringEvents,
      outcomeReason,
    };
  }

  private async runYandexIncrementalInternal(
    connectionId: string,
    previousState: SyncState,
    startedAt: string,
    observability: SyncRunObservabilityAccumulator,
  ): Promise<{ processedEvents: number; skippedRecurringEvents: number; hadSoftFailures: boolean; healedMappings: number }> {
    const results = await this.yandexService.listEventResults(connectionId);
    const events = results.filter((result): result is { ok: true; value: YandexCalendarEvent } => result.ok).map((result) => result.value);
    const observedUrls = new Set(events.map((event) => event.url));
    let processedEvents = 0;
    let hadSoftFailures = false;
    observability.counters.processedYandexEvents = 0;

    syncDebug({
      connectionId,
      count: events.length,
      events: events.map((event) => ({
        endsAt: event.endsAt,
        etag: event.etag,
        startsAt: event.startsAt,
        summary: event.summary,
        uid: event.uid,
        url: event.url,
      })),
      phase: 'sync.yandexEvents.received',
      yandexCursor: previousState.yandexSyncCursor,
    });

    for (const result of results) {
      if (!result.ok) {
        hadSoftFailures = true;
        const observedUrl = this.getNormalizationDetailString(result.issue, 'url');
        if (observedUrl) {
          observedUrls.add(observedUrl);
        }
        this.noteSkip(observability, result.issue.reason);
        this.logNormalizationIssue(connectionId, 'sync.yandexEvent.skip', result.issue);
        continue;
      }

      const event = result.value;
      if (!this.shouldProcessYandexEvent(connectionId, event, previousState.yandexSyncCursor)) {
        continue;
      }

      processedEvents += 1;
      observability.counters.processedYandexEvents = processedEvents;
      try {
        const outcome = await this.syncYandexEvent(connectionId, event);
        if (outcome.skipped && outcome.reason) {
          this.noteSkip(observability, outcome.reason);
        }
        if (outcome.healed && outcome.healingReason) {
          this.noteHealing(observability, outcome.healingReason);
        }
      } catch (error: unknown) {
        hadSoftFailures = true;
        this.noteError(observability, 'yandex_event_soft_failed');
        syncWarn('Yandex event failed during sync and was skipped.', {
          connectionId,
          error: error instanceof Error ? error.message : 'Unknown error',
          phase: 'sync.yandexEvent.error',
          reason: 'yandex_event_soft_failed',
          uid: event.uid,
          url: event.url,
        });
      }
    }

    const mappings = this.sqliteService.listEventMappings(connectionId);
    for (const mapping of mappings) {
      if (!mapping.yandexEventUrl || observedUrls.has(mapping.yandexEventUrl) || mapping.status === 'deleted') {
        continue;
      }

      const healedEvent = mapping.yandexEventUid ? events.find((event) => event.uid === mapping.yandexEventUid) ?? null : null;
      if (healedEvent) {
        this.noteHealing(observability, 'yandex_mapping_healed_by_uid');
        this.sqliteService.upsertEventMapping({
          ...mapping,
          deferredReasonCodes: mapping.deferredReasonCodes,
          healingUrl: mapping.yandexEventUrl,
          lastDecisionReason: 'yandex_mapping_healed_by_uid',
          lastHealedAt: startedAt,
          lastHealingReason: 'yandex_mapping_healed_by_uid',
          lastSyncedAt: startedAt,
          preservedPayload: mapping.preservedPayload,
          sourceTimezone: mapping.sourceTimezone,
          targetTimezone: healedEvent.timezone,
          yandexEventEtag: healedEvent.etag,
          yandexEventUid: healedEvent.uid,
          yandexEventUrl: healedEvent.url,
          yandexUpdatedAt: healedEvent.updatedAt,
        });
        syncWarn('Yandex mapping healed after URL drift.', {
          connectionId,
          healedUrl: healedEvent.url,
          phase: 'sync.yandexMapping.healed',
          previousUrl: mapping.yandexEventUrl,
          reason: 'yandex_mapping_healed_by_uid',
        });
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
      hadSoftFailures,
      healedMappings: observability.counters.healedMappings,
      processedEvents,
      skippedRecurringEvents: observability.counters.skippedRecurringEvents,
    };
  }

  private shouldProcessYandexEvent(connectionId: string, event: YandexCalendarEvent, cursor: string | null): boolean {
    const mapping = this.sqliteService.getEventMappingByYandexUrl(connectionId, event.url)
      ?? (event.uid ? this.sqliteService.getEventMappingByYandexUid(connectionId, event.uid) : null);
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

  private async syncBitrixEvent(connectionId: string, event: BitrixCalendarEvent): Promise<EventSyncResult> {
    const selectedCalendarId = this.sqliteService.getConnectionById(connectionId)?.bitrixCalendarId ?? null;
    syncDebug({
      connectionId,
      event: {
        calendarId: event.calendarId,
        endsAt: event.endsAt,
        eventId: event.id,
        isAllDay: event.isAllDay,
        startsAt: event.startsAt,
        title: event.title,
        updatedAt: event.updatedAt,
      },
      phase: 'sync.bitrixEvent.inspect',
      selectedCalendarId,
    });

    const normalized = normalizeBitrixEventForSync(event, selectedCalendarId);
    if (!normalized.ok) {
      if (normalized.issue.reason === 'recurrence_unsupported') {
        this.noteRecurringSkip(connectionId, `Skipped Bitrix event ${event.id}: recurring events are unsupported in MVP.`);
      }

      this.logNormalizationIssue(connectionId, 'sync.bitrixEvent.skip', normalized.issue, { eventId: event.id });
      return {
        reason: normalized.issue.reason,
        skipped: true,
      };
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
    syncDebug({
      connectionId,
      decision,
      eventId: event.id,
      mapping,
      phase: 'sync.bitrixEvent.decision',
    });

    if (decision.action === 'skip') {
      return { skipped: false };
    }

    if (decision.action === 'delete') {
      await this.handleBitrixDeletion(connectionId, event.id);
      return { skipped: false };
    }

    const draft = transformBitrixEventToYandexDraft(event);
    syncDebug({
      connectionId,
      draft,
      eventId: event.id,
      phase: 'sync.bitrixToYandex.request',
    });
    let healed = false;
    let syncedEvent;

    if (decision.action === 'create' || !mapping?.yandexEventUrl) {
      syncedEvent = await this.yandexService.createEvent(connectionId, draft);
    } else {
      try {
        syncedEvent = await this.yandexService.updateEvent(connectionId, mapping.yandexEventUrl, draft);
      } catch (error: unknown) {
        if (error instanceof YandexCalendarObjectNotFoundError) {
          const healedEvent = mapping.yandexEventUid ? await this.yandexService.findEventByUid(connectionId, mapping.yandexEventUid) : null;
          healed = true;
          syncWarn('Detected stale Yandex mapping, attempting healing.', {
            bitrixEventId: event.id,
            connectionId,
            phase: 'sync.bitrixToYandex.staleMapping',
            reason: healedEvent ? 'stale_mapping_rebound' : 'stale_mapping_recreated',
            staleUrl: mapping.yandexEventUrl,
          });
          syncedEvent = healedEvent
            ? await this.yandexService.updateEvent(connectionId, healedEvent.url, draft)
            : await this.yandexService.createEvent(connectionId, draft);
        } else {
          throw error;
        }
      }
    }

    syncVerbose({
      connectionId,
      eventId: event.id,
      phase: 'sync.bitrixToYandex.response',
      syncedEvent,
    });

    this.sqliteService.upsertEventMapping({
      connectionId,
      bitrixEventId: event.id,
      bitrixUpdatedAt: event.updatedAt,
      deferredReasonCodes: draft.preserved.deferredReasonCodes,
      deletedAt: null,
      deletedBy: null,
      healingUrl: healed ? mapping?.yandexEventUrl ?? null : null,
      lastDecisionReason: decision.reason,
      lastHealedAt: healed ? new Date().toISOString() : mapping?.lastHealedAt ?? null,
      lastHealingReason: healed ? 'stale_mapping_healed' : mapping?.lastHealingReason ?? null,
      lastSyncedAt: new Date().toISOString(),
      lastWinner: 'bitrix',
      preservedPayload: {
        source: event.preserved,
        target: draft.preserved,
      },
      sourceFingerprint: fingerprint,
      sourceTimezone: event.timezone,
      status: 'synced',
      targetTimezone: syncedEvent.timezone,
      targetFingerprint: buildYandexEventFingerprint(syncedEvent),
      yandexUpdatedAt: syncedEvent.updatedAt,
      yandexEventEtag: syncedEvent.etag,
      yandexEventUid: syncedEvent.uid,
      yandexEventUrl: syncedEvent.url,
    });

    return {
      healed,
      healingReason: healed ? 'stale_mapping_healed' : undefined,
      skipped: false,
    };
  }

  private async syncYandexEvent(connectionId: string, event: YandexCalendarEvent): Promise<EventSyncResult> {
    syncDebug({
      connectionId,
      event: {
        endsAt: event.endsAt,
        etag: event.etag,
        startsAt: event.startsAt,
        summary: event.summary,
        uid: event.uid,
        updatedAt: event.updatedAt,
        url: event.url,
      },
      phase: 'sync.yandexEvent.inspect',
    });

    if (event.recurrenceRule) {
      this.noteRecurringSkip(connectionId, `Skipped Yandex event ${event.uid}: recurring events are unsupported in MVP.`);
      this.logNormalizationIssue(connectionId, 'sync.yandexEvent.skip', {
        kind: 'skip',
        provider: 'yandex',
        reason: 'recurrence_unsupported',
      }, { uid: event.uid, url: event.url });
      return { reason: 'recurrence_unsupported', skipped: true };
    }

    const mapping = this.sqliteService.getEventMappingByYandexUrl(connectionId, event.url)
      ?? (event.uid ? this.sqliteService.getEventMappingByYandexUid(connectionId, event.uid) : null);
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
    syncDebug({
      connectionId,
      decision,
      mapping,
      phase: 'sync.yandexEvent.decision',
      uid: event.uid,
      url: event.url,
    });

    if (decision.action === 'skip') {
      return { skipped: false };
    }

    const draft = transformYandexEventToBitrixDraft(event);
    syncDebug({
      connectionId,
      draft,
      phase: 'sync.yandexToBitrix.request',
      uid: event.uid,
      url: event.url,
    });
    const syncedEvent = decision.action === 'update' && mapping?.bitrixEventId
      ? await this.bitrixService.updateEvent(connectionId, mapping.bitrixEventId, draft)
      : await this.bitrixService.createEvent(connectionId, draft);

    syncVerbose({
      connectionId,
      phase: 'sync.yandexToBitrix.response',
      syncedEvent,
      uid: event.uid,
      url: event.url,
    });

    this.sqliteService.upsertEventMapping({
      connectionId,
      bitrixEventId: syncedEvent.id,
      bitrixUpdatedAt: syncedEvent.updatedAt,
      deferredReasonCodes: draft.preserved?.deferredReasonCodes ?? [],
      deletedAt: null,
      deletedBy: null,
      healingUrl: mapping?.yandexEventUrl && mapping.yandexEventUrl !== event.url ? mapping.yandexEventUrl : null,
      lastDecisionReason: decision.reason,
      lastHealedAt: mapping?.yandexEventUrl && mapping.yandexEventUrl !== event.url ? new Date().toISOString() : mapping?.lastHealedAt ?? null,
      lastHealingReason: mapping?.yandexEventUrl && mapping.yandexEventUrl !== event.url ? 'yandex_url_rebound' : mapping?.lastHealingReason ?? null,
      lastSyncedAt: new Date().toISOString(),
      lastWinner: 'yandex',
      preservedPayload: {
        source: event.preserved,
        target: draft.preserved ?? null,
      },
      sourceFingerprint: buildBitrixEventFingerprint(syncedEvent),
      sourceTimezone: syncedEvent.timezone,
      status: 'synced',
      targetTimezone: event.timezone,
      targetFingerprint: fingerprint,
      yandexUpdatedAt: event.updatedAt,
      yandexEventEtag: event.etag,
      yandexEventUid: event.uid,
      yandexEventUrl: event.url,
    });

    return {
      healed: Boolean(mapping?.yandexEventUrl && mapping.yandexEventUrl !== event.url),
      healingReason: mapping?.yandexEventUrl && mapping.yandexEventUrl !== event.url ? 'yandex_url_rebound' : undefined,
      skipped: false,
    };
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
      deferredReasonCodes: mapping?.deferredReasonCodes ?? [],
      deletedAt,
      deletedBy: 'bitrix',
      healingUrl: mapping?.healingUrl ?? null,
      lastDecisionReason: 'source_deleted',
      lastHealedAt: mapping?.lastHealedAt ?? null,
      lastHealingReason: mapping?.lastHealingReason ?? null,
      lastSyncedAt: deletedAt,
      lastWinner: 'bitrix',
      preservedPayload: mapping?.preservedPayload ?? null,
      sourceFingerprint: mapping?.sourceFingerprint ?? null,
      sourceTimezone: mapping?.sourceTimezone ?? null,
      status: 'deleted',
      targetTimezone: mapping?.targetTimezone ?? null,
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

  private logNormalizationIssue(
    connectionId: string,
    phase: string,
    issue: NormalizationDescriptor,
    extra?: Record<string, unknown>,
  ): void {
    syncWarn('Calendar event skipped by normalization contract.', {
      connectionId,
      phase,
      reason: issue.reason,
      provider: issue.provider,
      ...issue.details,
      ...extra,
    });
  }

  private getNormalizationDetailString(issue: NormalizationDescriptor, key: string): string | null {
    const value = issue.details?.[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
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
    return Math.max(1, Math.min(schedule.minDelayMs, schedule.maxDelayMs));
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
    syncInfo(message, meta);
  }
}
