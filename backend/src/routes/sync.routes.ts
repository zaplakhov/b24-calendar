/*
Module: sync.routes
Role: Exposes sync status inspection, manual resync, and Yandex polling triggers.
Source of Truth: backend/src/routes/sync.routes.ts

Uses:
  express:Router: true
  ../services/sync.service.ts:SyncService: true

Used by:
  ../index.ts:createApp: true

Glossary: none
*/

import { Router, type Request, type Response } from 'express';

import { SyncService } from '../services/sync.service';

export function createSyncRouter(syncService: SyncService): Router {
  const router = Router();

  router.get('/status', (_request: Request, response: Response) => {
    const status = syncService.getStatus();
    response.status(200).json({
      status,
      reviewerEvidence: status.reviewerEvidence,
    });
  });

  router.post('/run', async (_request: Request, response: Response, next) => {
    try {
      const result = await syncService.runManualResync();
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
