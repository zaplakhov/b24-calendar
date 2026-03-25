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

export interface SyncPayloadMarker {
  path: string;
  reason: 'redacted' | 'truncated_array' | 'truncated_object' | 'truncated_string';
  omittedCount?: number;
  originalLength?: number;
}

export interface SanitizedTracePayload<T = unknown> {
  markers: SyncPayloadMarker[];
  payload: T;
  truncated: boolean;
}

interface TraceGuardrailOptions {
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
}

const DEFAULT_TRACE_GUARDRAILS: Required<TraceGuardrailOptions> = {
  maxArrayItems: 200,
  maxObjectKeys: 80,
  maxStringLength: 600,
};

const SECRET_KEY_PATTERN = /(password|token|secret|credential|authorization|auth|cookie|session)/i;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function maskSecretValue(value: unknown): unknown {
  if (value === null || typeof value === 'undefined') {
    return value;
  }

  if (typeof value === 'string') {
    return value.length > 0 ? '***redacted***' : '';
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return '***redacted***';
  }

  return '***redacted***';
}

function sanitizeNode(value: unknown, path: string, markers: SyncPayloadMarker[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeNode(item, `${path}[${index}]`, markers));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (SECRET_KEY_PATTERN.test(key)) {
      result[key] = maskSecretValue(nestedValue);
      markers.push({ path: keyPath, reason: 'redacted' });
      continue;
    }

    result[key] = sanitizeNode(nestedValue, keyPath, markers);
  }

  return result;
}

function truncateNode(
  value: unknown,
  path: string,
  markers: SyncPayloadMarker[],
  options: Required<TraceGuardrailOptions>,
): unknown {
  if (typeof value === 'string') {
    if (value.length <= options.maxStringLength) {
      return value;
    }

    markers.push({
      originalLength: value.length,
      path,
      reason: 'truncated_string',
    });
    return `${value.slice(0, options.maxStringLength)}…[truncated]`;
  }

  if (Array.isArray(value)) {
    if (value.length <= options.maxArrayItems) {
      return value.map((item, index) => truncateNode(item, `${path}[${index}]`, markers, options));
    }

    markers.push({
      omittedCount: value.length - options.maxArrayItems,
      originalLength: value.length,
      path,
      reason: 'truncated_array',
    });

    return value
      .slice(0, options.maxArrayItems)
      .map((item, index) => truncateNode(item, `${path}[${index}]`, markers, options));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const keys = Object.keys(value);
  const selectedKeys = keys.slice(0, options.maxObjectKeys);
  if (keys.length > options.maxObjectKeys) {
    markers.push({
      omittedCount: keys.length - options.maxObjectKeys,
      originalLength: keys.length,
      path,
      reason: 'truncated_object',
    });
  }

  const result: Record<string, unknown> = {};
  for (const key of selectedKeys) {
    const keyPath = path ? `${path}.${key}` : key;
    result[key] = truncateNode(value[key], keyPath, markers, options);
  }

  return result;
}

export function sanitizeTracePayload<T = unknown>(payload: T): SanitizedTracePayload<T> {
  const markers: SyncPayloadMarker[] = [];
  const sanitized = sanitizeNode(payload, '', markers) as T;
  return {
    markers,
    payload: sanitized,
    truncated: false,
  };
}

export function truncateTracePayload<T = unknown>(
  payload: T,
  guardrails: TraceGuardrailOptions = {},
): SanitizedTracePayload<T> {
  const options = {
    ...DEFAULT_TRACE_GUARDRAILS,
    ...guardrails,
  };
  const markers: SyncPayloadMarker[] = [];
  const truncatedPayload = truncateNode(payload, '', markers, options) as T;

  return {
    markers,
    payload: truncatedPayload,
    truncated: markers.length > 0,
  };
}

export function sanitizeAndTruncateTracePayload<T = unknown>(
  payload: T,
  guardrails: TraceGuardrailOptions = {},
): SanitizedTracePayload<T> {
  const sanitized = sanitizeTracePayload(payload);
  const truncated = truncateTracePayload(sanitized.payload, guardrails);

  return {
    markers: [...sanitized.markers, ...truncated.markers],
    payload: truncated.payload,
    truncated: truncated.truncated,
  };
}
