/*
Module: bitrix.routes
Role: Exposes Bitrix24 install and OAuth endpoints for local server-side app mode.
Source of Truth: backend/src/routes/bitrix.routes.ts

Uses:
  express:Router: true
  ../services/bitrix-auth.service.ts:BitrixAuthService: true
  ../services/sqlite.service.ts:SQLiteService: true

Used by:
  ../index.ts:createApp: true

Glossary: none
*/

import { Router, type Request, type Response } from 'express';

import { BitrixAuthService } from '../services/bitrix-auth.service';
import { SQLiteService } from '../services/sqlite.service';

interface BitrixRouterDependencies {
  bitrixAuthService: BitrixAuthService;
  sqliteService: SQLiteService;
}

function mergeRequestPayload(request: Request): Record<string, unknown> {
  return {
    ...(typeof request.query === 'object' ? request.query : {}),
    ...(typeof request.body === 'object' && request.body ? request.body as Record<string, unknown> : {}),
  };
}

export function createBitrixRouter(dependencies: BitrixRouterDependencies): Router {
  const { bitrixAuthService, sqliteService } = dependencies;
  const router = Router();

  router.all('/install', async (request: Request, response: Response, next) => {
    try {
      const installation = await bitrixAuthService.handleInstallPayload(mergeRequestPayload(request));
      response.status(200).json({
        ok: true,
        message: 'Bitrix local app installation payload stored.',
        installation: {
          id: installation.id,
          portalHost: installation.portalHost,
          status: installation.status,
        },
        next: {
          connectUrl: bitrixAuthService.getConnectUrl(),
        },
      });
    } catch (error: unknown) {
      next(error);
    }
  });

  router.get('/oauth/start', (request: Request, response: Response) => {
    const portalHost = typeof request.query.portal === 'string'
      ? request.query.portal
      : typeof request.query.portalHost === 'string'
        ? request.query.portalHost
        : '';

    if (!portalHost.trim()) {
      response.status(400).json({
        error: 'portal or portalHost query parameter is required.',
      });
      return;
    }

    const installation = sqliteService.getInstallationByPortalHost(portalHost);
    if (!installation) {
      response.status(404).json({
        error: 'This Bitrix24 portal is not registered yet. Complete local app installation first.',
      });
      return;
    }

    response.redirect(bitrixAuthService.buildAuthorizeUrl(portalHost));
  });

  router.get('/oauth/callback', async (request: Request, response: Response, next) => {
    try {
      const code = typeof request.query.code === 'string' ? request.query.code : '';
      const state = typeof request.query.state === 'string' ? request.query.state : '';
      if (!code || !state) {
        response.status(400).json({
          error: 'Bitrix OAuth callback requires code and state query parameters.',
        });
        return;
      }

      const connection = await bitrixAuthService.completeOAuthCallback(code, state);
      response.redirect(`/onboarding/${connection.onboardingToken}`);
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}
