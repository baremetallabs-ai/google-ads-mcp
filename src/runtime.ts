import { createAuditLogger, createLogger } from './audit/logger.js';
import { CustomerAllowlist } from './authorization/customer-allowlist.js';
import { CapabilityRegistry } from './capabilities/registry.js';
import { ConfigurationError, loadEnv } from './config/env.js';
import { loadConfig, loadInstallConfig } from './config/load-config.js';
import { createTokenProvider } from './google-ads/auth.js';
import { GoogleAdsApiError } from './errors/tool-errors.js';
import { GoogleAdsRestClient } from './google-ads/client.js';
import type { Deps } from './types/index.js';

/** Validate all settings and credentials before either MCP transport becomes ready. */
export async function initializeRuntime(sourceEnv: NodeJS.ProcessEnv = process.env): Promise<Deps> {
  const env = loadEnv(sourceEnv);
  const installing = sourceEnv.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS !== undefined || sourceEnv.GOOGLE_ADS_INSTALL_MODE !== undefined;
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
  let tokenProvider;
  try {
    tokenProvider = createTokenProvider(env);
    await tokenProvider.getAccessToken();
  } catch (err) {
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
