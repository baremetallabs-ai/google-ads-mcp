import { OAuth2Client, JWT, GoogleAuth, Compute, Impersonated, BaseExternalAccountClient, UserRefreshClient, ExternalAccountAuthorizedUserClient, type AuthClient } from 'google-auth-library';
import type { Env, ServiceAccountKey } from '../config/env.js';
import { GoogleAdsApiError } from '../errors/tool-errors.js';

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface OAuth2ProviderOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Refresh this many ms before nominal expiry. */
  skewMs?: number;
}

/**
 * Mints Google Ads access tokens from a long-lived refresh token.
 *
 * Tokens are cached until shortly before expiry, and concurrent
 * refreshes share a single in-flight request so a burst of tool calls does not
 * trigger a burst of token requests.
 */
export class OAuth2RefreshTokenProvider implements AccessTokenProvider {
  private readonly client: OAuth2Client;
  private readonly skewMs: number;
  private cached?: { token: string; expiresAtMs: number };
  private inFlight?: Promise<string>;

  constructor(options: OAuth2ProviderOptions) {
    this.client = new OAuth2Client({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    });
    this.client.setCredentials({ refresh_token: options.refreshToken });
    this.skewMs = options.skewMs ?? 60_000;
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && now < this.cached.expiresAtMs - this.skewMs) {
      return this.cached.token;
    }
    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async refresh(): Promise<string> {
    try {
      const { token, res } = await this.client.getAccessToken();
      if (!token) {
        throw new GoogleAdsApiError(
          'OAuth token refresh returned no access token. The refresh token may have been revoked.',
        );
      }
      const expiresInSeconds =
        (res?.data as { expires_in?: number } | undefined)?.expires_in ?? 3300;
      this.cached = { token, expiresAtMs: Date.now() + expiresInSeconds * 1000 };
      return token;
    } catch (err) {
      if (err instanceof GoogleAdsApiError) throw err;
      // Keep only the class name: OAuth error payloads can echo
      // client_secret and refresh_token back at us.
      throw new GoogleAdsApiError(
        'Failed to obtain a Google Ads access token. The refresh token may be expired ' +
          'or revoked. Check GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and ' +
          'GOOGLE_ADS_REFRESH_TOKEN, and mint a new refresh token if needed.',
        { hint: 'npm run get-refresh-token', causeName: errorName(err) },
      );
    }
  }
}

/** Static provider for tests. */
export class StaticAccessTokenProvider implements AccessTokenProvider {
  constructor(private readonly token: string) {}
  getAccessToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
}

export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

/** The target identity must be a service account, including for federated ADC. */
export function isServiceAccountClient(client: AuthClient): boolean {
  if (client instanceof UserRefreshClient || client instanceof ExternalAccountAuthorizedUserClient) return false;
  if (client instanceof JWT) return typeof client.email === 'string' && client.email.length > 0 && !client.subject;
  if (client instanceof Compute) return true;
  if (client instanceof Impersonated) return !!client.getTargetPrincipal();
  if (client instanceof BaseExternalAccountClient) return !!client.getServiceAccountEmail();
  return false;
}

export interface ServiceAccountProviderOptions {
  source: 'file' | 'json' | 'adc';
  key?: ServiceAccountKey;
  /** Narrow test seam for ADC identity and token exchange. */
  getAdcClient?: () => Promise<AuthClient>;
  createKeyClient?: (key: ServiceAccountKey) => AuthClient;
  skewMs?: number;
}

/** Only the error class name leaves the provider; messages can echo credential material. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export class ServiceAccountTokenProvider implements AccessTokenProvider {
  private client?: AuthClient;
  private readonly skewMs: number;
  private cached?: { token: string; expiresAtMs: number };
  private inFlight?: Promise<string>;

  constructor(private readonly options: ServiceAccountProviderOptions) {
    this.skewMs = options.skewMs ?? 60_000;
  }

  private async resolveClient(): Promise<AuthClient> {
    if (this.client) return this.client;
    try {
      if (this.options.source === 'adc') {
        const client = await (this.options.getAdcClient?.() ?? new GoogleAuth({ scopes: [GOOGLE_ADS_SCOPE] }).getClient());
        if (!isServiceAccountClient(client)) {
          throw new GoogleAdsApiError('Selected application default credentials must resolve to a service account or service-account impersonation.');
        }
        this.client = client;
      } else {
        if (!this.options.key) throw new GoogleAdsApiError('Service-account key credentials could not be obtained.');
        this.client = this.options.createKeyClient?.(this.options.key) ?? new JWT({
          email: this.options.key.client_email,
          key: this.options.key.private_key,
          scopes: [GOOGLE_ADS_SCOPE],
        });
      }
      return this.client;
    } catch (err) {
      if (err instanceof GoogleAdsApiError) throw err;
      throw new GoogleAdsApiError('Service-account credentials could not be obtained. Check the selected credential source.',
        { causeName: errorName(err) });
    }
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAtMs - this.skewMs) return this.cached.token;
    this.inFlight ??= this.refresh().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async refresh(): Promise<string> {
    try {
      const client = await this.resolveClient();
      const { token, res } = await client.getAccessToken();
      if (!token) throw new Error('empty token');
      const expiresInSeconds = (res?.data as { expires_in?: number } | undefined)?.expires_in;
      const expiresAtMs = client.credentials.expiry_date && client.credentials.expiry_date > Date.now()
        ? client.credentials.expiry_date : Date.now() + (expiresInSeconds ?? 3300) * 1000;
      this.cached = { token, expiresAtMs };
      return token;
    } catch (err) {
      if (err instanceof GoogleAdsApiError) throw err;
      throw new GoogleAdsApiError('Service-account credentials could not be obtained. Check the selected credential source.',
        { causeName: errorName(err) });
    }
  }
}

export function createTokenProvider(env: Env): AccessTokenProvider {
  return env.GOOGLE_ADS_AUTH_MODE === 'user'
    ? new OAuth2RefreshTokenProvider({
        clientId: env.GOOGLE_ADS_CLIENT_ID,
        clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
        refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
      })
    : new ServiceAccountTokenProvider({
        source: env.GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE,
        ...(env.serviceAccountKey && { key: env.serviceAccountKey }),
      });
}
