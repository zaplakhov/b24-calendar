/*
Module: settings.routes
Role: Exposes stable placeholder HTTP endpoints for application settings and the future embedded settings page metadata.
Source of Truth: backend/src/routes/settings.routes.ts

Uses:
  express:Router: true

Used by:
  ../index.ts:createApp: true

Glossary: none
*/

import { Router, type Request, type Response } from 'express';

export const EMBEDDED_SETTINGS_PAGE_PATH = '/embedded/settings';
const SETTINGS_NOT_READY_MESSAGE = 'Settings configuration is not finished yet. This endpoint is a deterministic placeholder.';

function buildSettingsPlaceholderResponse() {
  return {
    configured: false,
    message: SETTINGS_NOT_READY_MESSAGE,
    status: 'not_configured' as const,
    ui: {
      embeddedPath: EMBEDDED_SETTINGS_PAGE_PATH,
      ready: false,
    },
  };
}

export function createSettingsRouter(): Router {
  const router = Router();

  router.get('/', (_request: Request, response: Response) => {
    response.status(200).json(buildSettingsPlaceholderResponse());
  });

  router.put('/', (_request: Request, response: Response) => {
    response.status(501).json({
      ...buildSettingsPlaceholderResponse(),
      accepted: false,
    });
  });

  return router;
}
