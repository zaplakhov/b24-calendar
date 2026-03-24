/*
Module: bitrix.service
Role: Wraps the Bitrix24 REST API for scoped calendar reads and mutations in OAuth-based local app mode.
Source of Truth: backend/src/services/bitrix.service.ts

Uses:
  ./sqlite.service.ts:SQLiteService: true
  ./bitrix-auth.service.ts:BitrixAuthService: true
  ../utils/transformer.ts:buildBitrixEventFromRaw: true

Used by:
  ../routes/onboarding.routes.ts:createOnboardingRouter: true
  ../services/sync.service.ts:SyncService: true

Glossary: none
*/

import { BitrixAuthService } from './bitrix-auth.service';
import { SQLiteService, type PersistedCalendar } from './sqlite.service';
import { buildBitrixEventFromRaw, type BitrixCalendarDraft, type BitrixCalendarEvent } from '../utils/transformer';
import { syncDebug, syncVerbose } from '../utils/sync-debug';

interface BitrixResponseEnvelope<T> {
  result?: T;
  error?: string;
  error_description?: string;
}

type BitrixPayload = Record<string, unknown>;

function buildFallbackBitrixEvent(eventId: string, draft: BitrixCalendarDraft, calendarId: string | null): BitrixCalendarEvent {
  const timestamp = new Date().toISOString();

  return {
    id: eventId,
    calendarId,
    title: draft.title,
    description: draft.description,
    startsAt: draft.startsAt,
    endsAt: draft.endsAt,
    timezone: null,
    isAllDay: draft.isAllDay,
    updatedAt: timestamp,
    deleted: false,
    recurrenceRule: null,
    location: draft.location ?? null,
    organizer: draft.organizer ?? null,
    status: draft.status ?? null,
    transparency: draft.transparency ?? null,
    attendees: draft.attendees ?? [],
    preserved: draft.preserved ?? { deferredReasonCodes: [], rawAttendees: [], rawOrganizer: null, rawProperties: {} },
    raw: {
      ID: eventId,
      NAME: draft.title,
      DESCRIPTION: draft.description ?? '',
      DATE_FROM: draft.startsAt,
      DATE_TO: draft.endsAt,
      SECT_ID: calendarId,
      TIMESTAMP_X: timestamp,
    },
  };
}

export class BitrixService {
  public constructor(
    private readonly sqliteService: SQLiteService,
    private readonly bitrixAuthService: BitrixAuthService,
  ) {}

  public async fetchCalendars(connectionId: string): Promise<PersistedCalendar[]> {
    const context = this.sqliteService.getConnectionContext(connectionId);
    if (!context) {
      throw new Error(`Connection ${connectionId} was not found.`);
    }

    syncDebug({
      connectionId,
      ownerId: Number(context.connection.bitrixUserId),
      phase: 'bitrix.fetchCalendars.request',
      selectedCalendarId: context.connection.bitrixCalendarId || null,
      type: 'user',
    });

    const result = await this.call<unknown[]>(connectionId, 'calendar.section.get', {
      ownerId: Number(context.connection.bitrixUserId),
      type: 'user',
    });

    syncDebug({
      calendars: (Array.isArray(result) ? result : []).map((item) => {
        const payload = typeof item === 'object' && item ? item as Record<string, unknown> : {};
        return {
          id: payload.ID ?? payload.id ?? null,
          name: payload.NAME ?? payload.name ?? null,
          ownerId: payload.OWNER_ID ?? null,
          type: payload.CAL_TYPE ?? null,
        };
      }),
      connectionId,
      count: Array.isArray(result) ? result.length : 0,
      phase: 'bitrix.fetchCalendars.response',
    });

    return (Array.isArray(result) ? result : []).map((item) => {
      const payload = typeof item === 'object' && item ? item as Record<string, unknown> : {};
      const id = String(payload.ID ?? payload.id ?? '');

      return {
        provider: 'bitrix' as const,
        id,
        name: String(payload.NAME ?? payload.name ?? `Bitrix calendar ${id}`),
        color: payload.COLOR ? String(payload.COLOR) : null,
        url: null,
        payload,
      };
    });
  }

  public async listEventsSince(connectionId: string, since: string | null): Promise<BitrixCalendarEvent[]> {
    const context = this.sqliteService.getConnectionContext(connectionId);
    if (!context) {
      throw new Error(`Connection ${connectionId} was not found.`);
    }

    const from = since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    syncDebug({
      connectionId,
      from,
      ownerId: Number(context.connection.bitrixUserId),
      phase: 'bitrix.listEvents.request',
      section: context.connection.bitrixCalendarId ? [Number(context.connection.bitrixCalendarId)] : [],
      to,
      type: 'user',
    });

    const result = await this.call<unknown[]>(connectionId, 'calendar.event.get', {
      from,
      ownerId: Number(context.connection.bitrixUserId),
      section: context.connection.bitrixCalendarId ? [Number(context.connection.bitrixCalendarId)] : undefined,
      to,
      type: 'user',
    });

    syncDebug({
      connectionId,
      count: Array.isArray(result) ? result.length : 0,
      events: (Array.isArray(result) ? result : []).map((item) => {
        const payload = (item ?? {}) as BitrixPayload;
        return {
          end: payload.DATE_TO ?? payload.dateTo ?? payload.to ?? null,
          id: payload.ID ?? payload.id ?? null,
          sectionId: payload.SECT_ID ?? payload.sectionId ?? null,
          skipTime: payload.SKIP_TIME ?? payload.skipTime ?? null,
          start: payload.DATE_FROM ?? payload.dateFrom ?? payload.from ?? null,
          title: payload.NAME ?? payload.name ?? null,
        };
      }),
      phase: 'bitrix.listEvents.response',
      selectedCalendarId: context.connection.bitrixCalendarId || null,
    });

    syncVerbose({
      connectionId,
      phase: 'bitrix.listEvents.rawResponse',
      result,
    });

     return (Array.isArray(result) ? result : []).map((item) => buildBitrixEventFromRaw((item ?? {}) as BitrixPayload));
  }

  public async fetchEventById(connectionId: string, eventId: string): Promise<BitrixCalendarEvent | null> {
    syncDebug({
      connectionId,
      eventId,
      phase: 'bitrix.fetchEventById.request',
    });

    const result = await this.call<unknown>(connectionId, 'calendar.event.getbyid', {
      id: eventId,
    });

    syncVerbose({
      connectionId,
      eventId,
      phase: 'bitrix.fetchEventById.response',
      result,
    });

    if (!result) {
      return null;
    }

    if (Array.isArray(result)) {
       return result.length > 0 ? buildBitrixEventFromRaw((result[0] ?? {}) as BitrixPayload) : null;
    }

    return buildBitrixEventFromRaw(result as BitrixPayload);
  }

  public async createEvent(connectionId: string, draft: BitrixCalendarDraft): Promise<BitrixCalendarEvent> {
    const context = this.sqliteService.getConnectionContext(connectionId);
    if (!context) {
      throw new Error(`Connection ${connectionId} was not found.`);
    }

    const result = await this.call<unknown>(connectionId, 'calendar.event.add', {
      type: 'user',
      ownerId: Number(context.connection.bitrixUserId),
      section: context.connection.bitrixCalendarId ? Number(context.connection.bitrixCalendarId) : undefined,
      name: draft.title,
      description: draft.description ?? '',
      from: draft.startsAt,
      to: draft.endsAt,
      skipTime: draft.isAllDay ? 'Y' : 'N',
    });

    syncDebug({
      connectionId,
      draft,
      phase: 'bitrix.createEvent.response',
      result,
      selectedCalendarId: context.connection.bitrixCalendarId || null,
    });

    if (typeof result === 'number' || typeof result === 'string') {
      try {
        const event = await this.fetchEventById(connectionId, String(result));
        if (event) {
          return event;
        }
      } catch {
        return buildFallbackBitrixEvent(String(result), draft, context.connection.bitrixCalendarId || null);
      }

      return buildFallbackBitrixEvent(String(result), draft, context.connection.bitrixCalendarId || null);
    }

    return buildBitrixEventFromRaw((result ?? {}) as BitrixPayload);
  }

  public async updateEvent(connectionId: string, eventId: string, draft: BitrixCalendarDraft): Promise<BitrixCalendarEvent> {
    const context = this.sqliteService.getConnectionContext(connectionId);
    if (!context) {
      throw new Error(`Connection ${connectionId} was not found.`);
    }

    await this.call(connectionId, 'calendar.event.update', {
      id: eventId,
      type: 'user',
      ownerId: Number(context.connection.bitrixUserId),
      section: context.connection.bitrixCalendarId ? Number(context.connection.bitrixCalendarId) : undefined,
      name: draft.title,
      description: draft.description ?? '',
      from: draft.startsAt,
      to: draft.endsAt,
      skipTime: draft.isAllDay ? 'Y' : 'N',
    });

    syncDebug({
      connectionId,
      draft,
      eventId,
      phase: 'bitrix.updateEvent.completed',
      selectedCalendarId: context.connection.bitrixCalendarId || null,
    });

    try {
      const refreshed = await this.fetchEventById(connectionId, eventId);
      if (refreshed) {
        return refreshed;
      }
    } catch {
      return buildFallbackBitrixEvent(eventId, draft, context.connection.bitrixCalendarId || null);
    }

    return buildFallbackBitrixEvent(eventId, draft, context.connection.bitrixCalendarId || null);
  }

  public async deleteEvent(connectionId: string, eventId: string): Promise<void> {
    await this.call(connectionId, 'calendar.event.delete', {
      id: eventId,
    });

    syncDebug({
      connectionId,
      eventId,
      phase: 'bitrix.deleteEvent.completed',
    });
  }

  public normalizeWebhookEvent(payload: Record<string, unknown>): BitrixCalendarEvent {
    return buildBitrixEventFromRaw(payload);
  }

  private async call<T>(connectionId: string, method: string, payload: Record<string, unknown>, allowRefreshRetry = true): Promise<T> {
    const context = this.sqliteService.getConnectionContext(connectionId);
    if (!context) {
      throw new Error(`Connection ${connectionId} was not found.`);
    }

    const accessToken = await this.bitrixAuthService.getValidAccessToken(context.installation.id);
    syncDebug({
      connectionId,
      method,
      payload,
      phase: 'bitrix.call.request',
      portalHost: context.installation.portalHost,
    });

    const response = await fetch(`https://${context.installation.portalHost}/rest/${method}.json`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...payload,
        auth: accessToken,
      }),
    });

    const envelope = (await response.json()) as BitrixResponseEnvelope<T>;
    syncVerbose({
      connectionId,
      envelope,
      method,
      phase: 'bitrix.call.response',
      status: response.status,
    });
    if (response.status === 503 && allowRefreshRetry) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return this.call<T>(connectionId, method, payload, false);
    }

    if ((!response.ok || envelope.error) && allowRefreshRetry && this.isRefreshableBitrixError(response.status, envelope.error)) {
      await this.bitrixAuthService.refreshInstallationAuth(context.installation);
      return this.call<T>(connectionId, method, payload, false);
    }

    if (!response.ok) {
      throw new Error(`Bitrix request failed with status ${response.status} for ${method}.`);
    }

    if (envelope.error) {
      throw new Error(envelope.error_description ?? envelope.error);
    }

    return envelope.result as T;
  }

  private isRefreshableBitrixError(statusCode: number, errorCode: string | undefined): boolean {
    if (statusCode === 401) {
      return true;
    }

    const normalized = (errorCode ?? '').toLowerCase();
    return normalized.includes('expired') || normalized.includes('invalid_token') || normalized.includes('token');
  }
}
