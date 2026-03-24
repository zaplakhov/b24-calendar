/*
Module: sync-debug
Role: Provides structured sync logging with env-controlled verbosity for container diagnostics.
Source of Truth: backend/src/utils/sync-debug.ts

Uses: none

Used by:
  ../services/sync.service.ts:SyncService: true
  ../services/bitrix.service.ts:BitrixService: true
  ../services/yandex-caldav.service.ts:YandexCalDavService: true

Glossary: none
*/

export interface SyncDebugContext {
  connectionId?: string;
  phase: string;
  [key: string]: unknown;
}

function isEnabled(): boolean {
  return String(process.env.SYNC_DEBUG ?? '').toLowerCase() === 'true';
}

function isVerbose(): boolean {
  return String(process.env.SYNC_DEBUG_VERBOSE_PAYLOADS ?? '').toLowerCase() === 'true';
}

export function syncInfo(message: string, meta?: Record<string, unknown>): void {
  console.info(`[sync-service] ${message}`, meta ?? {});
}

export function syncWarn(message: string, meta?: Record<string, unknown>): void {
  console.warn(`[sync-service] ${message}`, meta ?? {});
}

export function syncError(message: string, meta?: Record<string, unknown>): void {
  console.error(`[sync-service] ${message}`, meta ?? {});
}

export function syncDebug(context: SyncDebugContext): void {
  if (!isEnabled()) {
    return;
  }

  console.info('[sync-debug]', context);
}

export function syncVerbose(context: SyncDebugContext): void {
  if (!isEnabled() || !isVerbose()) {
    return;
  }

  console.info('[sync-debug-verbose]', context);
}

export function syncDebugEnabled(): boolean {
  return isEnabled();
}

export function syncVerboseEnabled(): boolean {
  return isEnabled() && isVerbose();
}
