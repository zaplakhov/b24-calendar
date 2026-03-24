/*
Module: transformer.test
Role: Verifies normalization, extended field preservation, and recurring skip behavior for calendar transformer helpers.
Source of Truth: backend/src/utils/transformer.test.ts

Uses:
  node:test:test: true
  node:assert/strict: true
  ./transformer.ts: true

Used by: none

Glossary: none
*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBitrixEventFromRaw,
  buildIcsEvent,
  normalizeBitrixEventForSync,
  parseYandexCalendarObject,
  transformBitrixEventToYandexDraft,
  transformYandexEventToBitrixDraft,
} from './transformer';

test('transformer skips Bitrix sentinel dates without fallback to now', () => {
  const event = buildBitrixEventFromRaw({
    DATE_FROM: '1601-01-01T00:00:00Z',
    DATE_TO: '1601-01-01T01:00:00Z',
    ID: '1',
    NAME: 'Broken',
    SECT_ID: 'calendar-1',
  });

  const result = normalizeBitrixEventForSync(event, 'calendar-1');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.issue.reason, 'bitrix_invalid_dates');
  }
  assert.equal(event.startsAt, '');
});

test('transformer round-trips extended fields and all-day semantics through ICS', () => {
  const bitrixEvent = buildBitrixEventFromRaw({
    ATTENDEES: [{ EMAIL: 'guest@example.com', NAME: 'Guest', STATUS: 'ACCEPTED' }],
    DATE_FROM: '2026-03-24T00:00:00Z',
    DATE_TO: '2026-03-24T00:00:00Z',
    DESCRIPTION: 'Description',
    ID: '42',
    LOCATION: 'Room 301',
    NAME: 'All day planning',
    ORGANIZER_EMAIL: 'owner@example.com',
    ORGANIZER_NAME: 'Owner',
    SECT_ID: 'calendar-1',
    SKIP_TIME: 'Y',
    STATUS: 'CONFIRMED',
    TIMESTAMP_X: '2026-03-24T09:00:00Z',
    TRANSP: 'TRANSPARENT',
    TZ_FROM: 'Europe/Moscow',
  });

  const draft = transformBitrixEventToYandexDraft(bitrixEvent);
  const ics = buildIcsEvent(draft);
  const parsed = parseYandexCalendarObject(ics, 'https://caldav.yandex.ru/event-42.ics', 'etag-1');

  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  assert.equal(parsed.value.isAllDay, true);
  assert.equal(parsed.value.startsAt, '2026-03-24T00:00:00.000Z');
  assert.equal(parsed.value.endsAt, '2026-03-25T00:00:00.000Z');
  assert.equal(parsed.value.location, 'Room 301');
  assert.equal(parsed.value.organizer?.email, 'owner@example.com');
  assert.equal(parsed.value.status, 'CONFIRMED');
  assert.equal(parsed.value.transparency, 'TRANSPARENT');
  assert.equal(parsed.value.attendees[0]?.email, 'guest@example.com');
  assert.equal(parsed.value.timezone, 'Europe/Moscow');
  assert.deepEqual(parsed.value.preserved.deferredReasonCodes, ['bitrix_attendees_best_effort']);
});

test('transformer returns explicit recurring skip for Yandex objects', () => {
  const parsed = parseYandexCalendarObject([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event-1',
    'SUMMARY:Recurring',
    'DTSTAMP:20260324T090000Z',
    'DTSTART:20260324T100000Z',
    'DTEND:20260324T110000Z',
    'RRULE:FREQ=DAILY;COUNT=3',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n'), 'https://caldav.yandex.ru/recurring.ics', 'etag');

  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.issue.reason, 'recurrence_unsupported');
  }
});

test('transformer applies TZID policy for inbound Yandex floating datetimes', () => {
  const parsed = parseYandexCalendarObject([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event-tz',
    'SUMMARY:Timezone aware',
    'DTSTAMP:20260324T090000Z',
    'DTSTART;TZID=Europe/Moscow:20260324T130000',
    'DTEND;TZID=Europe/Moscow:20260324T140000',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n'), 'https://caldav.yandex.ru/timezone-aware.ics', 'etag-tz');

  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  assert.equal(parsed.value.timezone, 'Europe/Moscow');
  assert.equal(parsed.value.startsAt, '2026-03-24T10:00:00.000Z');
  assert.equal(parsed.value.endsAt, '2026-03-24T11:00:00.000Z');
});

test('transformer classifies unsupported Yandex -> Bitrix extended fields as deferred metadata', () => {
  const draft = transformYandexEventToBitrixDraft({
    attendees: [{ email: 'guest@example.com', name: 'Guest', partstat: 'ACCEPTED', raw: 'mailto:guest@example.com', role: null }],
    description: 'Description',
    endsAt: '2026-03-24T11:00:00.000Z',
    etag: 'etag-extended',
    isAllDay: false,
    location: 'Room 301',
    organizer: { email: 'owner@example.com', name: 'Owner', raw: 'mailto:owner@example.com' },
    preserved: { deferredReasonCodes: [], rawAttendees: [], rawOrganizer: null, rawProperties: {} },
    rawIcs: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
    recurrenceRule: null,
    startsAt: '2026-03-24T10:00:00.000Z',
    status: 'CONFIRMED',
    summary: 'Inbound event',
    timezone: 'Europe/Moscow',
    transparency: 'TRANSPARENT',
    uid: 'uid-extended',
    updatedAt: '2026-03-24T09:00:00.000Z',
    url: 'https://caldav.yandex.ru/calendars/user/default/inbound.ics',
  });

  assert.equal(draft.location, null);
  assert.equal(draft.organizer, null);
  assert.equal(draft.status, null);
  assert.equal(draft.transparency, null);
  assert.equal(draft.timezone, null);
  assert.deepEqual(draft.attendees, []);
  assert.deepEqual(draft.preserved?.deferredReasonCodes, [
    'bitrix_location_deferred',
    'bitrix_organizer_deferred',
    'bitrix_status_deferred',
    'bitrix_transparency_deferred',
    'bitrix_timezone_deferred',
    'bitrix_attendees_deferred',
  ]);
  assert.deepEqual(draft.preserved?.rawProperties, {
    location: ['Room 301'],
    organizer: ['mailto:owner@example.com'],
    status: ['CONFIRMED'],
    transparency: ['TRANSPARENT'],
    timezone: ['Europe/Moscow'],
  });
  assert.equal(draft.preserved?.rawOrganizer, 'mailto:owner@example.com');
  assert.equal(draft.preserved?.rawAttendees[0]?.email, 'guest@example.com');
});
