import { describe, it, expect } from 'vitest';
import { GoogleAdsRestClient } from '../../../src/google-ads/client.js';
import { createLogger } from '../../../src/audit/logger.js';
import { GoogleAdsApiError, TemporaryFailureError } from '../../../src/errors/tool-errors.js';
import type { AccessTokenProvider } from '../../../src/google-ads/auth.js';

const logger = createLogger({ level: 'silent' });

function client(tokenProvider: AccessTokenProvider, fetchImpl: typeof fetch): GoogleAdsRestClient {
  return new GoogleAdsRestClient({
    apiVersion: 'v25',
    developerToken: 'dev',
    loginCustomerId: '1234567890',
    tokenProvider,
    logger,
    fetchImpl,
  });
}

describe('credential failures are not disguised as network failures', () => {
  it('propagates an auth error instead of reporting "could not reach"', async () => {
    // The token is minted while building headers, inside the same try that catches
    // network errors. An expired refresh token must stay an actionable auth error.
    const failing: AccessTokenProvider = {
      getAccessToken: () =>
        Promise.reject(new GoogleAdsApiError('Failed to obtain a Google Ads access token.')),
    };
    let fetchCalls = 0;
    const spy: typeof fetch = () => {
      fetchCalls += 1;
      return Promise.resolve(new Response('{}', { status: 200 }));
    };

    await expect(
      client(failing, spy).search({ customerId: '1234567890', query: 'SELECT campaign.id FROM campaign' }),
    ).rejects.toMatchObject({ code: 'GOOGLE_ADS_API_ERROR' });

    // And it is not retried: no amount of backoff fixes a revoked token.
    expect(fetchCalls).toBe(0);
  });

  it('still reports a genuine network failure as TEMPORARY_FAILURE', async () => {
    const ok: AccessTokenProvider = { getAccessToken: () => Promise.resolve('token') };
    const failing: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));

    await expect(
      client(ok, failing).search({ customerId: '1234567890', query: 'SELECT campaign.id FROM campaign' }),
    ).rejects.toBeInstanceOf(TemporaryFailureError);
  }, 15000);
});
