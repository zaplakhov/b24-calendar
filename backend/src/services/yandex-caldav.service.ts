/*
Module: yandex-caldav.service
Role: Wraps Yandex CalDAV access for calendar discovery and event CRUD used by the sync MVP.
Source of Truth: backend/src/services/yandex-caldav.service.ts

Uses:
  tsdav:createDAVClient: true
  ../services/sqlite.service.ts:SQLiteService: true
  ../utils/transformer.ts:buildIcsEvent: true
  ../utils/transformer.ts:parseYandexCalendarObject: true

Used by:
  ../routes/settings.routes.ts:createSettingsRouter: true
  ../services/sync.service.ts:SyncService: true

Glossary: none
*/

import { createDAVClient, type DAVCalendar, type DAVCalendarObject } from 'tsdav';

import { SQLiteService, type PersistedCalendar } from './sqlite.service';
import {
  buildIcsEvent,
  parseYandexCalendarObject,
  type YandexCalendarDraft,
  type YandexCalendarEvent,
} from '../utils/transformer';

function getCalendarId(calendar: DAVCalendar): string {
  return calendar.url ?? calendar.displayName ?? 'yandex-calendar';
}

export class YandexCalDavService {
  public constructor(private readonly sqliteService: SQLiteService) {}

  public async fetchCalendars(): Promise<PersistedCalendar[]> {
    const client = await this.createClient();
    const calendars = await client.fetchCalendars();

    return calendars.map((calendar) => ({
      provider: 'yandex' as const,
      id: getCalendarId(calendar),
      name: typeof calendar.displayName === 'string' ? calendar.displayName : 'Yandex calendar',
      color: calendar.calendarColor ?? null,
      url: calendar.url ?? null,
      payload: {
        components: calendar.components ?? [],
        ctag: calendar.ctag ?? null,
        syncToken: calendar.syncToken ?? null,
      },
    }));
  }

  public async listEvents(): Promise<YandexCalendarEvent[]> {
    const client = await this.createClient();
    const calendar = await this.resolveSelectedCalendar(client);
    const objects = await client.fetchCalendarObjects({
      calendar,
    });

    return objects.map((item) => parseYandexCalendarObject(item.data ?? '', item.url, item.etag ?? null));
  }

  public async getSelectedCalendarCursor(): Promise<string | null> {
    const client = await this.createClient();
    const calendar = await this.resolveSelectedCalendar(client);

    return calendar.syncToken ?? calendar.ctag ?? calendar.url ?? null;
  }

  public async getEventByUrl(url: string): Promise<YandexCalendarEvent | null> {
    const events = await this.listEvents();
    return events.find((event) => event.url === url) ?? null;
  }

  public async createEvent(draft: YandexCalendarDraft): Promise<YandexCalendarEvent> {
    const client = await this.createClient();
    const calendar = await this.resolveSelectedCalendar(client);
    const filename = `${draft.uid.replace(/[^a-zA-Z0-9_.-]/g, '-')}.ics`;
    const response = await client.createCalendarObject({
      calendar,
      filename,
      iCalString: buildIcsEvent(draft),
    });

    if (!response.ok) {
      throw new Error(`Yandex CalDAV create failed with status ${response.status}.`);
    }

    const location = response.headers.get('location');
    const createdUrl = location ? new URL(location, calendar.url ?? undefined).toString() : `${calendar.url ?? ''}${filename}`;
    const refreshed = await this.getEventByUrl(createdUrl);

    return refreshed ?? parseYandexCalendarObject(buildIcsEvent(draft), createdUrl, response.headers.get('etag'));
  }

  public async updateEvent(url: string, draft: YandexCalendarDraft): Promise<YandexCalendarEvent> {
    const client = await this.createClient();
    const existing = await this.findCalendarObjectByUrl(url);

    if (!existing) {
      throw new Error(`Yandex calendar object ${url} was not found.`);
    }

    const response = await client.updateCalendarObject({
      calendarObject: {
        ...existing,
        data: buildIcsEvent(draft),
      },
    });

    if (!response.ok) {
      throw new Error(`Yandex CalDAV update failed with status ${response.status}.`);
    }

    return parseYandexCalendarObject(buildIcsEvent(draft), existing.url, response.headers.get('etag') ?? existing.etag ?? null);
  }

  public async deleteEvent(url: string): Promise<void> {
    const client = await this.createClient();
    const existing = await this.findCalendarObjectByUrl(url);

    if (!existing) {
      return;
    }

    const response = await client.deleteCalendarObject({
      calendarObject: existing,
    });

    if (!response.ok) {
      throw new Error(`Yandex CalDAV delete failed with status ${response.status}.`);
    }
  }

  private async createClient() {
    const settings = this.sqliteService.getSettings();

    if (!settings.yandexBaseUrl || !settings.yandexUsername || !settings.yandexPassword) {
      throw new Error('Yandex CalDAV credentials are not configured.');
    }

    return createDAVClient({
      authMethod: 'Basic',
      credentials: {
        password: settings.yandexPassword,
        username: settings.yandexUsername,
      },
      defaultAccountType: 'caldav',
      serverUrl: settings.yandexBaseUrl,
    });
  }

  private async resolveSelectedCalendar(client: Awaited<ReturnType<typeof createDAVClient>>): Promise<DAVCalendar> {
    const settings = this.sqliteService.getSettings();
    const calendars = await client.fetchCalendars();

    if (calendars.length === 0) {
      throw new Error('No Yandex calendars are available for the configured account.');
    }

    if (!settings.yandexCalendarUrl) {
      return calendars[0];
    }

    return calendars.find((calendar) => calendar.url === settings.yandexCalendarUrl) ?? calendars[0];
  }

  private async findCalendarObjectByUrl(url: string): Promise<DAVCalendarObject | null> {
    const client = await this.createClient();
    const calendar = await this.resolveSelectedCalendar(client);
    const objects = await client.fetchCalendarObjects({
      calendar,
      objectUrls: [url],
      useMultiGet: true,
    });

    return objects.find((item) => item.url === url) ?? null;
  }
}
