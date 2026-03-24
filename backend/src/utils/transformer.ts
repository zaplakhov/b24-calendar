/*
Module: transformer
Role: Normalizes Bitrix and Yandex calendar payloads, preserves unsupported metadata, and builds deterministic sync payloads.
Source of Truth: backend/src/utils/transformer.ts

Uses:
  node:crypto:createHash: true

Used by:
  ../services/bitrix.service.ts:BitrixService: true
  ../services/yandex-caldav.service.ts:YandexCalDavService: true
  ../services/sync.service.ts:SyncService: true

Glossary: none
*/

import { createHash } from 'node:crypto';

export type NormalizationReasonCode =
  | 'bitrix_event_out_of_scope'
  | 'bitrix_invalid_dates'
  | 'bitrix_missing_calendar_scope'
  | 'invalid_date_range'
  | 'missing_dtstart'
  | 'recurrence_unsupported'
  | 'yandex_invalid_dates';

export interface NormalizationDescriptor {
  kind: 'skip';
  provider: 'bitrix' | 'yandex';
  reason: NormalizationReasonCode;
  details?: Record<string, unknown>;
}

export interface EventOrganizer {
  email: string | null;
  name: string | null;
  raw: string | null;
}

export interface EventAttendee {
  email: string | null;
  name: string | null;
  partstat: string | null;
  role: string | null;
  raw: string | null;
}

export interface PreservedEventFields {
  deferredReasonCodes: string[];
  rawOrganizer: string | null;
  rawAttendees: EventAttendee[];
  rawProperties: Record<string, string[]>;
}

export interface BitrixCalendarEvent {
  id: string;
  calendarId: string | null;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string | null;
  isAllDay: boolean;
  updatedAt: string | null;
  deleted: boolean;
  recurrenceRule: string | null;
  location: string | null;
  organizer: EventOrganizer | null;
  status: string | null;
  transparency: string | null;
  attendees: EventAttendee[];
  preserved: PreservedEventFields;
  raw: Record<string, unknown>;
}

export interface BitrixCalendarDraft {
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  location?: string | null;
  organizer?: EventOrganizer | null;
  status?: string | null;
  transparency?: string | null;
  attendees?: EventAttendee[];
  timezone?: string | null;
  preserved?: PreservedEventFields;
}

export interface YandexCalendarEvent {
  url: string;
  etag: string | null;
  uid: string;
  summary: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  updatedAt: string | null;
  recurrenceRule: string | null;
  location: string | null;
  organizer: EventOrganizer | null;
  status: string | null;
  transparency: string | null;
  attendees: EventAttendee[];
  timezone: string | null;
  preserved: PreservedEventFields;
  rawIcs: string;
}

export interface YandexCalendarDraft {
  uid: string;
  summary: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  recurrenceRule: string | null;
  sourceUpdatedAt: string;
  location: string | null;
  organizer: EventOrganizer | null;
  status: string | null;
  transparency: string | null;
  attendees: EventAttendee[];
  timezone: string | null;
  preserved: PreservedEventFields;
}

export type NormalizationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issue: NormalizationDescriptor };

const SENTINEL_YEAR_THRESHOLD = 2000;
const DEFAULT_TIMEZONE = 'UTC';

function resolveTimeZone(timezone: string | null): string {
  const candidate = normalizeText(timezone) ?? DEFAULT_TIMEZONE;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function extractTimeZoneParts(date: Date, timeZone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  });

  return formatter.formatToParts(date).reduce<Record<string, number>>((accumulator, part) => {
    if (part.type !== 'literal') {
      accumulator[part.type] = Number.parseInt(part.value, 10);
    }
    return accumulator;
  }, {});
}

function getTimeZoneOffsetMs(timestampMs: number, timeZone: string): number {
  const parts = extractTimeZoneParts(new Date(timestampMs), timeZone);
  const asUtc = Date.UTC(
    parts.year,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );

  return asUtc - timestampMs;
}

function convertLocalIcsDateToUtc(value: string, timezone: string | null): string | null {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  const resolvedTimeZone = resolveTimeZone(timezone);
  const localParts = {
    day: Number.parseInt(day, 10),
    hour: Number.parseInt(hour, 10),
    minute: Number.parseInt(minute, 10),
    month: Number.parseInt(month, 10),
    second: Number.parseInt(second, 10),
    year: Number.parseInt(year, 10),
  };

  let utcMs = Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day,
    localParts.hour,
    localParts.minute,
    localParts.second,
  );

  for (let index = 0; index < 2; index += 1) {
    const offsetMs = getTimeZoneOffsetMs(utcMs, resolvedTimeZone);
    const nextUtcMs = Date.UTC(
      localParts.year,
      localParts.month - 1,
      localParts.day,
      localParts.hour,
      localParts.minute,
      localParts.second,
    ) - offsetMs;

    if (nextUtcMs === utcMs) {
      break;
    }

    utcMs = nextUtcMs;
  }

  const iso = new Date(utcMs).toISOString();
  return isIsoDateSupported(iso) ? iso : null;
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function escapeIcsValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function decodeIcsValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function formatDateForIcs(date: string, allDay: boolean): string {
  const parsed = new Date(date);

  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid event date: ${date}`);
  }

  if (allDay) {
    return parsed.toISOString().slice(0, 10).replace(/-/g, '');
  }

  return parsed.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function ensureAllDayEnd(startIso: string, endIso: string | null): string {
  const startDate = new Date(startIso);
  const endDate = endIso ? new Date(endIso) : new Date(Number.NaN);

  if (Number.isNaN(startDate.valueOf())) {
    return endIso ?? startIso;
  }

  if (!Number.isNaN(endDate.valueOf()) && endDate.valueOf() > startDate.valueOf()) {
    return endIso ?? endDate.toISOString();
  }

  const nextDay = new Date(startDate.valueOf());
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return nextDay.toISOString();
}

function extractIcsFieldLines(ics: string, fieldName: string): string[] {
  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  const pattern = new RegExp(`(?:^|\\n)${fieldName}(?:;[^:]+)?:([^\\n]+)`, 'gi');
  const values: string[] = [];

  for (const match of unfolded.matchAll(pattern)) {
    values.push(match[1].trim());
  }

  return values;
}

function extractIcsField(ics: string, fieldName: string): string | null {
  return extractIcsFieldLines(ics, fieldName)[0] ?? null;
}

function extractIcsProperty(ics: string, fieldName: string): { params: Record<string, string>; value: string } | null {
  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  const match = unfolded.match(new RegExp(`(?:^|\\n)${fieldName}((?:;[^:\\n]+)*)?:([^\\n]+)`, 'i'));
  if (!match) {
    return null;
  }

  const params: Record<string, string> = {};
  for (const param of (match[1] ?? '').split(';').filter(Boolean)) {
    const [key, rawValue] = param.split('=');
    if (key && rawValue) {
      params[key.toUpperCase()] = rawValue;
    }
  }

  return {
    params,
    value: match[2].trim(),
  };
}

function isIsoDateSupported(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.getUTCFullYear() >= SENTINEL_YEAR_THRESHOLD;
}

function parseBitrixDate(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.valueOf()) || parsed.getUTCFullYear() < SENTINEL_YEAR_THRESHOLD) {
    return null;
  }

  return parsed.toISOString();
}

function parseIcsDate(value: string | null, timezone: string | null): { isAllDay: boolean; iso: string } | null {
  if (!value) {
    return null;
  }

  if (/^\d{8}$/.test(value)) {
    return {
      isAllDay: true,
      iso: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`,
    };
  }

  if (/^\d{8}T\d{6}Z$/.test(value)) {
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
    return isIsoDateSupported(iso)
      ? { isAllDay: false, iso: new Date(iso).toISOString() }
      : null;
  }

  if (/^\d{8}T\d{6}$/.test(value)) {
    const iso = convertLocalIcsDateToUtc(value, timezone);
    return iso
      ? { isAllDay: false, iso }
      : null;
  }

  return isIsoDateSupported(value)
    ? {
        isAllDay: false,
        iso: new Date(value).toISOString(),
      }
    : null;
}

function parseMailtoValue(value: string | null): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/^mailto:/i, '') || null;
}

function parseOrganizerFromIcs(ics: string): EventOrganizer | null {
  const property = extractIcsProperty(ics, 'ORGANIZER');
  if (!property) {
    return null;
  }

  return {
    email: parseMailtoValue(property.value),
    name: normalizeText(property.params.CN),
    raw: property.value,
  };
}

function parseAttendeesFromIcs(ics: string): EventAttendee[] {
  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  const matches = [...unfolded.matchAll(/(?:^|\n)ATTENDEE((?:;[^:\n]+)*)?:([^\n]+)/gi)];

  return matches.map((match) => {
    const params: Record<string, string> = {};
    for (const param of (match[1] ?? '').split(';').filter(Boolean)) {
      const [key, rawValue] = param.split('=');
      if (key && rawValue) {
        params[key.toUpperCase()] = rawValue;
      }
    }

    return {
      email: parseMailtoValue(match[2].trim()),
      name: normalizeText(params.CN),
      partstat: normalizeText(params.PARTSTAT),
      role: normalizeText(params.ROLE),
      raw: match[2].trim(),
    };
  });
}

function parseBitrixAttendees(raw: Record<string, unknown>): EventAttendee[] {
  const source = raw.ATTENDEES ?? raw.attendees ?? raw.MEETING ?? [];
  if (!Array.isArray(source)) {
    return [];
  }

  return source.map((item) => {
    if (typeof item === 'string') {
      return {
        email: parseMailtoValue(item),
        name: null,
        partstat: null,
        role: null,
        raw: item,
      };
    }

    const payload = typeof item === 'object' && item ? item as Record<string, unknown> : {};
    return {
      email: typeof payload.email === 'string' ? parseMailtoValue(payload.email) : typeof payload.EMAIL === 'string' ? parseMailtoValue(payload.EMAIL) : null,
      name: typeof payload.name === 'string' ? normalizeText(payload.name) : typeof payload.NAME === 'string' ? normalizeText(payload.NAME) : null,
      partstat: typeof payload.status === 'string' ? normalizeText(payload.status) : typeof payload.STATUS === 'string' ? normalizeText(payload.STATUS) : null,
      role: typeof payload.role === 'string' ? normalizeText(payload.role) : typeof payload.ROLE === 'string' ? normalizeText(payload.ROLE) : null,
      raw: JSON.stringify(payload),
    };
  });
}

function defaultPreservedFields(overrides?: Partial<PreservedEventFields>): PreservedEventFields {
  return {
    deferredReasonCodes: overrides?.deferredReasonCodes ?? [],
    rawAttendees: overrides?.rawAttendees ?? [],
    rawOrganizer: overrides?.rawOrganizer ?? null,
    rawProperties: overrides?.rawProperties ?? {},
  };
}

function appendDeferredRawProperty(
  preserved: PreservedEventFields,
  key: string,
  value: string | null | undefined,
): void {
  const normalized = normalizeText(value);
  if (!normalized) {
    return;
  }

  const current = preserved.rawProperties[key] ?? [];
  preserved.rawProperties[key] = [...current, normalized];
}

function parsePreservedField(rawIcs: string): PreservedEventFields {
  const encoded = extractIcsField(rawIcs, 'X-B24-PRESERVED');
  if (!encoded) {
    return defaultPreservedFields();
  }

  try {
    const parsed = JSON.parse(decodeIcsValue(encoded) ?? '{}') as Partial<PreservedEventFields>;
    return defaultPreservedFields(parsed);
  } catch {
    return defaultPreservedFields();
  }
}

export function shouldSkipRecurrence(event: { recurrenceRule: string | null }): boolean {
  return Boolean(normalizeText(event.recurrenceRule));
}

export function buildDeterministicUid(sourceId: string): string {
  return `${sourceId}@b24-calendar-sync.local`;
}

export function buildFingerprint(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function normalizeBitrixEventForSync(
  event: BitrixCalendarEvent,
  selectedCalendarId: string | null,
): NormalizationResult<BitrixCalendarEvent> {
  if (!selectedCalendarId) {
    return {
      ok: false,
      issue: {
        kind: 'skip',
        provider: 'bitrix',
        reason: 'bitrix_missing_calendar_scope',
      },
    };
  }

  if (!event.calendarId || event.calendarId !== selectedCalendarId) {
    return {
      ok: false,
      issue: {
        kind: 'skip',
        provider: 'bitrix',
        reason: 'bitrix_event_out_of_scope',
        details: {
          eventCalendarId: event.calendarId,
          selectedCalendarId,
        },
      },
    };
  }

  if (shouldSkipRecurrence(event)) {
    return {
      ok: false,
      issue: {
        kind: 'skip',
        provider: 'bitrix',
        reason: 'recurrence_unsupported',
      },
    };
  }

  if (!isIsoDateSupported(event.startsAt) || !isIsoDateSupported(event.endsAt)) {
    return {
      ok: false,
      issue: {
        kind: 'skip',
        provider: 'bitrix',
        reason: 'bitrix_invalid_dates',
        details: {
          endsAt: event.endsAt,
          startsAt: event.startsAt,
        },
      },
    };
  }

  const start = Date.parse(event.startsAt);
  const end = Date.parse(event.endsAt);
  const validRange = event.isAllDay ? end >= start : end > start;
  if (!validRange) {
    return {
      ok: false,
      issue: {
        kind: 'skip',
        provider: 'bitrix',
        reason: 'invalid_date_range',
      },
    };
  }

  return { ok: true, value: event };
}

export function transformBitrixEventToYandexDraft(event: BitrixCalendarEvent): YandexCalendarDraft {
  return {
    uid: buildDeterministicUid(event.id),
    summary: event.title,
    description: normalizeText(event.description),
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    isAllDay: event.isAllDay,
    recurrenceRule: normalizeText(event.recurrenceRule),
    sourceUpdatedAt: event.updatedAt ?? event.startsAt,
    location: event.location,
    organizer: event.organizer,
    status: event.status,
    transparency: event.transparency,
    attendees: event.attendees,
    timezone: event.timezone ?? DEFAULT_TIMEZONE,
    preserved: defaultPreservedFields({
      ...event.preserved,
      deferredReasonCodes: [...new Set(event.preserved.deferredReasonCodes)],
      rawAttendees: event.preserved.rawAttendees.length > 0 ? event.preserved.rawAttendees : event.attendees,
      rawOrganizer: event.preserved.rawOrganizer ?? event.organizer?.raw ?? null,
    }),
  };
}

export function transformYandexEventToBitrixDraft(event: YandexCalendarEvent): BitrixCalendarDraft {
  const preserved = defaultPreservedFields({
    ...event.preserved,
    deferredReasonCodes: [...event.preserved.deferredReasonCodes],
    rawAttendees: event.preserved.rawAttendees.length > 0 ? event.preserved.rawAttendees : event.attendees,
    rawOrganizer: event.preserved.rawOrganizer ?? event.organizer?.raw ?? event.organizer?.email ?? event.organizer?.name ?? null,
    rawProperties: Object.fromEntries(
      Object.entries(event.preserved.rawProperties).map(([key, values]) => [key, [...values]]),
    ),
  });

  if (event.location) {
    preserved.deferredReasonCodes.push('bitrix_location_deferred');
    appendDeferredRawProperty(preserved, 'location', event.location);
  }

  if (event.organizer?.email || event.organizer?.name || event.organizer?.raw) {
    preserved.deferredReasonCodes.push('bitrix_organizer_deferred');
    appendDeferredRawProperty(preserved, 'organizer', event.organizer.raw ?? event.organizer.email ?? event.organizer.name ?? null);
  }

  if (event.status) {
    preserved.deferredReasonCodes.push('bitrix_status_deferred');
    appendDeferredRawProperty(preserved, 'status', event.status);
  }

  if (event.transparency) {
    preserved.deferredReasonCodes.push('bitrix_transparency_deferred');
    appendDeferredRawProperty(preserved, 'transparency', event.transparency);
  }

  if (event.timezone) {
    preserved.deferredReasonCodes.push('bitrix_timezone_deferred');
    appendDeferredRawProperty(preserved, 'timezone', event.timezone);
  }

  if (event.attendees.length > 0) {
    preserved.deferredReasonCodes.push('bitrix_attendees_deferred');
  }

  preserved.deferredReasonCodes = [...new Set(preserved.deferredReasonCodes)];

  return {
    title: event.summary,
    description: normalizeText(event.description),
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    isAllDay: event.isAllDay,
    location: null,
    organizer: null,
    status: null,
    transparency: null,
    attendees: [],
    timezone: null,
    preserved,
  };
}

export function buildYandexEventFingerprint(event: YandexCalendarEvent): string {
  return buildFingerprint({
    attendees: event.attendees,
    description: event.description,
    endsAt: event.endsAt,
    isAllDay: event.isAllDay,
    location: event.location,
    organizer: event.organizer,
    preserved: event.preserved,
    recurrenceRule: event.recurrenceRule,
    startsAt: event.startsAt,
    status: event.status,
    summary: event.summary,
    timezone: event.timezone,
    transparency: event.transparency,
    uid: event.uid,
  });
}

export function buildBitrixEventFingerprint(event: BitrixCalendarEvent): string {
  return buildFingerprint({
    attendees: event.attendees,
    calendarId: event.calendarId,
    deleted: event.deleted,
    description: event.description,
    endsAt: event.endsAt,
    isAllDay: event.isAllDay,
    location: event.location,
    organizer: event.organizer,
    preserved: event.preserved,
    recurrenceRule: event.recurrenceRule,
    startsAt: event.startsAt,
    status: event.status,
    timezone: event.timezone,
    title: event.title,
    transparency: event.transparency,
    updatedAt: event.updatedAt,
  });
}

export function buildIcsEvent(draft: YandexCalendarDraft): string {
  const normalizedEnd = draft.isAllDay ? ensureAllDayEnd(draft.startsAt, draft.endsAt) : draft.endsAt;
  const dtStamp = formatDateForIcs(draft.sourceUpdatedAt, false);
  const dtStart = formatDateForIcs(draft.startsAt, draft.isAllDay);
  const dtEnd = formatDateForIcs(normalizedEnd, draft.isAllDay);
  const datePrefix = draft.isAllDay ? ';VALUE=DATE' : '';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//b24-calendar//MVP//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeIcsValue(draft.uid)}`,
    'SEQUENCE:0',
    `STATUS:${escapeIcsValue(draft.status ?? 'CONFIRMED')}`,
    `TRANSP:${escapeIcsValue(draft.transparency ?? 'OPAQUE')}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART${datePrefix}:${dtStart}`,
    `DTEND${datePrefix}:${dtEnd}`,
    `SUMMARY:${escapeIcsValue(draft.summary)}`,
    `X-B24-TIMEZONE:${escapeIcsValue(draft.timezone ?? DEFAULT_TIMEZONE)}`,
  ];

  if (draft.description) {
    lines.push(`DESCRIPTION:${escapeIcsValue(draft.description)}`);
  }

  if (draft.location) {
    lines.push(`LOCATION:${escapeIcsValue(draft.location)}`);
  }

  if (draft.organizer?.email || draft.organizer?.name) {
    const cn = draft.organizer.name ? `;CN=${escapeIcsValue(draft.organizer.name)}` : '';
    lines.push(`ORGANIZER${cn}:mailto:${escapeIcsValue(draft.organizer.email ?? 'unknown@example.invalid')}`);
  }

  for (const attendee of draft.attendees) {
    const params = [
      attendee.name ? `CN=${escapeIcsValue(attendee.name)}` : null,
      attendee.role ? `ROLE=${escapeIcsValue(attendee.role)}` : null,
      attendee.partstat ? `PARTSTAT=${escapeIcsValue(attendee.partstat)}` : null,
    ].filter((item): item is string => Boolean(item));
    const prefix = params.length > 0 ? `;${params.join(';')}` : '';
    lines.push(`ATTENDEE${prefix}:mailto:${escapeIcsValue(attendee.email ?? 'unknown@example.invalid')}`);
  }

  if (draft.recurrenceRule) {
    lines.push(`RRULE:${draft.recurrenceRule}`);
  }

  if (draft.preserved.deferredReasonCodes.length > 0 || Object.keys(draft.preserved.rawProperties).length > 0) {
    lines.push(`X-B24-PRESERVED:${escapeIcsValue(JSON.stringify(draft.preserved))}`);
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

export function parseYandexCalendarObject(rawIcs: string, url: string, etag: string | null): NormalizationResult<YandexCalendarEvent> {
  const dtStartProp = extractIcsProperty(rawIcs, 'DTSTART');
  const dtEndProp = extractIcsProperty(rawIcs, 'DTEND');
  const timezone = normalizeText(extractIcsField(rawIcs, 'X-B24-TIMEZONE')) ?? normalizeText(dtStartProp?.params.TZID) ?? DEFAULT_TIMEZONE;
  const dtStart = parseIcsDate(dtStartProp?.value ?? null, timezone);
  const dtEnd = parseIcsDate(dtEndProp?.value ?? null, timezone);
  const recurrenceRule = normalizeText(extractIcsField(rawIcs, 'RRULE'));

  if (recurrenceRule) {
    return {
      ok: false,
      issue: {
        kind: 'skip',
        provider: 'yandex',
        reason: 'recurrence_unsupported',
        details: { url },
      },
    };
  }

  if (!dtStart) {
    return {
      ok: false,
      issue: {
        kind: 'skip',
        provider: 'yandex',
        reason: 'missing_dtstart',
        details: { url },
      },
    };
  }

  const normalizedEnd = dtStart.isAllDay
    ? ensureAllDayEnd(dtStart.iso, dtEnd?.iso ?? null)
    : (dtEnd?.iso ?? null);

  if (!normalizedEnd || !isIsoDateSupported(dtStart.iso) || !isIsoDateSupported(normalizedEnd)) {
    return {
      ok: false,
      issue: {
        kind: 'skip',
        provider: 'yandex',
        reason: 'yandex_invalid_dates',
        details: { url },
      },
    };
  }

  if (Date.parse(normalizedEnd) <= Date.parse(dtStart.iso)) {
    return {
      ok: false,
      issue: {
        kind: 'skip',
        provider: 'yandex',
        reason: 'invalid_date_range',
        details: { url },
      },
    };
  }

  return {
    ok: true,
    value: {
      url,
      etag,
      uid: extractIcsField(rawIcs, 'UID') ?? buildDeterministicUid(url),
      summary: decodeIcsValue(extractIcsField(rawIcs, 'SUMMARY')) ?? 'Untitled event',
      description: normalizeText(decodeIcsValue(extractIcsField(rawIcs, 'DESCRIPTION'))),
      startsAt: dtStart.iso,
      endsAt: normalizedEnd,
      isAllDay: dtStart.isAllDay,
      updatedAt: parseIcsDate(extractIcsField(rawIcs, 'DTSTAMP'), DEFAULT_TIMEZONE)?.iso ?? null,
      recurrenceRule,
      location: normalizeText(decodeIcsValue(extractIcsField(rawIcs, 'LOCATION'))),
      organizer: parseOrganizerFromIcs(rawIcs),
      status: normalizeText(extractIcsField(rawIcs, 'STATUS')),
      transparency: normalizeText(extractIcsField(rawIcs, 'TRANSP')),
      attendees: parseAttendeesFromIcs(rawIcs),
      timezone,
      preserved: parsePreservedField(rawIcs),
      rawIcs,
    },
  };
}

export function buildBitrixEventFromRaw(payload: Record<string, unknown>): BitrixCalendarEvent {
  const id = String(payload.ID ?? payload.id ?? '');
  const startsAt = parseBitrixDate(typeof payload.DATE_FROM === 'string' ? payload.DATE_FROM : typeof payload.dateFrom === 'string' ? payload.dateFrom : typeof payload.from === 'string' ? payload.from : null) ?? '';
  const endsAt = parseBitrixDate(typeof payload.DATE_TO === 'string' ? payload.DATE_TO : typeof payload.dateTo === 'string' ? payload.dateTo : typeof payload.to === 'string' ? payload.to : null) ?? '';
  const organizerEmail = typeof payload.ORGANIZER_EMAIL === 'string' ? payload.ORGANIZER_EMAIL : null;
  const organizerName = typeof payload.ORGANIZER_NAME === 'string' ? payload.ORGANIZER_NAME : typeof payload.CREATED_BY_NAME === 'string' ? payload.CREATED_BY_NAME : null;
  const attendees = parseBitrixAttendees(payload);

  return {
    id,
    calendarId: payload.SECT_ID ? String(payload.SECT_ID) : payload.sectionId ? String(payload.sectionId) : null,
    title: String(payload.NAME ?? payload.name ?? 'Untitled Bitrix event'),
    description: payload.DESCRIPTION ? String(payload.DESCRIPTION) : payload.description ? String(payload.description) : null,
    startsAt,
    endsAt,
    timezone: payload.TZ_FROM ? String(payload.TZ_FROM) : payload.timezone ? String(payload.timezone) : DEFAULT_TIMEZONE,
    isAllDay: String(payload.SKIP_TIME ?? payload.skipTime ?? 'N').toUpperCase() === 'Y',
    updatedAt: parseBitrixDate(payload.TIMESTAMP_X ? String(payload.TIMESTAMP_X) : payload.updatedAt ? String(payload.updatedAt) : null),
    deleted: false,
    recurrenceRule: payload.RRULE ? String(payload.RRULE) : payload.rrule ? String(payload.rrule) : null,
    location: typeof payload.LOCATION === 'string' ? normalizeText(payload.LOCATION) : typeof payload.location === 'string' ? normalizeText(payload.location) : null,
    organizer: organizerEmail || organizerName
      ? {
          email: parseMailtoValue(organizerEmail),
          name: normalizeText(organizerName),
          raw: organizerEmail,
        }
      : null,
    status: typeof payload.STATUS === 'string' ? normalizeText(payload.STATUS) : null,
    transparency: typeof payload.TRANSP === 'string' ? normalizeText(payload.TRANSP) : null,
    attendees,
    preserved: defaultPreservedFields({
      deferredReasonCodes: attendees.length > 0 ? ['bitrix_attendees_best_effort'] : [],
      rawAttendees: attendees,
      rawOrganizer: organizerEmail,
    }),
    raw: payload,
  };
}
