/*
Module: webhook.handler
Role: Accepts Bitrix webhook callbacks and forwards them into the sync pipeline.
Source of Truth: backend/src/handlers/webhook.handler.ts

Uses:
  express:RequestHandler: true
  ../services/sync.service.ts:SyncService: true

Used by:
  ../index.ts:createApp: true

Glossary: none
*/

import type { RequestHandler } from 'express';

import { SyncService } from '../services/sync.service';

export function createBitrixWebhookHandler(syncService: SyncService): RequestHandler {
  return async (request, response, next) => {
    try {
      const status = await syncService.handleBitrixWebhook((request.body ?? {}) as Record<string, unknown>);
      response.status(202).json({
        accepted: true,
        status,
      });
    } catch (error: unknown) {
      next(error);
    }
  };
}
