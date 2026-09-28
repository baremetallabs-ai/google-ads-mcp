#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigurationError } from './config/env.js';
import { createMcpServer } from './mcp/server.js';
import { initializeRuntime } from './runtime.js';

async function main(): Promise<void> {
  // Everything below writes to stderr only. stdout is the MCP JSON-RPC channel.
  const deps = await initializeRuntime();
  const { server, report } = createMcpServer(deps);

  deps.logger.info(
    {
      allowlistedCustomerIds: deps.allowlist.list(),
      mutationsEnabled: deps.registry.mutationsGloballyEnabled,
      readTools: report.readTools.length,
      mutationTools: report.mutationTools.length,
    },
    'server_starting',
  );

  const stdio = new StdioServerTransport();
  await server.connect(stdio);

  const shutdown = (signal: string): void => {
    deps.logger.info({ signal }, 'server_shutdown');
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
    'google-ads-mcp failed to start unexpectedly.\n',
  );
  process.exit(1);
});
