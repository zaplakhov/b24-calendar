/*
Module: sync.routes
Role: Exposes stable placeholder HTTP endpoints for sync status inspection and sync triggering.
Source of Truth: backend/src/routes/sync.routes.ts

Uses:
  express:Router: true

Used by:
  ../index.ts:createApp: true

Glossary: none
*/

import { Router, type Request, type Response } from 'express';

const SYNC_NOT_READY_MESSAGE = 'Calendar sync configuration is not finished yet. This endpoint is a deterministic placeholder.';

function buildSyncPlaceholderResponse() {
  return {
    lastRunAt: null,
    message: SYNC_NOT_READY_MESSAGE,
    ready: false,
    status: 'not_configured' as const,
  };
}

export function createSyncRouter(): Router {
  const router = Router();

  router.get('/status', (_request: Request, response: Response) => {
    response.status(200).json(buildSyncPlaceholderResponse());
  });

  router.post('/run', (_request: Request, response: Response) => {
    response.status(501).json({
      ...buildSyncPlaceholderResponse(),
      queued: false,
    });
  });

  return router;
}
