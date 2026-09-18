#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAuditLogger, createLogger } from './audit/logger.js';
import { CustomerAllowlist } from './authorization/customer-allowlist.js';
import { CapabilityRegistry } from './capabilities/registry.js';
import { ConfigurationError, loadEnv } from './config/env.js';
import { loadConfig } from './config/load-config.js';
import { OAuth2RefreshTokenProvider } from './google-ads/auth.js';
import { GoogleAdsRestClient } from './google-ads/client.js';
import { createMcpServer } from './mcp/server.js';
import type { Deps } from './types/index.js';

async function main(): Promise<void> {
  // Everything below writes to stderr only. stdout is the MCP JSON-RPC channel.
  const env = loadEnv();
  const config = loadConfig(env.GOOGLE_ADS_MCP_CONFIG);

  const logger = createLogger({
    level: env.LOG_LEVEL,
    secrets: [
      env.GOOGLE_ADS_DEVELOPER_TOKEN,
      env.GOOGLE_ADS_CLIENT_SECRET,
      env.GOOGLE_ADS_REFRESH_TOKEN,
    ],
  });

  const registry = new CapabilityRegistry(config, env.GOOGLE_ADS_MUTATIONS_ENABLED);
  const allowlist = new CustomerAllowlist(config.accounts.allowedCustomerIds);

  const transport = new GoogleAdsRestClient({
    apiVersion: env.GOOGLE_ADS_API_VERSION,
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    tokenProvider: new OAuth2RefreshTokenProvider({
      clientId: env.GOOGLE_ADS_CLIENT_ID,
      clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
      refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
    }),
    defaultTimeoutMs: config.reads.requestTimeoutMs,
    maxPages: config.reads.maxPages,
    logger,
  });

  const deps: Deps = {
    config,
    registry,
    allowlist,
    transport,
    logger,
    audit: createAuditLogger(logger),
  };

  const { server, report } = createMcpServer(deps);

  logger.info(
    {
      apiVersion: env.GOOGLE_ADS_API_VERSION,
      loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
      allowlistedCustomerIds: allowlist.list(),
      mutationsEnabled: registry.mutationsGloballyEnabled,
      readTools: report.readTools.length,
      mutationTools: report.mutationTools.length,
    },
    'server_starting',
  );

  const stdio = new StdioServerTransport();
  await server.connect(stdio);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'server_shutdown');
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigurationError) {
    // Configuration problems are the operator's to fix; print plainly and fail closed.
    process.stderr.write(`${err.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(
    `google-ads-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
