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
import { buildBitrixEventFromRaw, type BitrixCalendarDraft, type BitrixCalendarEvent, type EventAttendee } from '../utils/transformer';
import { syncDebug, syncVerbose } from '../utils/sync-debug';

interface BitrixResponseEnvelope<T> {
  result?: T;
  error?: string;
  error_description?: string;
}

interface BitrixCallRetryState {
  allowRefreshRetry: boolean;
  rateLimitAttempt: number;
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
  private static readonly RATE_LIMIT_MAX_RETRIES = 4;
  private static readonly RESOURCE_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly USER_CACHE_TTL_MS = 5 * 60 * 1000;

  private readonly resourceNameCache = new Map<string, { expiresAt: number; values: Map<string, string> }>();
  private readonly userDirectoryCache = new Map<string, { expiresAt: number; values: Map<string, EventAttendee> }>();

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

    const mappedEvents = (Array.isArray(result) ? result : []).map((item) => buildBitrixEventFromRaw((item ?? {}) as BitrixPayload));
    await this.enrichEventMetadata(connectionId, mappedEvents);
    return mappedEvents;
  }

  private async enrichEventMetadata(connectionId: string, events: BitrixCalendarEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await Promise.all([
      this.enrichResourceLocations(connectionId, events),
      this.enrichEventAttendees(connectionId, events),
    ]);
  }

  private async enrichResourceLocations(connectionId: string, events: BitrixCalendarEvent[]): Promise<void> {
    const codedLocations = events
      .map((event) => event.location)
      .filter((location): location is string => Boolean(location && /^calendar_\d+_\d+$/i.test(location)));
    if (codedLocations.length === 0) {
      return;
    }

    const resourceMap = await this.getResourceNameMap(connectionId);
    for (const event of events) {
      const location = event.location;
      if (!location) {
        continue;
      }

      const locationMatch = location.match(/^calendar_\d+_(\d+)$/i);
      if (!locationMatch) {
        continue;
      }

      const resourceName = resourceMap.get(locationMatch[1]);
      if (resourceName) {
        event.location = resourceName;
      } else if (/^calendar_3_\d+$/i.test(location)) {
        event.location = 'Видеозвонок Б24';
      }
    }
  }

  private async enrichEventAttendees(connectionId: string, events: BitrixCalendarEvent[]): Promise<void> {
    const attendeeIds = new Set<string>();
    for (const event of events) {
      for (const attendee of this.extractRawAttendees(event.raw)) {
        attendeeIds.add(attendee);
      }
    }

    if (attendeeIds.size === 0) {
      return;
    }

    const userDirectory = await this.getUserDirectory(connectionId, [...attendeeIds]);
    for (const event of events) {
      const merged = new Map<string, EventAttendee>();
      for (const attendee of event.attendees) {
        const key = attendee.email ?? `${attendee.name ?? ''}|${attendee.partstat ?? ''}|${attendee.role ?? ''}`;
        merged.set(key, attendee);
      }

      for (const id of this.extractRawAttendees(event.raw)) {
        const resolved = userDirectory.get(id);
        if (!resolved) {
          continue;
        }

        const key = resolved.email ?? `${resolved.name ?? ''}|${resolved.partstat ?? ''}|${resolved.role ?? ''}`;
        if (!merged.has(key)) {
          merged.set(key, {
            ...resolved,
            partstat: this.resolveAttendeeStatusFromRaw(event.raw, id) ?? resolved.partstat,
          });
        }
      }

      event.attendees = [...merged.values()];
    }
  }

  private extractRawAttendees(raw: Record<string, unknown>): string[] {
    const ids = new Set<string>();
    const attendeeList = Array.isArray(raw.ATTENDEE_LIST) ? raw.ATTENDEE_LIST : [];
    for (const item of attendeeList) {
      const payload = typeof item === 'object' && item ? item as Record<string, unknown> : null;
      const id = payload?.id == null ? null : String(payload.id);
      if (id) {
        ids.add(id);
      }
    }

    const entities = Array.isArray(raw.attendeesEntityList) ? raw.attendeesEntityList : [];
    for (const entity of entities) {
      const payload = typeof entity === 'object' && entity ? entity as Record<string, unknown> : null;
      const entityType = payload?.entityId == null ? null : String(payload.entityId).toLowerCase();
      const id = payload?.id == null ? null : String(payload.id);
      if (entityType === 'user' && id) {
        ids.add(id);
      }
    }

    return [...ids];
  }

  private resolveAttendeeStatusFromRaw(raw: Record<string, unknown>, attendeeId: string): string | null {
    const attendeeList = Array.isArray(raw.ATTENDEE_LIST) ? raw.ATTENDEE_LIST : [];
    const match = attendeeList.find((item) => {
      const payload = typeof item === 'object' && item ? item as Record<string, unknown> : null;
      return payload?.id != null && String(payload.id) === attendeeId;
    });
    const status = match && typeof (match as Record<string, unknown>).status === 'string'
      ? String((match as Record<string, unknown>).status).trim().toUpperCase()
      : null;
    return status && status.length > 0 ? status : null;
  }

  private async getUserDirectory(connectionId: string, ids: string[]): Promise<Map<string, EventAttendee>> {
    const now = Date.now();
    const cached = this.userDirectoryCache.get(connectionId);
    const values = cached && cached.expiresAt > now ? new Map(cached.values) : new Map<string, EventAttendee>();
    const missing = ids.filter((id) => !values.has(id));
    if (missing.length === 0) {
      return values;
    }

    try {
      const batchUsers = await this.call<unknown[]>(connectionId, 'user.get', {
        filter: {
          ID: missing,
        },
      });
      this.addUsersToDirectory(values, batchUsers);
    } catch (error: unknown) {
      syncDebug({
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
        phase: 'bitrix.user.get.fallback',
      });
    }

    const unresolved = missing.filter((id) => !values.has(id));
    for (const id of unresolved) {
      try {
        const singleUser = await this.call<unknown[]>(connectionId, 'user.get', {
          filter: {
            ID: id,
          },
        });
        this.addUsersToDirectory(values, singleUser);
      } catch {
        continue;
      }
    }

    this.userDirectoryCache.set(connectionId, {
      expiresAt: now + BitrixService.USER_CACHE_TTL_MS,
      values,
    });
    return values;
  }

  private addUsersToDirectory(target: Map<string, EventAttendee>, source: unknown[]): void {
    for (const item of Array.isArray(source) ? source : []) {
      const payload = typeof item === 'object' && item ? item as Record<string, unknown> : {};
      const id = payload.ID == null ? '' : String(payload.ID);
      if (!id) {
        continue;
      }

      const email = payload.EMAIL == null ? null : String(payload.EMAIL).trim();
      const firstName = payload.NAME == null ? '' : String(payload.NAME).trim();
      const lastName = payload.LAST_NAME == null ? '' : String(payload.LAST_NAME).trim();
      const name = `${firstName} ${lastName}`.trim() || firstName || lastName || null;
      target.set(id, {
        email: email && email.length > 0 ? email : null,
        name,
        partstat: null,
        raw: JSON.stringify(payload),
        role: 'REQ-PARTICIPANT',
      });
    }
  }

  private async getResourceNameMap(connectionId: string): Promise<Map<string, string>> {
    const now = Date.now();
    const cached = this.resourceNameCache.get(connectionId);
    if (cached && cached.expiresAt > now) {
      return cached.values;
    }

    try {
      const resources = await this.call<unknown[]>(connectionId, 'calendar.resource.list', {});
      const values = new Map<string, string>();
      for (const item of Array.isArray(resources) ? resources : []) {
        const payload = typeof item === 'object' && item ? item as Record<string, unknown> : {};
        const id = payload.ID == null ? '' : String(payload.ID);
        const name = payload.NAME == null ? '' : String(payload.NAME).trim();
        if (id && name) {
          values.set(id, name);
        }
      }

      this.resourceNameCache.set(connectionId, {
        expiresAt: now + BitrixService.RESOURCE_CACHE_TTL_MS,
        values,
      });
      return values;
    } catch (error: unknown) {
      syncDebug({
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
        phase: 'bitrix.resource.list.fallback',
      });
      return new Map();
    }
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
      if (result.length === 0) {
        return null;
      }

      const event = buildBitrixEventFromRaw((result[0] ?? {}) as BitrixPayload);
      await this.enrichEventMetadata(connectionId, [event]);
      return event;
    }

    const event = buildBitrixEventFromRaw(result as BitrixPayload);
    await this.enrichEventMetadata(connectionId, [event]);
    return event;
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

  private async call<T>(
    connectionId: string,
    method: string,
    payload: Record<string, unknown>,
    retryState: BitrixCallRetryState = { allowRefreshRetry: true, rateLimitAttempt: 0 },
  ): Promise<T> {
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
    if (this.isRateLimitedBitrixResponse(response.status, envelope.error) && retryState.rateLimitAttempt < BitrixService.RATE_LIMIT_MAX_RETRIES) {
      const delayMs = this.computeRateLimitBackoffMs(retryState.rateLimitAttempt);
      syncDebug({
        attempt: retryState.rateLimitAttempt + 1,
        connectionId,
        delayMs,
        method,
        phase: 'bitrix.call.retry.rate_limit',
        reason: envelope.error ?? `status_${response.status}`,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return this.call<T>(connectionId, method, payload, {
        allowRefreshRetry: retryState.allowRefreshRetry,
        rateLimitAttempt: retryState.rateLimitAttempt + 1,
      });
    }

    if ((!response.ok || envelope.error) && retryState.allowRefreshRetry && this.isRefreshableBitrixError(response.status, envelope.error)) {
      await this.bitrixAuthService.refreshInstallationAuth(context.installation);
      return this.call<T>(connectionId, method, payload, {
        allowRefreshRetry: false,
        rateLimitAttempt: retryState.rateLimitAttempt,
      });
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

  private isRateLimitedBitrixResponse(statusCode: number, errorCode: string | undefined): boolean {
    if (statusCode === 429 || statusCode === 503) {
      return true;
    }

    const normalized = (errorCode ?? '').toLowerCase();
    return normalized.includes('query_limit_exceeded') || normalized.includes('too_many_requests') || normalized.includes('rate_limit');
  }

  private computeRateLimitBackoffMs(attempt: number): number {
    const baseDelayMs = 300;
    const exponential = baseDelayMs * (2 ** attempt);
    const jitter = Math.floor(Math.random() * 120);
    return Math.min(5000, exponential + jitter);
  }
}
