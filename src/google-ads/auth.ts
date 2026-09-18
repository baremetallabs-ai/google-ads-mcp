import { OAuth2Client } from 'google-auth-library';
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
 * The refresh token is the only credential held; there is no service-account path in
 * this version. Tokens are cached until shortly before expiry, and concurrent
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
      // Deliberately does not attach the cause: OAuth error payloads can echo
      // client_secret and refresh_token back at us.
      throw new GoogleAdsApiError(
        'Failed to obtain a Google Ads access token. The refresh token may be expired ' +
          'or revoked. Check GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and ' +
          'GOOGLE_ADS_REFRESH_TOKEN, and mint a new refresh token if needed.',
        { hint: 'npm run get-refresh-token' },
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
