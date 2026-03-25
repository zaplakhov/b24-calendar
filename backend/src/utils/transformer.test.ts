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

test('transformer parses Bitrix local datetime format with timezone', () => {
  const event = buildBitrixEventFromRaw({
    DATE_FROM: '27.03.2026 10:00:00',
    DATE_TO: '27.03.2026 11:00:00',
    ID: 'local-format',
    NAME: 'Local format',
    SECT_ID: 'calendar-1',
    TZ_FROM: 'Europe/Moscow',
  });

  assert.equal(event.startsAt, '2026-03-27T07:00:00.000Z');
  assert.equal(event.endsAt, '2026-03-27T08:00:00.000Z');
  const result = normalizeBitrixEventForSync(event, 'calendar-1');
  assert.equal(result.ok, true);
});

test('transformer falls back to Bitrix *_TS_UTC values for invalid date strings', () => {
  const event = buildBitrixEventFromRaw({
    DATE_FROM: '',
    DATE_FROM_TS_UTC: '1715166000',
    DATE_TO: null,
    DATE_TO_TS_UTC: '1715167800',
    ID: 'ts-fallback',
    NAME: 'Fallback format',
    SECT_ID: 'calendar-1',
  });

  assert.equal(event.startsAt, '2024-05-08T11:00:00.000Z');
  assert.equal(event.endsAt, '2024-05-08T11:30:00.000Z');
  const result = normalizeBitrixEventForSync(event, 'calendar-1');
  assert.equal(result.ok, true);
});

test('transformer parses Bitrix attendees from ATTENDEE_LIST and attendeesEntityList', () => {
  const event = buildBitrixEventFromRaw({
    ATTENDEE_LIST: [
      { EMAIL: 'alice@example.com', NAME: 'Alice', STATUS: 'accepted' },
      { EMAIL: 'bob@example.com', NAME: 'Bob', STATUS: 'tentative' },
    ],
    DATE_FROM: '27.03.2026 10:00:00',
    DATE_TO: '27.03.2026 11:00:00',
    ID: 'attendees-from-list',
    NAME: 'Attendees test',
    SECT_ID: 'calendar-1',
    TZ_FROM: 'Europe/Moscow',
    attendeesEntityList: [
      { EMAIL: 'alice@example.com', NAME: 'Alice' },
      { EMAIL: 'bob@example.com', NAME: 'Bob' },
    ],
  });

  assert.equal(event.attendees.length, 2);
  assert.equal(event.attendees[0]?.email, 'alice@example.com');
  assert.equal(event.attendees[1]?.email, 'bob@example.com');
  assert.equal(event.attendees[0]?.name, 'Alice');
});

test('transformer resolves human-readable Bitrix location from attendeesEntityList', () => {
  const event = buildBitrixEventFromRaw({
    ATTENDEE_LIST: [
      { CALENDAR_ID: '14355', NAME: 'Переговорка 7A' },
    ],
    DATE_FROM: '27.03.2026 10:00:00',
    DATE_TO: '27.03.2026 11:00:00',
    ID: 'location-readable',
    LOCATION: 'calendar_3_14355',
    NAME: 'Location test',
    SECT_ID: 'calendar-1',
    TZ_FROM: 'Europe/Moscow',
    attendeesEntityList: [
      { ID: '14355', NAME: 'Переговорка 7A' },
    ],
  });

  assert.equal(event.location, 'Переговорка 7A');
});

test('transformer preserves multiline description when building ICS', () => {
  const bitrixEvent = buildBitrixEventFromRaw({
    DATE_FROM: '2026-03-27T10:00:00Z',
    DATE_TO: '2026-03-27T11:00:00Z',
    DESCRIPTION: 'строка 1\r\nстрока 2\nстрока 3',
    ID: 'multiline-description',
    NAME: 'Multiline description',
    SECT_ID: 'calendar-1',
  });

  const draft = transformBitrixEventToYandexDraft(bitrixEvent);
  const parsed = parseYandexCalendarObject(buildIcsEvent(draft), 'https://caldav.yandex.ru/multiline.ics', 'etag-multiline');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  assert.equal(parsed.value.description, 'строка 1\nстрока 2\nстрока 3');
});

test('transformer appends attendee fallback line when email is missing', () => {
  const bitrixEvent = buildBitrixEventFromRaw({
    ATTENDEE_LIST: [
      { EMAIL: 'with-email@example.com', NAME: 'With Email' },
      { NAME: 'Без почты' },
    ],
    DATE_FROM: '2026-03-27T10:00:00Z',
    DATE_TO: '2026-03-27T11:00:00Z',
    DESCRIPTION: 'Базовое описание',
    ID: 'attendee-fallback',
    NAME: 'Attendee fallback',
    SECT_ID: 'calendar-1',
  });

  const draft = transformBitrixEventToYandexDraft(bitrixEvent);
  assert.equal(draft.attendees.length, 1);
  assert.equal(draft.attendees[0]?.email, 'with-email@example.com');
  assert.equal(draft.description, 'Базовое описание\nУчастник: Без почты');
});

test('transformer maps Bitrix attendee statuses to valid ICS PARTSTAT values', () => {
  const event = buildBitrixEventFromRaw({
    ATTENDEE_LIST: [
      { EMAIL: 'host@example.com', NAME: 'Host', status: 'H' },
      { EMAIL: 'accepted@example.com', NAME: 'Accepted', status: 'Y' },
      { EMAIL: 'invited@example.com', NAME: 'Invited', status: 'Q' },
      { EMAIL: 'declined@example.com', NAME: 'Declined', status: 'N' },
    ],
    DATE_FROM: '2026-03-27T10:00:00Z',
    DATE_TO: '2026-03-27T11:00:00Z',
    ID: 'attendee-status-map',
    NAME: 'Status map',
    SECT_ID: 'calendar-1',
  });

  const parsed = parseYandexCalendarObject(buildIcsEvent(transformBitrixEventToYandexDraft(event)), 'https://caldav.yandex.ru/status-map.ics', 'etag-status-map');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  const map = new Map(parsed.value.attendees.map((attendee) => [attendee.email, attendee.partstat]));
  assert.equal(map.get('host@example.com'), 'ACCEPTED');
  assert.equal(map.get('accepted@example.com'), 'ACCEPTED');
  assert.equal(map.get('invited@example.com'), 'NEEDS-ACTION');
  assert.equal(map.get('declined@example.com'), 'DECLINED');
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

test('transformer ignores VTIMEZONE recurrence rules for single Yandex events', () => {
  const parsed = parseYandexCalendarObject([
    'BEGIN:VCALENDAR',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Moscow',
    'BEGIN:STANDARD',
    'RRULE:FREQ=YEARLY;UNTIL=20101030T230000Z;BYMONTH=10;BYDAY=-1SU',
    'DTSTART:20100328T020000',
    'TZOFFSETFROM:+0400',
    'TZOFFSETTO:+0300',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:event-vtimezone',
    'SUMMARY:Single event with timezone rules',
    'DTSTAMP:20260324T184738Z',
    'DTSTART;TZID=Europe/Moscow:20260115T130000',
    'DTEND;TZID=Europe/Moscow:20260115T140000',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n'), 'https://caldav.yandex.ru/timezone-single.ics', 'etag-vtimezone');

  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  assert.equal(parsed.value.uid, 'event-vtimezone');
  assert.equal(parsed.value.recurrenceRule, null);
  assert.equal(parsed.value.timezone, 'Europe/Moscow');
  assert.equal(parsed.value.startsAt, '2026-01-15T10:00:00.000Z');
  assert.equal(parsed.value.endsAt, '2026-01-15T11:00:00.000Z');
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
