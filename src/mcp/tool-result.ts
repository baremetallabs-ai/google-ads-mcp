import type { ToolError } from '../errors/tool-errors.js';

/**
 * MCP tool result envelope.
 *
 * Every tool returns both a machine-readable `structuredContent` and a concise
 * human-readable text block, so a client can render an understandable summary
 * without parsing the structure.
 */
export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function toolResult(structured: Record<string, unknown>): McpToolResult {
  const message = typeof structured.message === 'string' ? structured.message : undefined;
  return {
    content: [{ type: 'text', text: message ?? JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * Error result.
 *
 * `isError: true` means the MCP SDK skips output-schema validation, so the envelope
 * does not have to satisfy the success shape.
 */
export function toolErrorResult(
  error: ToolError,
  context: { customerId?: string; resourceType?: string } = {},
): McpToolResult {
  const envelope = error.toEnvelope();
  const structured: Record<string, unknown> = {
    success: false,
    ...(context.customerId !== undefined && { customerId: context.customerId }),
    ...(context.resourceType !== undefined && { resourceType: context.resourceType }),
    error: envelope,
  };
  return {
    content: [{ type: 'text', text: `${envelope.code}: ${envelope.message}` }],
    structuredContent: structured,
    isError: true,
  };
}
