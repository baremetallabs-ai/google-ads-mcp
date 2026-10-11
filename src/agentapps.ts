import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from './mcp/server.js';
import { buildToolSet } from './mcp/register-tools.js';
import { initializeRuntime } from './runtime.js';

// Module evaluation is readiness: malformed settings or failed credential preflight abort it.
const deps = await initializeRuntime();
// Each request gets its own server from the factory, but the tool schemas and handlers are
// fixed: build them once so a request costs only registration.
const tools = buildToolSet(deps);

// The AgentApps cell pins the modern protocol era (2026-07-28: server/discover, no
// initialize), and server.json declares compatibility.era "modern". Serve that era only,
// so the endpoint never exposes an unqualified 2025-era surface.
const handler = createMcpHandler(() => createMcpServer(deps, tools).server, {
  legacy: 'reject',
  // No tool emits mid-call notifications; answer every exchange with one JSON body.
  responseMode: 'json',
  onerror: (error) => {
    deps.logger.warn({ err: error.message }, 'mcp_handler_error');
  },
});

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
    return handler.fetch(request);
  },
};
