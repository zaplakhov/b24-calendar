/*
Module: bitrix.service
Role: Wraps the Bitrix24 REST API for scoped calendar reads and mutations in OAuth-based local app mode.
Source of Truth: backend/src/services/bitrix.service.ts

Uses:
  ./sqlite.service.ts:SQLiteService: true
  ./bitrix-auth.service.ts:BitrixAuthService: true
  ../utils/transformer.ts:BitrixCalendarEvent: true

Used by:
  ../routes/onboarding.routes.ts:createOnboardingRouter: true
  ../services/sync.service.ts:SyncService: true

Glossary: none
*/

import { BitrixAuthService } from './bitrix-auth.service';
import { SQLiteService, type PersistedCalendar } from './sqlite.service';
import type { BitrixCalendarDraft, BitrixCalendarEvent } from '../utils/transformer';

interface BitrixResponseEnvelope<T> {
  result?: T;
  error?: string;
  error_description?: string;
}

type BitrixPayload = Record<string, unknown>;

function normalizeIsoDate(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
}

function normalizeBitrixEvent(payload: BitrixPayload): BitrixCalendarEvent {
  const id = String(payload.ID ?? payload.id ?? '');

  return {
    id,
    calendarId: payload.SECT_ID ? String(payload.SECT_ID) : payload.sectionId ? String(payload.sectionId) : null,
    title: String(payload.NAME ?? payload.name ?? 'Untitled Bitrix event'),
    description: payload.DESCRIPTION ? String(payload.DESCRIPTION) : payload.description ? String(payload.description) : null,
    startsAt: normalizeIsoDate(payload.DATE_FROM ?? payload.dateFrom ?? payload.from),
    endsAt: normalizeIsoDate(payload.DATE_TO ?? payload.dateTo ?? payload.to),
    timezone: payload.TZ_FROM ? String(payload.TZ_FROM) : payload.timezone ? String(payload.timezone) : null,
    isAllDay: String(payload.SKIP_TIME ?? payload.skipTime ?? 'N').toUpperCase() === 'Y',
    updatedAt: payload.TIMESTAMP_X ? normalizeIsoDate(payload.TIMESTAMP_X) : payload.updatedAt ? normalizeIsoDate(payload.updatedAt) : null,
    deleted: false,
    recurrenceRule: payload.RRULE ? String(payload.RRULE) : payload.rrule ? String(payload.rrule) : null,
    raw: payload,
  };
}

export class BitrixService {
  public constructor(
    private readonly sqliteService: SQLiteService,
    private readonly bitrixAuthService: BitrixAuthService,
  ) {}

  public async fetchCalendars(connectionId: string): Promise<PersistedCalendar[]> {
    const result = await this.call<unknown[]>(connectionId, 'calendar.section.get', {
      type: 'user',
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

    const result = await this.call<unknown[]>(connectionId, 'calendar.event.get', {
      from,
      ownerId: Number(context.connection.bitrixUserId),
      section: context.connection.bitrixCalendarId ? [Number(context.connection.bitrixCalendarId)] : undefined,
      to,
      type: 'user',
    });

    return (Array.isArray(result) ? result : []).map((item) => normalizeBitrixEvent((item ?? {}) as BitrixPayload));
  }

  public async fetchEventById(connectionId: string, eventId: string): Promise<BitrixCalendarEvent | null> {
    const result = await this.call<unknown>(connectionId, 'calendar.event.getbyid', {
      id: eventId,
    });

    if (!result) {
      return null;
    }

    if (Array.isArray(result)) {
      return result.length > 0 ? normalizeBitrixEvent((result[0] ?? {}) as BitrixPayload) : null;
    }

    return normalizeBitrixEvent(result as BitrixPayload);
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

    if (typeof result === 'number' || typeof result === 'string') {
      const event = await this.fetchEventById(connectionId, String(result));
      if (event) {
        return event;
      }
    }

    return normalizeBitrixEvent((result ?? {}) as BitrixPayload);
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

    const refreshed = await this.fetchEventById(connectionId, eventId);
    if (!refreshed) {
      throw new Error(`Bitrix event ${eventId} was not returned after update.`);
    }

    return refreshed;
  }

  public async deleteEvent(connectionId: string, eventId: string): Promise<void> {
    await this.call(connectionId, 'calendar.event.delete', {
      id: eventId,
    });
  }

  public normalizeWebhookEvent(payload: Record<string, unknown>): BitrixCalendarEvent {
    return normalizeBitrixEvent(payload);
  }

  private async call<T>(connectionId: string, method: string, payload: Record<string, unknown>, allowRefreshRetry = true): Promise<T> {
    const context = this.sqliteService.getConnectionContext(connectionId);
    if (!context) {
      throw new Error(`Connection ${connectionId} was not found.`);
    }

    const accessToken = await this.bitrixAuthService.getValidAccessToken(context.installation.id);
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
