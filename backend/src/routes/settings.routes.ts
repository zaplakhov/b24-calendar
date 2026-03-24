/*
Module: settings.routes
Role: Exposes settings persistence endpoints plus provider calendar discovery for the embedded settings page.
Source of Truth: backend/src/routes/settings.routes.ts

Uses:
  express:Router: true
  ../services/sqlite.service.ts:SQLiteService: true
  ../services/yandex-caldav.service.ts:YandexCalDavService: true
  ../services/sync.service.ts:SyncService: true

Used by:
  ../index.ts:createApp: true

Glossary: none
*/

import { Router, type Request, type Response } from 'express';

import { SQLiteService, type AppSettings } from '../services/sqlite.service';
import { SyncService } from '../services/sync.service';
import { YandexCalDavService } from '../services/yandex-caldav.service';

export const EMBEDDED_SETTINGS_PAGE_PATH = '/embedded/settings';

interface SettingsRouterDependencies {
  sqliteService: SQLiteService;
  syncService: SyncService;
  yandexService: YandexCalDavService;
}

function sanitizeSettingsForResponse(settings: AppSettings): AppSettings {
  return {
    ...settings,
    bitrixAuthToken: '',
    yandexPassword: '',
  };
}

function normalizeSettingsPatch(body: unknown): Partial<AppSettings> {
  const payload = typeof body === 'object' && body ? (body as Record<string, unknown>) : {};

  return {
    bitrixAuthToken: typeof payload.bitrixAuthToken === 'string' && payload.bitrixAuthToken.trim().length > 0 ? payload.bitrixAuthToken.trim() : undefined,
    bitrixCalendarId: typeof payload.bitrixCalendarId === 'string' ? payload.bitrixCalendarId.trim() : undefined,
    bitrixUserId: typeof payload.bitrixUserId === 'string' ? payload.bitrixUserId.trim() : undefined,
    bitrixWebhookUrl: typeof payload.bitrixWebhookUrl === 'string' ? payload.bitrixWebhookUrl.trim() : undefined,
    syncEnabled: typeof payload.syncEnabled === 'boolean' ? payload.syncEnabled : undefined,
    yandexBaseUrl: typeof payload.yandexBaseUrl === 'string' ? payload.yandexBaseUrl.trim() : undefined,
    yandexCalendarUrl: typeof payload.yandexCalendarUrl === 'string' ? payload.yandexCalendarUrl.trim() : undefined,
    yandexPassword: typeof payload.yandexPassword === 'string' && payload.yandexPassword.length > 0 ? payload.yandexPassword : undefined,
    yandexUsername: typeof payload.yandexUsername === 'string' ? payload.yandexUsername.trim() : undefined,
  };
}

function buildSettingsResponse(sqliteService: SQLiteService, syncService: SyncService) {
  const settings = sqliteService.getSettings();
  const safeSettings = sanitizeSettingsForResponse(settings);
  const status = syncService.getStatus();
  const yandexCalendars = sqliteService.getProviderCalendars('yandex');

  return {
    configured: status.configured,
    credentials: {
      bitrixAuthTokenSaved: Boolean(settings.bitrixAuthToken),
      yandexPasswordSaved: Boolean(settings.yandexPassword),
    },
    settings: safeSettings,
    status,
    reviewerEvidence: {
      lastSyncAt: status.reviewerEvidence.lastSyncAt,
      lastError: status.reviewerEvidence.lastError,
      syncEnabled: settings.syncEnabled,
      syncStatus: status.state.status,
      yandexCalendarsDiscovered: yandexCalendars.length,
    },
    ui: {
      embeddedPath: EMBEDDED_SETTINGS_PAGE_PATH,
      ready: true,
    },
    calendars: {
      yandex: yandexCalendars,
    },
  };
}

export function createSettingsRouter(dependencies: SettingsRouterDependencies): Router {
  const { sqliteService, syncService, yandexService } = dependencies;
  const router = Router();

  router.get('/', (_request: Request, response: Response) => {
    response.status(200).json(buildSettingsResponse(sqliteService, syncService));
  });

  router.put('/', (request: Request, response: Response) => {
    const nextSettings = sqliteService.updateSettings(normalizeSettingsPatch(request.body));

    response.status(200).json({
      message: 'Settings saved.',
      credentials: {
        bitrixAuthTokenSaved: Boolean(nextSettings.bitrixAuthToken),
        yandexPasswordSaved: Boolean(nextSettings.yandexPassword),
      },
      settings: sanitizeSettingsForResponse(nextSettings),
      status: syncService.getStatus(),
    });
  });

  router.get('/yandex/calendars', async (_request: Request, response: Response, next) => {
    try {
      const calendars = await yandexService.fetchCalendars();
      const persisted = sqliteService.replaceProviderCalendars('yandex', calendars);

      response.status(200).json({
        message: 'Yandex calendars loaded.',
        calendars: persisted,
        provider: 'yandex',
        reviewerEvidence: {
          calendarsDiscovered: persisted.length,
          configured: syncService.getStatus().configured,
        },
      });
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}
