/*
Module: index
Role: Creates and boots the Express runtime for Bitrix local app install callbacks and external onboarding flow.
Source of Truth: backend/src/index.ts

Uses:
  express:express: true
  node:http:createServer: true
  node:fs: true
  node:path: true
  ./services/sqlite.service.ts:SQLiteService: true
  ./services/bitrix-auth.service.ts:BitrixAuthService: true
  ./services/bitrix.service.ts:BitrixService: true
  ./services/yandex-caldav.service.ts:YandexCalDavService: true
  ./services/sync.service.ts:SyncService: true
  ./handlers/webhook.handler.ts:createBitrixWebhookHandler: true
  ./routes/bitrix.routes.ts:createBitrixRouter: true
  ./routes/onboarding.routes.ts:createOnboardingRouter: true

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
import { createBitrixRouter } from './routes/bitrix.routes';
import { createOnboardingRouter } from './routes/onboarding.routes';
import { BitrixAuthService } from './services/bitrix-auth.service';
import { BitrixService } from './services/bitrix.service';
import { SQLiteService } from './services/sqlite.service';
import { SyncService } from './services/sync.service';
import { YandexCalDavService } from './services/yandex-caldav.service';

const DEFAULT_PORT = 3000;
const DEFAULT_POLL_MINUTES_MIN = 5;
const DEFAULT_POLL_MINUTES_MAX = 5;

interface AppDependencies {
  sqliteService: SQLiteService;
  bitrixAuthService: BitrixAuthService;
  bitrixService: BitrixService;
  syncService: SyncService;
  yandexService: YandexCalDavService;
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  const { sqliteService, bitrixAuthService, bitrixService, syncService, yandexService } = dependencies;
  const onboardingDirectory = resolveFrontendDirectory('onboarding');
  const connectDirectory = resolveFrontendDirectory('connect');

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use('/bitrix', createBitrixRouter({
    bitrixAuthService,
    sqliteService,
  }));
  app.use('/api/onboarding', createOnboardingRouter({
    bitrixService,
    sqliteService,
    syncService,
    yandexService,
  }));
  app.post('/api/webhook/bitrix', createBitrixWebhookHandler(sqliteService, syncService));

  if (onboardingDirectory) {
    app.use('/onboarding', express.static(onboardingDirectory));
    app.get('/onboarding/:token', (_request: Request, response: Response) => {
      response.sendFile(resolve(onboardingDirectory, 'index.html'));
    });
  }

  if (connectDirectory) {
    app.use('/connect', express.static(connectDirectory));
    app.get('/connect', (_request: Request, response: Response) => {
      response.redirect('/connect/');
    });
  }

  app.get('/', (_request: Request, response: Response) => {
    response.redirect('/connect/');
  });

  app.get('/health', (_request: Request, response: Response) => {
    response.status(200).json({
      service: 'b24-calendar-backend',
      status: 'ok',
      installationsCount: sqliteService.listInstallations().length,
      connectionsCount: sqliteService.countConnections(),
      activeConnectionsCount: sqliteService.countActiveConnections(),
    });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unexpected server error.',
    });
  });

  return app;
}

function resolveFrontendDirectory(kind: 'connect' | 'onboarding'): string | null {
  const candidates = [
    resolve(__dirname, `../../frontend/${kind}`),
    resolve(process.cwd(), `../frontend/${kind}`),
    resolve(process.cwd(), `frontend/${kind}`),
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
  const bitrixAuthService = new BitrixAuthService(sqliteService);
  const bitrixService = new BitrixService(sqliteService, bitrixAuthService);
  const yandexService = new YandexCalDavService(sqliteService);
  const syncService = new SyncService(sqliteService, bitrixService, yandexService);

  return {
    sqliteService,
    bitrixAuthService,
    bitrixService,
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

  await new Promise<void>((resolvePromise, reject) => {
    const handleError = (error: Error): void => {
      server.off('error', handleError);
      reject(error);
    };

    const handleListening = (): void => {
      server.off('error', handleError);
      resolvePromise();
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
