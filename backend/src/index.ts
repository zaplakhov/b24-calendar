/*
Module: index
Role: Creates and boots the Express runtime, wiring real services, webhook intake, and the embedded settings frontend.
Source of Truth: backend/src/index.ts

Uses:
  express:express: true
  node:http:createServer: true
  node:fs: true
  node:path: true
  ./services/sqlite.service.ts:SQLiteService: true
  ./services/bitrix.service.ts:BitrixService: true
  ./services/yandex-caldav.service.ts:YandexCalDavService: true
  ./services/sync.service.ts:SyncService: true
  ./handlers/webhook.handler.ts:createBitrixWebhookHandler: true
  ./routes/settings.routes.ts:createSettingsRouter: true
  ./routes/sync.routes.ts:createSyncRouter: true

Used by:
  backend/package.json:start: true
  backend/package.json:dev: true

Glossary: none
*/

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';

import { createBitrixWebhookHandler } from './handlers/webhook.handler';
import { createSettingsRouter, EMBEDDED_SETTINGS_PAGE_PATH } from './routes/settings.routes';
import { createSyncRouter } from './routes/sync.routes';
import { BitrixService } from './services/bitrix.service';
import { SQLiteService } from './services/sqlite.service';
import { SyncService } from './services/sync.service';
import { YandexCalDavService } from './services/yandex-caldav.service';

const DEFAULT_PORT = 3000;
const DEFAULT_POLL_MINUTES_MIN = 10;
const DEFAULT_POLL_MINUTES_MAX = 15;

interface AppDependencies {
  sqliteService: SQLiteService;
  syncService: SyncService;
  yandexService: YandexCalDavService;
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  const { sqliteService, syncService, yandexService } = dependencies;
  const frontendDirectory = resolveFrontendDirectory();

  app.use(express.json());
  app.use('/api/settings', createSettingsRouter({
    sqliteService,
    syncService,
    yandexService,
  }));
  app.use('/api/sync', createSyncRouter(syncService));
  app.post('/api/webhook/bitrix', createBitrixWebhookHandler(syncService));

  if (frontendDirectory) {
    app.use(EMBEDDED_SETTINGS_PAGE_PATH, express.static(frontendDirectory));
    app.get(EMBEDDED_SETTINGS_PAGE_PATH, (_request: Request, response: Response) => {
      response.sendFile(resolve(frontendDirectory, 'index.html'));
    });
  }

  app.get('/health', (_request: Request, response: Response) => {
    response.status(200).json({
      service: 'b24-calendar-backend',
      status: 'ok',
      sync: syncService.getStatus(),
    });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unexpected server error.',
    });
  });

  return app;
}

function resolveFrontendDirectory(): string | null {
  const candidates = [
    resolve(__dirname, '../../frontend/settings-page'),
    resolve(process.cwd(), '../frontend/settings-page'),
    resolve(process.cwd(), 'frontend/settings-page'),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function resolvePort(rawPort: string | undefined): number {
  const parsedPort = Number.parseInt(rawPort ?? '', 10);

  return Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
}

function resolvePollDelayMs(rawMinutes: string | undefined, fallbackMinutes: number): number {
  const parsedMinutes = Number.parseInt(rawMinutes ?? '', 10);
  const minutes = Number.isInteger(parsedMinutes) && parsedMinutes > 0 ? parsedMinutes : fallbackMinutes;

  return minutes * 60 * 1000;
}

function createDependencies(): AppDependencies {
  const sqliteService = new SQLiteService();
  const bitrixService = new BitrixService(sqliteService);
  const yandexService = new YandexCalDavService(sqliteService);
  const syncService = new SyncService(sqliteService, bitrixService, yandexService);

  return {
    sqliteService,
    syncService,
    yandexService,
  };
}

export async function startServer(port = resolvePort(process.env.PORT)): Promise<Server> {
  const dependencies = createDependencies();
  const app = createApp(dependencies);
  const server = createServer(app);

  dependencies.syncService.startPollingLoop({
    maxDelayMs: resolvePollDelayMs(process.env.SYNC_POLL_MAX_MINUTES, DEFAULT_POLL_MINUTES_MAX),
    minDelayMs: resolvePollDelayMs(process.env.SYNC_POLL_MIN_MINUTES, DEFAULT_POLL_MINUTES_MIN),
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => {
      server.off('error', handleError);
      reject(error);
    };

    const handleListening = (): void => {
      server.off('error', handleError);
      resolve();
    };

    server.once('error', handleError);

    try {
      server.listen(port, handleListening);
    } catch (error: unknown) {
      server.off('error', handleError);
      reject(error);
    }
  });

  return server;
}

async function boot(): Promise<void> {
  const port = resolvePort(process.env.PORT);
  await startServer(port);
}

void boot().catch((error: unknown) => {
  console.error('Failed to start backend service.', error);
  process.exit(1);
});
