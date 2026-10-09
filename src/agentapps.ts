import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from './mcp/server.js';
import { buildToolSet } from './mcp/register-tools.js';
import { initializeRuntime } from './runtime.js';

// Module evaluation is readiness: malformed settings or failed credential preflight abort it.
const deps = await initializeRuntime();
// Each stateless request needs its own server, but the tool schemas and handlers are fixed:
// build them once so a request costs only registration.
const tools = buildToolSet(deps);

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const { server } = createMcpServer(deps, tools);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  },
};
