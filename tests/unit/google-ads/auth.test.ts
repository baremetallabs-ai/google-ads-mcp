import { describe, expect, it, vi } from 'vitest';
import { JWT, Compute, Impersonated, UserRefreshClient, ExternalAccountAuthorizedUserClient, OAuth2Client, BaseExternalAccountClient } from 'google-auth-library';
import { GOOGLE_ADS_SCOPE, OAuth2RefreshTokenProvider, ServiceAccountTokenProvider, isServiceAccountClient } from '../../../src/google-ads/auth.js';

const key = { type: 'service_account' as const, client_email: 'svc@example.iam.gserviceaccount.com', private_key: 'PRIVATE-SENTINEL' };
function fakeClient(token = 'ads-bearer') {
  return { credentials: { expiry_date: Date.now() + 3600_000 }, getAccessToken: vi.fn().mockResolvedValue({ token }) };
}

describe('service-account tokens', () => {
  it.each(['file', 'json'] as const)('mints and caches selected %s key token', async (source) => {
    const client = fakeClient();
    const createKeyClient = vi.fn(() => client as never);
    const provider = new ServiceAccountTokenProvider({ source, key, createKeyClient });
    expect(await Promise.all([provider.getAccessToken(), provider.getAccessToken()])).toEqual(['ads-bearer', 'ads-bearer']);
    expect(await provider.getAccessToken()).toBe('ads-bearer');
    expect(client.getAccessToken).toHaveBeenCalledTimes(1);
    expect(createKeyClient).toHaveBeenCalledWith(key);
  });
  it('shares ADC resolution and refresh, then uses the cached token', async () => {
    const client = new JWT({ email: key.client_email, key: key.private_key, scopes: [GOOGLE_ADS_SCOPE] });
    client.credentials.expiry_date = Date.now() + 3600_000;
    const exchange = vi.spyOn(client, 'getAccessToken').mockResolvedValue({ token: 'adc-bearer', res: { data: { expires_in: 3600 } } } as never);
    const getAdcClient = vi.fn().mockResolvedValue(client);
    const provider = new ServiceAccountTokenProvider({ source: 'adc', getAdcClient });
    expect(await Promise.all([provider.getAccessToken(), provider.getAccessToken()])).toEqual(['adc-bearer', 'adc-bearer']);
    expect(await provider.getAccessToken()).toBe('adc-bearer');
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(getAdcClient).toHaveBeenCalledTimes(1);
    expect(client.scopes).toEqual([GOOGLE_ADS_SCOPE]);
  });
  it('classifies target identities and rejects user or unknown ADC', async () => {
    expect(isServiceAccountClient(new JWT({ email: key.client_email, key: key.private_key }))).toBe(true);
    expect(isServiceAccountClient(new Compute())).toBe(true);
    expect(isServiceAccountClient(new UserRefreshClient())).toBe(false);
    expect(isServiceAccountClient(new ExternalAccountAuthorizedUserClient({ type: 'external_account_authorized_user', client_id: 'id', client_secret: 'secret', refresh_token: 'token', token_url: 'https://example.com' } as never))).toBe(false);
    expect(isServiceAccountClient({} as never)).toBe(false);
    const external = Object.create(BaseExternalAccountClient.prototype) as BaseExternalAccountClient;
    external.getServiceAccountEmail = () => key.client_email;
    expect(isServiceAccountClient(external)).toBe(true);
    external.getServiceAccountEmail = () => null;
    expect(isServiceAccountClient(external)).toBe(false);
    const impersonated = Object.create(Impersonated.prototype) as Impersonated;
    impersonated.getTargetPrincipal = () => key.client_email;
    expect(isServiceAccountClient(impersonated)).toBe(true);
    impersonated.getTargetPrincipal = () => '';
    expect(isServiceAccountClient(impersonated)).toBe(false);
    const provider = new ServiceAccountTokenProvider({ source: 'adc', getAdcClient: () => Promise.resolve(new UserRefreshClient()) });
    await expect(provider.getAccessToken()).rejects.toThrow('must resolve to a service account');
  });
  it('builds a key JWT with only the Ads scope', async () => {
    const exchange = vi.spyOn(JWT.prototype, 'getAccessToken').mockImplementation(function (this: JWT) {
      expect(this.scopes).toEqual([GOOGLE_ADS_SCOPE]);
      expect(this.subject).toBeUndefined();
      return Promise.resolve({ token: 'key-bearer', res: { data: { expires_in: 3600 } } }) as never;
    });
    const provider = new ServiceAccountTokenProvider({ source: 'json', key });
    expect(await provider.getAccessToken()).toBe('key-bearer');
    exchange.mockRestore();
  });
  it('hides library errors and empty tokens', async () => {
    for (const getAccessToken of [vi.fn().mockRejectedValue(new Error('PRIVATE-SENTINEL')), vi.fn().mockResolvedValue({ token: '' })]) {
      const provider = new ServiceAccountTokenProvider({ source: 'json', key, createKeyClient: () => ({ credentials: {}, getAccessToken }) as never });
      await expect(provider.getAccessToken()).rejects.toThrow('credentials could not be obtained');
      await expect(provider.getAccessToken()).rejects.not.toThrow('PRIVATE-SENTINEL');
    }
  });
});

describe('user token cache', () => {
  it('shares refresh and caches token', async () => {
    const spy = vi.spyOn(OAuth2Client.prototype, 'getAccessToken').mockResolvedValue({ token: 'user-bearer', res: { data: { expires_in: 3600 } } } as never);
    const provider = new OAuth2RefreshTokenProvider({ clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' });
    expect(await Promise.all([provider.getAccessToken(), provider.getAccessToken()])).toEqual(['user-bearer', 'user-bearer']);
    expect(await provider.getAccessToken()).toBe('user-bearer');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
