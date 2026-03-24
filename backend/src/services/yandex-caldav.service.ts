/*
Module: yandex-caldav.service
Role: Wraps Yandex CalDAV access for per-connection calendar discovery and event CRUD.
Source of Truth: backend/src/services/yandex-caldav.service.ts

Uses:
  tsdav:createDAVClient: true
  ../services/sqlite.service.ts:SQLiteService: true
  ../utils/transformer.ts:buildIcsEvent: true
  ../utils/transformer.ts:parseYandexCalendarObject: true

Used by:
  ../routes/onboarding.routes.ts:createOnboardingRouter: true
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
import { syncDebug, syncVerbose } from '../utils/sync-debug';

function getCalendarId(calendar: DAVCalendar): string {
  return calendar.url ?? calendar.displayName ?? 'yandex-calendar';
}

export class YandexCalDavService {
  public constructor(private readonly sqliteService: SQLiteService) {}

  public async fetchCalendars(connectionId: string): Promise<PersistedCalendar[]> {
    const client = await this.createClient(connectionId);
    const calendars = await client.fetchCalendars();

    syncDebug({
      calendars: calendars.map((calendar) => ({
        ctag: calendar.ctag ?? null,
        displayName: calendar.displayName ?? null,
        syncToken: calendar.syncToken ?? null,
        url: calendar.url ?? null,
      })),
      connectionId,
      count: calendars.length,
      phase: 'yandex.fetchCalendars.response',
    });

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

  public async listEvents(connectionId: string): Promise<YandexCalendarEvent[]> {
    const client = await this.createClient(connectionId);
    const calendar = await this.resolveSelectedCalendar(connectionId, client);
    syncDebug({
      calendarUrl: calendar.url ?? null,
      connectionId,
      displayName: calendar.displayName ?? null,
      phase: 'yandex.listEvents.request',
      useMultiGet: false,
    });

    const objects = await client.fetchCalendarObjects({
      calendar,
      urlFilter: () => true,
      useMultiGet: false,
    });

    syncDebug({
      connectionId,
      count: objects.length,
      objects: objects.map((item) => ({
        etag: item.etag ?? null,
        url: item.url,
      })),
      phase: 'yandex.listEvents.response',
    });

    syncVerbose({
      connectionId,
      objects,
      phase: 'yandex.listEvents.rawObjects',
    });

    return objects.map((item) => parseYandexCalendarObject(item.data ?? '', item.url, item.etag ?? null));
  }

  public async getSelectedCalendarCursor(connectionId: string): Promise<string | null> {
    const client = await this.createClient(connectionId);
    const calendar = await this.resolveSelectedCalendar(connectionId, client);

    return calendar.syncToken ?? calendar.ctag ?? calendar.url ?? null;
  }

  public async getEventByUrl(connectionId: string, url: string): Promise<YandexCalendarEvent | null> {
    const events = await this.listEvents(connectionId);
    return events.find((event) => event.url === url) ?? null;
  }

  public async createEvent(connectionId: string, draft: YandexCalendarDraft): Promise<YandexCalendarEvent> {
    const client = await this.createClient(connectionId);
    const calendar = await this.resolveSelectedCalendar(connectionId, client);
    const filename = `${draft.uid.replace(/[^a-zA-Z0-9_.-]/g, '-')}.ics`;
    const iCalString = buildIcsEvent(draft);
    syncDebug({
      calendarUrl: calendar.url ?? null,
      connectionId,
      draft,
      filename,
      phase: 'yandex.createEvent.request',
    });
    syncVerbose({
      calendarUrl: calendar.url ?? null,
      connectionId,
      filename,
      iCalString,
      phase: 'yandex.createEvent.ics',
    });
    const response = await client.createCalendarObject({
      calendar,
      filename,
      iCalString,
    });

    if (!response.ok) {
      const rawResponse = await this.readResponseBody(response);
      throw new Error(`Yandex CalDAV create failed with status ${response.status}. Raw response: ${rawResponse}. ICS: ${iCalString}`);
    }

    const location = response.headers.get('location');
    const createdUrl = location ? new URL(location, calendar.url ?? undefined).toString() : `${calendar.url ?? ''}${filename}`;
    syncDebug({
      connectionId,
      createdUrl,
      location,
      phase: 'yandex.createEvent.response',
      status: response.status,
    });
    const refreshed = await this.getEventByUrl(connectionId, createdUrl).catch(() => null);

    return refreshed ?? parseYandexCalendarObject(iCalString, createdUrl, response.headers.get('etag'));
  }

  public async updateEvent(connectionId: string, url: string, draft: YandexCalendarDraft): Promise<YandexCalendarEvent> {
    const client = await this.createClient(connectionId);
    const existing = await this.findCalendarObjectByUrl(connectionId, client, url);

    if (!existing) {
      throw new Error(`Yandex calendar object ${url} was not found.`);
    }

    const iCalString = buildIcsEvent(draft);
    syncDebug({
      connectionId,
      draft,
      phase: 'yandex.updateEvent.request',
      url,
    });
    syncVerbose({
      connectionId,
      iCalString,
      phase: 'yandex.updateEvent.ics',
      url,
    });
    const response = await client.updateCalendarObject({
      calendarObject: {
        ...existing,
        data: iCalString,
      },
    });

    if (!response.ok) {
      const rawResponse = await this.readResponseBody(response);
      throw new Error(`Yandex CalDAV update failed with status ${response.status}. Raw response: ${rawResponse}. ICS: ${iCalString}`);
    }

    return parseYandexCalendarObject(iCalString, existing.url, response.headers.get('etag') ?? existing.etag ?? null);
  }

  public async deleteEvent(connectionId: string, url: string): Promise<void> {
    const client = await this.createClient(connectionId);
    const existing = await this.findCalendarObjectByUrl(connectionId, client, url);

    if (!existing) {
      return;
    }

    const response = await client.deleteCalendarObject({
      calendarObject: existing,
    });

    syncDebug({
      connectionId,
      phase: 'yandex.deleteEvent.response',
      status: response.status,
      url,
    });

    if (!response.ok) {
      const rawResponse = await this.readResponseBody(response);
      throw new Error(`Yandex CalDAV delete failed with status ${response.status}. Raw response: ${rawResponse}`);
    }
  }

  private async readResponseBody(response: Response): Promise<string> {
    if (typeof response.text === 'function') {
      const body = await response.text().catch(() => '');
      return body || 'empty body';
    }

    return JSON.stringify(response);
  }

  private async createClient(connectionId: string) {
    const context = this.sqliteService.getConnectionContext(connectionId);
    if (!context) {
      throw new Error(`Connection ${connectionId} was not found.`);
    }

    const settings = context.connection;
    if (!settings.yandexBaseUrl || !settings.yandexUsername || !settings.yandexPassword) {
      throw new Error('Yandex CalDAV credentials are not configured.');
    }

    syncDebug({
      connectionId,
      phase: 'yandex.createClient',
      serverUrl: settings.yandexBaseUrl,
      username: settings.yandexUsername,
      yandexCalendarUrl: settings.yandexCalendarUrl,
    });

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

  private async resolveSelectedCalendar(connectionId: string, client: Awaited<ReturnType<typeof createDAVClient>>): Promise<DAVCalendar> {
    const context = this.sqliteService.getConnectionContext(connectionId);
    if (!context) {
      throw new Error(`Connection ${connectionId} was not found.`);
    }

    const calendars = await client.fetchCalendars();
    if (calendars.length === 0) {
      throw new Error('No Yandex calendars are available for the configured account.');
    }

    if (!context.connection.yandexCalendarUrl) {
      syncDebug({
        connectionId,
        phase: 'yandex.resolveSelectedCalendar.default',
        selectedCalendarUrl: calendars[0].url ?? null,
      });
      return calendars[0];
    }

    const selected = calendars.find((calendar) => calendar.url === context.connection.yandexCalendarUrl) ?? calendars[0];
    syncDebug({
      configuredCalendarUrl: context.connection.yandexCalendarUrl,
      connectionId,
      phase: 'yandex.resolveSelectedCalendar.selected',
      selectedCalendarUrl: selected.url ?? null,
    });
    return selected;
  }

  private async findCalendarObjectByUrl(connectionId: string, client: Awaited<ReturnType<typeof createDAVClient>>, url: string): Promise<DAVCalendarObject | null> {
    const calendar = await this.resolveSelectedCalendar(connectionId, client);
    const objects = await client.fetchCalendarObjects({
      calendar,
      objectUrls: [url],
      urlFilter: () => true,
      useMultiGet: false,
    });

    syncDebug({
      connectionId,
      count: objects.length,
      phase: 'yandex.findObjectByUrl.response',
      requestedUrl: url,
      returnedUrls: objects.map((item) => item.url),
    });

    return objects.find((item) => item.url === url) ?? null;
  }
}
