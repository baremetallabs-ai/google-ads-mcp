import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, type RegistrationReport } from './register-tools.js';
import type { Deps } from '../types/index.js';

export const SERVER_NAME = 'google-ads-mcp';
export const SERVER_VERSION = '0.1.0';

export interface BuiltServer {
  server: McpServer;
  report: RegistrationReport;
}

/** Build the MCP server and register the tools this configuration permits. */
export function createMcpServer(deps: Deps): BuiltServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const report = registerTools(server, deps);
  return { server, report };
}
