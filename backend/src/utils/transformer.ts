/*
Module: transformer
Role: Normalizes Bitrix and Yandex calendar payloads and builds deterministic sync payloads for the MVP.
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
  raw: Record<string, unknown>;
}

export interface BitrixCalendarDraft {
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
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
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function escapeIcsValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
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

function ensureAllDayEnd(startIso: string, endIso: string): string {
  const startDate = new Date(startIso);
  const endDate = new Date(endIso);

  if (Number.isNaN(startDate.valueOf()) || Number.isNaN(endDate.valueOf())) {
    return endIso;
  }

  if (endDate.valueOf() > startDate.valueOf()) {
    return endIso;
  }

  const nextDay = new Date(startDate.valueOf());
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return nextDay.toISOString();
}

function extractIcsField(ics: string, fieldName: string): string | null {
  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  const match = unfolded.match(new RegExp(`(?:^|\\n)${fieldName}(?:;[^:]+)?:([^\\n]+)`, 'i'));
  return match ? match[1].trim() : null;
}

function parseIcsDate(value: string | null): { isAllDay: boolean; iso: string } | null {
  if (!value) {
    return null;
  }

  if (/^\d{8}$/.test(value)) {
    return {
      isAllDay: true,
      iso: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`,
    };
  }

  const normalized = value.includes('T')
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}${value.endsWith('Z') ? 'Z' : ''}`
    : value;

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf())
    ? null
    : {
        isAllDay: false,
        iso: parsed.toISOString(),
      };
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

export function transformBitrixEventToYandexDraft(event: BitrixCalendarEvent): YandexCalendarDraft {
  return {
    uid: buildDeterministicUid(event.id),
    summary: event.title,
    description: normalizeText(event.description),
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    isAllDay: event.isAllDay,
    recurrenceRule: normalizeText(event.recurrenceRule),
    sourceUpdatedAt: event.updatedAt ?? new Date().toISOString(),
  };
}

export function transformYandexEventToBitrixDraft(event: YandexCalendarEvent): BitrixCalendarDraft {
  return {
    title: event.summary,
    description: normalizeText(event.description),
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    isAllDay: event.isAllDay,
  };
}

export function buildYandexEventFingerprint(event: YandexCalendarEvent): string {
  return buildFingerprint({
    description: event.description,
    endsAt: event.endsAt,
    isAllDay: event.isAllDay,
    recurrenceRule: event.recurrenceRule,
    startsAt: event.startsAt,
    summary: event.summary,
    uid: event.uid,
  });
}

export function buildBitrixEventFingerprint(event: BitrixCalendarEvent): string {
  return buildFingerprint({
    calendarId: event.calendarId,
    deleted: event.deleted,
    description: event.description,
    endsAt: event.endsAt,
    isAllDay: event.isAllDay,
    recurrenceRule: event.recurrenceRule,
    startsAt: event.startsAt,
    title: event.title,
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
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    `DTSTAMP:${dtStamp}`,
    `DTSTART${datePrefix}:${dtStart}`,
    `DTEND${datePrefix}:${dtEnd}`,
    `SUMMARY:${escapeIcsValue(draft.summary)}`,
  ];

  if (draft.description) {
    lines.push(`DESCRIPTION:${escapeIcsValue(draft.description)}`);
  }

  if (draft.recurrenceRule) {
    lines.push(`RRULE:${draft.recurrenceRule}`);
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

export function parseYandexCalendarObject(rawIcs: string, url: string, etag: string | null): YandexCalendarEvent {
  const dtStart = parseIcsDate(extractIcsField(rawIcs, 'DTSTART'));
  const dtEnd = parseIcsDate(extractIcsField(rawIcs, 'DTEND'));

  return {
    url,
    etag,
    uid: extractIcsField(rawIcs, 'UID') ?? buildDeterministicUid(url),
    summary: extractIcsField(rawIcs, 'SUMMARY') ?? 'Untitled event',
    description: normalizeText(extractIcsField(rawIcs, 'DESCRIPTION')),
    startsAt: dtStart?.iso ?? new Date().toISOString(),
    endsAt: dtEnd?.iso ?? dtStart?.iso ?? new Date().toISOString(),
    isAllDay: dtStart?.isAllDay ?? false,
    updatedAt: parseIcsDate(extractIcsField(rawIcs, 'DTSTAMP'))?.iso ?? null,
    recurrenceRule: normalizeText(extractIcsField(rawIcs, 'RRULE')),
    rawIcs,
  };
}
