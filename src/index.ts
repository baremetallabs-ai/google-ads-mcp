#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigurationError } from './config/env.js';
import { buildToolSet } from './mcp/register-tools.js';
import { createMcpServer } from './mcp/server.js';
import { initializeRuntime } from './runtime.js';

async function main(): Promise<void> {
  // Everything below writes to stderr only. stdout is the MCP JSON-RPC channel.
  const deps = await initializeRuntime();
  const tools = buildToolSet(deps);
  const { report } = tools;

  deps.logger.info(
    {
      allowlistedCustomerIds: deps.allowlist.list(),
      mutationsEnabled: deps.registry.mutationsGloballyEnabled,
      readTools: report.readTools.length,
      mutationTools: report.mutationTools.length,
    },
    'server_starting',
  );

  // serveStdio owns the era decision: the opening exchange selects the 2026-07-28
  // (server/discover) or 2025 (initialize) era, and one server from the factory is pinned
  // for the connection. Local clients still largely speak 2025, so both eras are served.
  const connection = serveStdio(() => createMcpServer(deps, tools).server, {
    onerror: (error) => {
      deps.logger.error({ err: error.message }, 'stdio_transport_error');
    },
  });

  const shutdown = (signal: string): void => {
    deps.logger.info({ signal }, 'server_shutdown');
    void connection.close().finally(() => process.exit(0));
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
