/*
Module: onboarding.routes.test
Role: Verifies onboarding settings save behavior, sync reset, immediate sync trigger, and sanitized responses.
Source of Truth: backend/src/routes/onboarding.routes.test.ts

Uses:
  node:test:test: true
  node:assert/strict: true
  node:fs: true
  node:os: true
  node:path: true
  node:http: true
  express: true
  ../services/sqlite.service.ts:SQLiteService: true
  ./onboarding.routes.ts:createOnboardingRouter: true

Used by: none

Glossary: none
*/

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

import { createOnboardingRouter } from './onboarding.routes';
import { SQLiteService } from '../services/sqlite.service';

interface SettingsResponsePayload {
  credentials: {
    yandexPasswordSaved: boolean;
  };
  settings: {
    yandexPassword: string;
  };
}

function makeTempDbPath(name: string): { cleanup: () => void; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `b24-calendar-${name}-`));
  return {
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
    dbPath: join(dir, 'test.sqlite'),
  };
}

function setupReadyConnection(sqliteService: SQLiteService) {
  const installation = sqliteService.upsertInstallation({
    accessToken: 'token',
    portalHost: 'example.bitrix24.ru',
    status: 'active',
  });
  const created = sqliteService.createOrUpdateConnection({
    bitrixUserId: '7',
    installationId: installation.id,
  });
  return sqliteService.updateConnectionSettings(created.id, {
    bitrixCalendarId: '42',
    syncEnabled: true,
    yandexBaseUrl: 'https://caldav.yandex.ru',
    yandexCalendarUrl: 'https://caldav.yandex.ru/calendars/user/default/',
    yandexPassword: 'secret',
    yandexUsername: 'user',
  });
}

function createReviewerEvidenceStub() {
  return {
    lastError: null,
    lastRun: {
      counters: {
        errorEvents: 0,
        healedMappings: 0,
        processedBitrixEvents: 0,
        processedYandexEvents: 0,
        skippedEvents: 0,
        skippedRecurringEvents: 0,
      },
      outcomeReason: null,
      processedBitrixEvents: 0,
      processedYandexEvents: 0,
      reasonCodes: {
        errors: [],
        healing: [],
        skipped: [],
      },
      skippedRecurringEvents: 0,
    },
    lastSyncAt: null,
    manualResync: { allowed: true, message: 'ok', reason: 'ready' as const },
    statusHint: 'ready' as const,
  };
}

async function withServer(handler: express.Express, callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to get server address.');
  }

  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('onboarding routes reset sync state and trigger immediate sync when calendar binding changes', async () => {
  const temp = makeTempDbPath('onboarding');
  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const connection = setupReadyConnection(sqliteService);
    sqliteService.upsertEventMapping({
      bitrixEventId: 'bitrix-1',
      bitrixUpdatedAt: '2026-03-24T09:00:00.000Z',
      connectionId: connection.id,
      deferredReasonCodes: [],
      deletedAt: null,
      deletedBy: null,
      healingUrl: null,
      lastDecisionReason: 'mapping_missing',
      lastHealedAt: null,
      lastHealingReason: null,
      lastSyncedAt: '2026-03-24T09:00:00.000Z',
      lastWinner: 'bitrix',
      preservedPayload: null,
      sourceFingerprint: 'source',
      sourceTimezone: 'UTC',
      status: 'synced',
      targetFingerprint: 'target',
      targetTimezone: 'UTC',
      yandexEventEtag: 'etag',
      yandexEventUid: 'uid-1',
      yandexEventUrl: 'https://caldav.yandex.ru/calendars/user/default/event.ics',
      yandexUpdatedAt: '2026-03-24T09:00:00.000Z',
    });

    const requestImmediateSyncCalls: Array<{ connectionId: string; trigger: string }> = [];
    const app = express();
    app.use(express.json());
    app.use('/api/onboarding', createOnboardingRouter({
      bitrixService: { fetchCalendars: async () => [] } as never,
      sqliteService,
      syncService: {
        getStatus: () => ({ configured: true, reviewerEvidence: createReviewerEvidenceStub(), state: sqliteService.getSyncState(connection.id) }),
        requestImmediateSync: (connectionId: string, trigger: string) => { requestImmediateSyncCalls.push({ connectionId, trigger }); },
        runManualSyncNow: async () => ({ noop: false, ok: true, preflight: { allowed: true, message: 'ok', reason: 'ready' }, processedBitrixEvents: 0, processedYandexEvents: 0, skippedRecurringEvents: 0, status: { reviewerEvidence: createReviewerEvidenceStub() } }),
      } as never,
      yandexService: { fetchCalendars: async () => [] } as never,
    }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/onboarding/${connection.onboardingToken}`, {
        body: JSON.stringify({
          bitrixCalendarId: '43',
          syncEnabled: true,
          yandexBaseUrl: 'https://caldav.yandex.ru',
          yandexCalendarUrl: 'https://caldav.yandex.ru/calendars/user/other/',
          yandexPassword: 'new-secret',
          yandexUsername: 'user',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'PUT',
      });
      const payload = await response.json() as SettingsResponsePayload;

      assert.equal(response.status, 200);
      assert.equal(payload.settings.yandexPassword, '');
      assert.equal(payload.credentials.yandexPasswordSaved, true);
    });

    assert.equal(sqliteService.listEventMappings(connection.id).length, 0);
    assert.deepEqual(requestImmediateSyncCalls, [{ connectionId: connection.id, trigger: 'settings_enabled' }]);
  } finally {
    temp.cleanup();
  }
});

test('onboarding settings response never leaks saved Yandex password', async () => {
  const temp = makeTempDbPath('onboarding-sanitize');
  try {
    const sqliteService = new SQLiteService(temp.dbPath);
    const connection = setupReadyConnection(sqliteService);
    const app = express();
    app.use(express.json());
    app.use('/api/onboarding', createOnboardingRouter({
      bitrixService: { fetchCalendars: async () => [] } as never,
      sqliteService,
      syncService: {
        getStatus: () => ({ configured: true, reviewerEvidence: createReviewerEvidenceStub(), state: sqliteService.getSyncState(connection.id) }),
        requestImmediateSync: () => undefined,
        runManualSyncNow: async () => ({ noop: false, ok: true, preflight: { allowed: true, message: 'ok', reason: 'ready' }, processedBitrixEvents: 0, processedYandexEvents: 0, skippedRecurringEvents: 0, status: { reviewerEvidence: createReviewerEvidenceStub() } }),
      } as never,
      yandexService: { fetchCalendars: async () => [] } as never,
    }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/onboarding/${connection.onboardingToken}`);
      const payload = await response.json() as SettingsResponsePayload;

      assert.equal(response.status, 200);
      assert.equal(payload.settings.yandexPassword, '');
      assert.equal(payload.credentials.yandexPasswordSaved, true);
    });
  } finally {
    temp.cleanup();
  }
});
