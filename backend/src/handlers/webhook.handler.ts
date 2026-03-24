/*
Module: webhook.handler
Role: Accepts Bitrix webhook callbacks, resolves the scoped connection, and forwards them into the sync pipeline.
Source of Truth: backend/src/handlers/webhook.handler.ts

Uses:
  express:RequestHandler: true
  ../services/sqlite.service.ts:SQLiteService: true
  ../services/sync.service.ts:SyncService: true

Used by:
  ../index.ts:createApp: true

Glossary: none
*/

import type { RequestHandler } from 'express';

import { SQLiteService } from '../services/sqlite.service';
import { SyncService } from '../services/sync.service';

function normalizePortalHost(portalHost: string): string {
  return portalHost
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function resolveConnectionId(sqliteService: SQLiteService, payload: Record<string, unknown>): string | null {
  const auth = typeof payload.auth === 'object' && payload.auth ? payload.auth as Record<string, unknown> : {};
  const memberId = auth.member_id ? String(auth.member_id) : payload.member_id ? String(payload.member_id) : null;
  const domainValue = auth.domain ?? payload.domain ?? payload.DOMAIN;
  const portalHost = typeof domainValue === 'string' && domainValue.trim().length > 0 ? normalizePortalHost(domainValue) : null;
  const userIdValue = auth.user_id ?? payload.user_id ?? payload.userId;
  const bitrixUserId = userIdValue ? String(userIdValue) : null;

  const installation = memberId
    ? sqliteService.getInstallationByMemberId(memberId)
    : portalHost
      ? sqliteService.getInstallationByPortalHost(portalHost)
      : null;

  if (!installation) {
    return null;
  }

  if (bitrixUserId) {
    const scoped = sqliteService.getConnectionByInstallationAndUser(installation.id, bitrixUserId);
    if (scoped) {
      return scoped.id;
    }
  }

  const connections = sqliteService.listConnectionsForInstallation(installation.id);
  return connections.length === 1 ? connections[0].id : null;
}

export function createBitrixWebhookHandler(sqliteService: SQLiteService, syncService: SyncService): RequestHandler {
  return async (request, response, next) => {
    try {
      const payload = (request.body ?? {}) as Record<string, unknown>;
      const connectionId = resolveConnectionId(sqliteService, payload);
      if (!connectionId) {
        response.status(404).json({
          accepted: false,
          error: 'Unable to resolve Bitrix connection for webhook payload.',
        });
        return;
      }

      const status = await syncService.handleBitrixWebhook(connectionId, payload);
      response.status(202).json({
        accepted: true,
        status,
      });
    } catch (error: unknown) {
      next(error);
    }
  };
}
