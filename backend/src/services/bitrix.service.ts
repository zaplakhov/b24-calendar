/*
Module: bitrix.service
Role: Wraps the Bitrix24 REST webhook surface for calendar reads and mutations used by the sync MVP.
Source of Truth: backend/src/services/bitrix.service.ts

Uses:
  ../services/sqlite.service.ts:SQLiteService: true
  ../utils/transformer.ts:BitrixCalendarEvent: true

Used by:
  ../routes/settings.routes.ts:createSettingsRouter: true
  ../services/sync.service.ts:SyncService: true

Glossary: none
*/

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
  public constructor(private readonly sqliteService: SQLiteService) {}

  public async fetchCalendars(): Promise<PersistedCalendar[]> {
    const result = await this.call<unknown[]>('calendar.section.get', {
      type: 'user',
    });

    return (Array.isArray(result) ? result : []).map((item) => {
      const payload = typeof item === 'object' && item ? (item as Record<string, unknown>) : {};
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

  public async listEventsSince(since: string | null): Promise<BitrixCalendarEvent[]> {
    const settings = this.sqliteService.getSettings();
    const result = await this.call<unknown[]>('calendar.event.list', {
      filter: {
        from: since,
        section: settings.bitrixCalendarId || undefined,
      },
      type: 'user',
    });

    return (Array.isArray(result) ? result : []).map((item) => normalizeBitrixEvent((item ?? {}) as BitrixPayload));
  }

  public async fetchEventById(eventId: string): Promise<BitrixCalendarEvent | null> {
    const result = await this.call<unknown>('calendar.event.get', {
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

  public async createEvent(draft: BitrixCalendarDraft): Promise<BitrixCalendarEvent> {
    const settings = this.sqliteService.getSettings();
    const result = await this.call<unknown>('calendar.event.add', {
      type: 'user',
      ownerId: settings.bitrixUserId || undefined,
      section: settings.bitrixCalendarId || undefined,
      name: draft.title,
      description: draft.description ?? '',
      from: draft.startsAt,
      to: draft.endsAt,
      skipTime: draft.isAllDay ? 'Y' : 'N',
    });

    if (typeof result === 'number' || typeof result === 'string') {
      const event = await this.fetchEventById(String(result));
      if (event) {
        return event;
      }
    }

    return normalizeBitrixEvent((result ?? {}) as BitrixPayload);
  }

  public async updateEvent(eventId: string, draft: BitrixCalendarDraft): Promise<BitrixCalendarEvent> {
    await this.call('calendar.event.update', {
      id: eventId,
      name: draft.title,
      description: draft.description ?? '',
      from: draft.startsAt,
      to: draft.endsAt,
      skipTime: draft.isAllDay ? 'Y' : 'N',
    });

    const refreshed = await this.fetchEventById(eventId);
    if (!refreshed) {
      throw new Error(`Bitrix event ${eventId} was not returned after update.`);
    }

    return refreshed;
  }

  public async deleteEvent(eventId: string): Promise<void> {
    await this.call('calendar.event.delete', {
      id: eventId,
    });
  }

  public normalizeWebhookEvent(payload: Record<string, unknown>): BitrixCalendarEvent {
    return normalizeBitrixEvent(payload);
  }

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const settings = this.sqliteService.getSettings();

    if (!settings.bitrixWebhookUrl) {
      throw new Error('Bitrix webhook URL is not configured.');
    }

    const baseUrl = settings.bitrixWebhookUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/${method}.json`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Bitrix request failed with status ${response.status} for ${method}.`);
    }

    const envelope = (await response.json()) as BitrixResponseEnvelope<T>;
    if (envelope.error) {
      throw new Error(envelope.error_description ?? envelope.error);
    }

    return envelope.result as T;
  }
}
