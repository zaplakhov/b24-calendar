/*
Module: index
Role: Creates and boots the minimal Express runtime for the backend service.
Source of Truth: backend/src/index.ts

Uses:
  express:express: true
  node:http:createServer: true

Used by:
  backend/package.json:start: true
  backend/package.json:dev: true

Glossary: none
*/

import express, { type Express, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';

const DEFAULT_PORT = 3000;

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.get('/health', (_request: Request, response: Response) => {
    response.status(200).json({
      service: 'b24-calendar-backend',
      status: 'ok',
    });
  });

  return app;
}

export function resolvePort(rawPort: string | undefined): number {
  const parsedPort = Number.parseInt(rawPort ?? '', 10);

  return Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
}

export async function startServer(port = resolvePort(process.env.PORT)): Promise<Server> {
  const app = createApp();
  const server = createServer(app);

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
