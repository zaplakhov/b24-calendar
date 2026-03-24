/*
Module: conflict-resolver
Role: Computes deterministic sync actions for mapped Bitrix and Yandex events.
Source of Truth: backend/src/utils/conflict-resolver.ts

Uses:
  ../services/sqlite.service.ts:EventMappingRecord: true

Used by:
  ../services/sync.service.ts:SyncService: true

Glossary: none
*/

import type { EventMappingRecord } from '../services/sqlite.service';

export type SyncDecision = 'create' | 'update' | 'delete' | 'skip';

export interface ConflictDecision {
  action: SyncDecision;
  reason: string;
}

export type SyncProvider = 'bitrix' | 'yandex';

export interface ConflictInput {
  sourceProvider: SyncProvider;
  mapping: EventMappingRecord | null;
  sourceDeleted: boolean;
  sourceFingerprint: string;
  sourceUpdatedAt: string | null;
  sourceVersion: string | null;
  targetPresent: boolean;
}

function compareFreshness(
  sourceProvider: SyncProvider,
  sourceUpdatedAt: string | null,
  sourceVersion: string | null,
  targetUpdatedAt: string | null,
  targetVersion: string | null,
): number {
  const toTime = (value: string | null): number => {
    if (!value) return -1;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? -1 : parsed;
  };
  const sourceTime = toTime(sourceUpdatedAt);
  const targetTime = toTime(targetUpdatedAt);
  if (sourceTime !== targetTime) return sourceTime > targetTime ? 1 : -1;
  const sourceStable = sourceVersion ?? '';
  const targetStable = targetVersion ?? '';
  if (sourceStable !== targetStable) return sourceStable.localeCompare(targetStable);
  return sourceProvider === 'bitrix' ? 1 : -1;
}

export function resolveConflict(input: ConflictInput): ConflictDecision {
  const targetUpdatedAt = input.sourceProvider === 'bitrix' ? input.mapping?.yandexUpdatedAt ?? null : input.mapping?.bitrixUpdatedAt ?? null;
  const targetVersion = input.sourceProvider === 'bitrix'
    ? input.mapping?.yandexEventEtag ?? input.mapping?.yandexEventUid ?? input.mapping?.yandexEventUrl ?? null
    : input.mapping?.bitrixEventId ?? null;

  if (input.mapping?.deletedAt) {
    const tombstoneOrder = compareFreshness(
      input.sourceProvider,
      input.sourceUpdatedAt,
      input.sourceVersion,
      input.mapping.deletedAt,
      input.mapping.deletedBy,
    );
    if (tombstoneOrder <= 0) return { action: 'skip', reason: 'deleted_tombstone_replay' };
    return { action: 'create', reason: 'target_missing' };
  }

  if (input.sourceDeleted) {
    if (!input.mapping || !input.targetPresent) return { action: 'skip', reason: 'source_deleted_without_mapping' };
    const deleteOrder = compareFreshness(input.sourceProvider, input.sourceUpdatedAt, input.sourceVersion, targetUpdatedAt, targetVersion);
    return deleteOrder >= 0 ? { action: 'delete', reason: 'source_deleted' } : { action: 'skip', reason: 'stale_delete_ignored' };
  }

  if (!input.mapping) {
    return { action: 'create', reason: 'mapping_missing' };
  }

  if (!input.targetPresent) {
    return { action: 'create', reason: 'target_missing' };
  }

  const persistedSourceFingerprint = input.sourceProvider === 'bitrix' ? input.mapping.sourceFingerprint : input.mapping.targetFingerprint;
  if (persistedSourceFingerprint === input.sourceFingerprint) {
    return { action: 'skip', reason: 'fingerprint_match' };
  }

  const winner = compareFreshness(input.sourceProvider, input.sourceUpdatedAt, input.sourceVersion, targetUpdatedAt, targetVersion);
  return winner >= 0 ? { action: 'update', reason: 'source_newer_or_tiebreaker' } : { action: 'skip', reason: 'target_newer_or_tiebreaker' };
}
