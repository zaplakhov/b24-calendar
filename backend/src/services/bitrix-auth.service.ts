/*
Module: bitrix-auth.service
Role: Handles Bitrix24 install payloads, OAuth redirects, token exchange, and token refresh for local server-side app mode.
Source of Truth: backend/src/services/bitrix-auth.service.ts

Uses:
  node:crypto:createHmac: true
  node:crypto:timingSafeEqual: true
  ./sqlite.service.ts:SQLiteService: true

Used by:
  ../routes/bitrix.routes.ts:createBitrixRouter: true
  ./bitrix.service.ts:BitrixService: true

Glossary: none
*/

import { createHmac, timingSafeEqual } from 'node:crypto';

import { SQLiteService, type BitrixInstallation, type ConnectionSettings } from './sqlite.service';

interface OAuthStatePayload {
  portalHost: string;
  requestedAt: string;
}

interface BitrixTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  member_id?: string;
  domain?: string;
  scope?: string;
  application_token?: string;
  user_id?: number | string;
  error?: string;
  error_description?: string;
}

interface BitrixCurrentUserResponse {
  result?: {
    ID?: number | string;
    NAME?: string;
    LAST_NAME?: string;
  };
  error?: string;
  error_description?: string;
}

function normalizePortalHost(portalHost: string): string {
  return portalHost
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function toIsoExpiry(expiresIn: number | string | undefined): string | null {
  const parsed = Number.parseInt(String(expiresIn ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return new Date(Date.now() + parsed * 1000).toISOString();
}

export class BitrixAuthService {
  private readonly appBaseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly stateSecret: string;

  public constructor(private readonly sqliteService: SQLiteService) {
    this.appBaseUrl = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '');
    this.clientId = process.env.BITRIX_CLIENT_ID ?? '';
    this.clientSecret = process.env.BITRIX_CLIENT_SECRET ?? '';
    this.stateSecret = process.env.APP_SIGNING_SECRET ?? this.clientSecret;
  }

  public getOAuthCallbackUrl(): string {
    if (!this.appBaseUrl) {
      throw new Error('APP_BASE_URL is not configured.');
    }

    return `${this.appBaseUrl}/bitrix/oauth/callback`;
  }

  public getConnectUrl(): string {
    if (!this.appBaseUrl) {
      throw new Error('APP_BASE_URL is not configured.');
    }

    return `${this.appBaseUrl}/connect/`;
  }

  public buildAuthorizeUrl(portalHost: string): string {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('BITRIX_CLIENT_ID and BITRIX_CLIENT_SECRET must be configured.');
    }

    const normalizedPortal = normalizePortalHost(portalHost);
    const state = this.signState({
      portalHost: normalizedPortal,
      requestedAt: new Date().toISOString(),
    });
    const url = new URL(`https://${normalizedPortal}/oauth/authorize/`);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.getOAuthCallbackUrl());
    url.searchParams.set('state', state);
    return url.toString();
  }

  public async handleInstallPayload(payload: Record<string, unknown>): Promise<BitrixInstallation> {
    const auth = this.extractAuthPayload(payload);
    const portalHost = auth.domain ?? auth.portalHost;

    if (!portalHost) {
      throw new Error('Bitrix install payload does not contain portal domain.');
    }

    return this.sqliteService.upsertInstallation({
      portalHost,
      memberId: auth.memberId,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      expiresAt: auth.expiresIn ? toIsoExpiry(auth.expiresIn) : null,
      scope: auth.scope,
      applicationToken: auth.applicationToken,
      status: 'active',
      installedByUserId: auth.userId,
    });
  }

  public async completeOAuthCallback(code: string, state: string): Promise<ConnectionSettings> {
    const payload = this.verifyState(state);
    const tokenResponse = await this.exchangeCode(payload.portalHost, code);
    const installation = this.sqliteService.upsertInstallation({
      portalHost: tokenResponse.domain ?? payload.portalHost,
      memberId: tokenResponse.member_id ?? null,
      accessToken: tokenResponse.access_token ?? null,
      refreshToken: tokenResponse.refresh_token ?? null,
      expiresAt: toIsoExpiry(tokenResponse.expires_in),
      scope: tokenResponse.scope ?? null,
      applicationToken: tokenResponse.application_token ?? null,
      status: 'active',
      installedByUserId: tokenResponse.user_id ? String(tokenResponse.user_id) : null,
    });
    const currentUser = await this.fetchCurrentUser(installation);
    const bitrixUserId = currentUser.id ?? (tokenResponse.user_id ? String(tokenResponse.user_id) : null);

    if (!bitrixUserId) {
      throw new Error('Bitrix OAuth callback did not provide user context.');
    }

    return this.sqliteService.createOrUpdateConnection({
      installationId: installation.id,
      bitrixUserId,
      bitrixUserName: currentUser.name,
    });
  }

  public async getValidAccessToken(installationId: string): Promise<string> {
    const installation = this.sqliteService.getInstallationById(installationId);
    if (!installation) {
      throw new Error(`Bitrix installation ${installationId} was not found.`);
    }

    if (!installation.accessToken) {
      throw new Error(`Bitrix installation ${installation.portalHost} is not authorized yet.`);
    }

    if (!installation.expiresAt) {
      return installation.accessToken;
    }

    const expiresAtMs = Date.parse(installation.expiresAt);
    if (!Number.isNaN(expiresAtMs) && expiresAtMs - Date.now() > 60_000) {
      return installation.accessToken;
    }

    const refreshed = await this.refreshInstallationAuth(installation);
    if (!refreshed.accessToken) {
      throw new Error(`Failed to refresh Bitrix access token for ${installation.portalHost}.`);
    }

    return refreshed.accessToken;
  }

  public async refreshInstallationAuth(installation: BitrixInstallation): Promise<BitrixInstallation> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('BITRIX_CLIENT_ID and BITRIX_CLIENT_SECRET must be configured.');
    }

    if (!installation.refreshToken) {
      throw new Error(`Bitrix installation ${installation.portalHost} has no refresh token.`);
    }

    const url = new URL(`https://${installation.portalHost}/oauth/token/`);
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: installation.refreshToken,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const payload = (await response.json()) as BitrixTokenResponse;
    if (!response.ok || payload.error) {
      const message = payload.error_description ?? payload.error ?? `Failed to refresh Bitrix token (${response.status}).`;
      this.sqliteService.updateInstallationStatus(installation.id, {
        lastErrorMessage: message,
      });
      throw new Error(message);
    }

    return this.sqliteService.updateInstallationStatus(installation.id, {
      accessToken: payload.access_token ?? installation.accessToken,
      refreshToken: payload.refresh_token ?? installation.refreshToken,
      expiresAt: toIsoExpiry(payload.expires_in),
      scope: payload.scope ?? installation.scope,
      memberId: payload.member_id ?? installation.memberId,
      portalHost: payload.domain ?? installation.portalHost,
      status: 'active',
      lastErrorMessage: null,
    });
  }

  private async exchangeCode(portalHost: string, code: string): Promise<BitrixTokenResponse> {
    const url = new URL(`https://${normalizePortalHost(portalHost)}/oauth/token/`);
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.getOAuthCallbackUrl(),
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const payload = (await response.json()) as BitrixTokenResponse;

    if (!response.ok || payload.error) {
      throw new Error(payload.error_description ?? payload.error ?? `Bitrix OAuth exchange failed (${response.status}).`);
    }

    return payload;
  }

  private async fetchCurrentUser(installation: BitrixInstallation): Promise<{ id: string | null; name: string | null }> {
    const accessToken = installation.accessToken;
    if (!accessToken) {
      return { id: installation.installedByUserId, name: null };
    }

    const response = await fetch(`https://${installation.portalHost}/rest/user.current.json`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ auth: accessToken }),
    });
    const payload = (await response.json()) as BitrixCurrentUserResponse;

    if (!response.ok || payload.error) {
      return { id: installation.installedByUserId, name: null };
    }

    const id = payload.result?.ID ? String(payload.result.ID) : installation.installedByUserId;
    const nameParts = [payload.result?.NAME, payload.result?.LAST_NAME].filter((value) => value && value.trim().length > 0);

    return {
      id: id ?? null,
      name: nameParts.length > 0 ? nameParts.join(' ') : null,
    };
  }

  private signState(payload: OAuthStatePayload): string {
    if (!this.stateSecret) {
      throw new Error('APP_SIGNING_SECRET or BITRIX_CLIENT_SECRET must be configured.');
    }

    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.stateSecret).update(encodedPayload).digest('base64url');
    return `${encodedPayload}.${signature}`;
  }

  private verifyState(state: string): OAuthStatePayload {
    const [encodedPayload, signature] = state.split('.');
    if (!encodedPayload || !signature) {
      throw new Error('Bitrix OAuth state is malformed.');
    }

    const expected = createHmac('sha256', this.stateSecret).update(encodedPayload).digest();
    const provided = Buffer.from(signature, 'base64url');

    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new Error('Bitrix OAuth state signature is invalid.');
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as OAuthStatePayload;
    return {
      portalHost: normalizePortalHost(payload.portalHost),
      requestedAt: payload.requestedAt,
    };
  }

  private extractAuthPayload(payload: Record<string, unknown>): {
    portalHost: string | null;
    domain: string | null;
    memberId: string | null;
    accessToken: string | null;
    refreshToken: string | null;
    expiresIn: number | string | undefined;
    scope: string | null;
    applicationToken: string | null;
    userId: string | null;
  } {
    const auth = typeof payload.auth === 'object' && payload.auth ? payload.auth as Record<string, unknown> : {};

    const domainValue = auth.domain ?? payload.domain ?? payload.DOMAIN ?? payload.portal_host;
    const domain = typeof domainValue === 'string' && domainValue.trim().length > 0 ? normalizePortalHost(domainValue) : null;
    const memberValue = auth.member_id ?? payload.member_id ?? payload.memberId;
    const accessTokenValue = auth.access_token ?? payload.access_token ?? payload.auth_token;
    const refreshTokenValue = auth.refresh_token ?? payload.refresh_token;
    const userIdValue = auth.user_id ?? payload.user_id ?? payload.userId;
    const scopeValue = auth.scope ?? payload.scope;
    const applicationTokenValue = auth.application_token ?? payload.application_token;

    const expiresInValue = auth.expires_in ?? payload.expires_in;

    return {
      portalHost: domain,
      domain,
      memberId: memberValue ? String(memberValue) : null,
      accessToken: accessTokenValue ? String(accessTokenValue) : null,
      refreshToken: refreshTokenValue ? String(refreshTokenValue) : null,
      expiresIn: typeof expiresInValue === 'number' || typeof expiresInValue === 'string' ? expiresInValue : undefined,
      scope: scopeValue ? String(scopeValue) : null,
      applicationToken: applicationTokenValue ? String(applicationTokenValue) : null,
      userId: userIdValue ? String(userIdValue) : null,
    };
  }
}
