/*
Module: onboarding.routes
Role: Exposes token-scoped onboarding/settings APIs for external Bitrix-connected users.
Source of Truth: backend/src/routes/onboarding.routes.ts

Uses:
  express:Router: true
  ../services/sqlite.service.ts:SQLiteService: true
  ../services/sync.service.ts:SyncService: true
  ../services/yandex-caldav.service.ts:YandexCalDavService: true
  ../services/bitrix.service.ts:BitrixService: true

Used by:
  ../index.ts:createApp: true

Glossary: none
*/

import { Router, type Request, type Response } from 'express';

import { BitrixService } from '../services/bitrix.service';
import { SQLiteService, type ConnectionContext, type ConnectionSettings } from '../services/sqlite.service';
import { SyncService } from '../services/sync.service';
import { YandexCalDavService } from '../services/yandex-caldav.service';

interface OnboardingRouterDependencies {
  sqliteService: SQLiteService;
  syncService: SyncService;
  yandexService: YandexCalDavService;
  bitrixService: BitrixService;
}

function sanitizeConnectionSettingsForResponse(settings: ConnectionSettings): ConnectionSettings {
  return {
    ...settings,
    yandexPassword: '',
  };
}

function normalizeSettingsPatch(body: unknown): Partial<ConnectionSettings> {
  const payload = typeof body === 'object' && body ? body as Record<string, unknown> : {};

  return {
    bitrixCalendarId: typeof payload.bitrixCalendarId === 'string' ? payload.bitrixCalendarId.trim() : undefined,
    syncEnabled: typeof payload.syncEnabled === 'boolean' ? payload.syncEnabled : undefined,
    yandexBaseUrl: typeof payload.yandexBaseUrl === 'string' ? payload.yandexBaseUrl.trim() : undefined,
    yandexCalendarUrl: typeof payload.yandexCalendarUrl === 'string' ? payload.yandexCalendarUrl.trim() : undefined,
    yandexPassword: typeof payload.yandexPassword === 'string' && payload.yandexPassword.length > 0 ? payload.yandexPassword : undefined,
    yandexUsername: typeof payload.yandexUsername === 'string' ? payload.yandexUsername.trim() : undefined,
  };
}

function buildSettingsResponse(context: ConnectionContext, sqliteService: SQLiteService, syncService: SyncService) {
  const safeSettings = sanitizeConnectionSettingsForResponse(context.connection);
  const status = syncService.getStatus(context.connection.id);
  const yandexCalendars = sqliteService.getProviderCalendars(context.connection.id, 'yandex');
  const bitrixCalendars = sqliteService.getProviderCalendars(context.connection.id, 'bitrix');

  return {
    configured: status.configured,
    credentials: {
      yandexPasswordSaved: Boolean(context.connection.yandexPassword),
    },
    installation: {
      portalHost: context.installation.portalHost,
      status: context.installation.status,
      memberId: context.installation.memberId,
    },
    connection: {
      id: context.connection.id,
      bitrixUserId: context.connection.bitrixUserId,
      bitrixUserName: context.connection.bitrixUserName,
    },
    settings: safeSettings,
    status,
    reviewerEvidence: {
      lastSyncAt: status.reviewerEvidence.lastSyncAt,
      lastError: status.reviewerEvidence.lastError,
      syncEnabled: context.connection.syncEnabled,
      syncStatus: status.state.status,
      yandexCalendarsDiscovered: yandexCalendars.length,
      bitrixCalendarsDiscovered: bitrixCalendars.length,
    },
    calendars: {
      bitrix: bitrixCalendars,
      yandex: yandexCalendars,
    },
  };
}

function resolveContext(sqliteService: SQLiteService, token: string): ConnectionContext {
  const context = sqliteService.getConnectionContextByToken(token);
  if (!context) {
    throw new Error('Onboarding token is invalid or expired.');
  }

  return context;
}

export function createOnboardingRouter(dependencies: OnboardingRouterDependencies): Router {
  const { sqliteService, syncService, yandexService, bitrixService } = dependencies;
  const router = Router();

  router.get('/:token', (request: Request, response: Response) => {
    const context = resolveContext(sqliteService, request.params.token);
    response.status(200).json(buildSettingsResponse(context, sqliteService, syncService));
  });

  router.put('/:token', (request: Request, response: Response) => {
    const context = resolveContext(sqliteService, request.params.token);
    const nextSettings = sqliteService.updateConnectionSettings(context.connection.id, normalizeSettingsPatch(request.body));
    response.status(200).json({
      message: 'Settings saved.',
      credentials: {
        yandexPasswordSaved: Boolean(nextSettings.yandexPassword),
      },
      settings: sanitizeConnectionSettingsForResponse(nextSettings),
      status: syncService.getStatus(context.connection.id),
    });
  });

  router.get('/:token/bitrix/calendars', async (request: Request, response: Response, next) => {
    try {
      const context = resolveContext(sqliteService, request.params.token);
      const calendars = await bitrixService.fetchCalendars(context.connection.id);
      const persisted = sqliteService.replaceProviderCalendars(context.connection.id, 'bitrix', calendars);

      response.status(200).json({
        message: 'Bitrix calendars loaded.',
        calendars: persisted,
        provider: 'bitrix',
      });
    } catch (error: unknown) {
      next(error);
    }
  });

  router.get('/:token/yandex/calendars', async (request: Request, response: Response, next) => {
    try {
      const context = resolveContext(sqliteService, request.params.token);
      const calendars = await yandexService.fetchCalendars(context.connection.id);
      const persisted = sqliteService.replaceProviderCalendars(context.connection.id, 'yandex', calendars);

      response.status(200).json({
        message: 'Yandex calendars loaded.',
        calendars: persisted,
        provider: 'yandex',
      });
    } catch (error: unknown) {
      next(error);
    }
  });

  router.get('/:token/sync/status', (request: Request, response: Response) => {
    const context = resolveContext(sqliteService, request.params.token);
    const status = syncService.getStatus(context.connection.id);
    response.status(200).json({
      status,
      reviewerEvidence: status.reviewerEvidence,
    });
  });

  router.post('/:token/sync/run', async (request: Request, response: Response, next) => {
    try {
      const context = resolveContext(sqliteService, request.params.token);
      const result = await syncService.runManualResync(context.connection.id);
      response.status(200).json({
        error: null,
        noop: result.noop,
        queued: false,
        result,
        reviewerEvidence: result.status.reviewerEvidence,
      });
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}
