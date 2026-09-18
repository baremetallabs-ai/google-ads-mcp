import type { z } from 'zod';
import type { Logger, AuditLogger } from '../audit/logger.js';
import type { CustomerAllowlist } from '../authorization/customer-allowlist.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { AppConfig } from '../capabilities/schema.js';
import type { GoogleAdsTransport } from '../google-ads/types.js';
import type { McpToolResult } from '../mcp/tool-result.js';

/** Everything a tool handler needs. Constructed once at startup. */
export interface Deps {
  config: AppConfig;
  registry: CapabilityRegistry;
  allowlist: CustomerAllowlist;
  transport: GoogleAdsTransport;
  logger: Logger;
  audit: AuditLogger;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A read-only tool. */
export interface ReadToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
  handler(deps: Deps, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;
