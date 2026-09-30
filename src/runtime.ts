import { createAuditLogger, createLogger } from './audit/logger.js';
import { CustomerAllowlist } from './authorization/customer-allowlist.js';
import { CapabilityRegistry } from './capabilities/registry.js';
import { ConfigurationError, loadEnv, readEnvSetting } from './config/env.js';
import { loadConfig, loadInstallConfig } from './config/load-config.js';
import { createTokenProvider } from './google-ads/auth.js';
import { GoogleAdsApiError } from './errors/tool-errors.js';
import { GoogleAdsRestClient } from './google-ads/client.js';
import type { Deps } from './types/index.js';
import type { AccessTokenProvider } from './google-ads/auth.js';

/** Validate all settings and credentials before either MCP transport becomes ready. */
export async function initializeRuntime(sourceEnv: NodeJS.ProcessEnv = process.env): Promise<Deps> {
  const env = loadEnv(sourceEnv);
  const installing = env.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS !== undefined || env.GOOGLE_ADS_INSTALL_MODE !== undefined;
  const config = installing ? loadInstallConfig(env) : loadConfig(env.GOOGLE_ADS_MCP_CONFIG);
  const logger = createLogger({
    level: env.LOG_LEVEL,
    secrets: [env.GOOGLE_ADS_DEVELOPER_TOKEN, env.GOOGLE_ADS_CLIENT_SECRET,
      env.GOOGLE_ADS_REFRESH_TOKEN, env.GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON,
      env.GOOGLE_ADS_CAPABILITIES_INLINE,
      env.GOOGLE_ADS_AUTH_MODE === 'service_account' ? env.serviceAccountKey?.private_key : undefined],
  });
  const registry = new CapabilityRegistry(config, env.GOOGLE_ADS_MUTATIONS_ENABLED,
    installing && env.GOOGLE_ADS_INSTALL_MODE === 'read_only');
  const allowlist = new CustomerAllowlist(config.accounts.allowedCustomerIds);
  let tokenProvider: AccessTokenProvider;
  const testMode = readEnvSetting(sourceEnv, 'NODE_ENV');
  const testEndpoint = readEnvSetting(sourceEnv, 'GOOGLE_ADS_MCP_TEST_TOKEN_ENDPOINT');
  try {
    // A loopback token exchange used only by the controlled process test. AgentApps
    // does not declare either setting and its egress policy excludes loopback.
    if (testMode === 'test' && testEndpoint) {
      const endpoint = new URL(testEndpoint);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
        throw new Error('Test token endpoint must be loopback');
      }
      tokenProvider = { getAccessToken: async () => {
        const response = await fetch(endpoint, { method: 'POST' });
        if (!response.ok) throw new Error('Test token exchange failed');
        const payload = await response.json() as { access_token?: unknown };
        if (typeof payload.access_token !== 'string' || !payload.access_token) throw new Error('No test access token');
        return payload.access_token;
      } };
    } else {
      tokenProvider = createTokenProvider(env);
    }
    await tokenProvider.getAccessToken();
  } catch (err) {
    logger.error({ causeName: err instanceof GoogleAdsApiError ? err.details.causeName : undefined },
      'credential_exchange_failed');
    throw new ConfigurationError(err instanceof GoogleAdsApiError ? err.message
      : 'Google Ads credentials could not be obtained. Check the selected authentication settings.');
  }
  const transport = new GoogleAdsRestClient({
    apiVersion: env.GOOGLE_ADS_API_VERSION,
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    tokenProvider,
    defaultTimeoutMs: config.reads.requestTimeoutMs,
    maxPages: config.reads.maxPages,
    logger,
  });
  return { config, registry, allowlist, transport, logger, audit: createAuditLogger(logger) };
}
