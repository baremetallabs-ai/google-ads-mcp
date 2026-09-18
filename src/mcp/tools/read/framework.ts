import { z } from 'zod';
import { toToolError } from '../../../google-ads/errors.js';
import { toolErrorResult, toolResult, type McpToolResult } from '../../tool-result.js';
import type { Deps, ReadToolDefinition } from '../../../types/index.js';

/**
 * Wrap a read tool definition into an MCP handler.
 *
 * Reads authorize the customer the same way mutations do - the allowlist is not a
 * mutation-only control - but they do not emit audit events; they are logged at debug
 * level instead.
 */
export function createReadHandler(def: ReadToolDefinition, deps: Deps) {
  return async (args: Record<string, unknown>): Promise<McpToolResult> => {
    const started = Date.now();
    let customerId: string | undefined;
    try {
      const parsed = z.strictObject(def.inputSchema).parse(args ?? {}) as Record<string, unknown>;
      if (typeof parsed.customerId === 'string') {
        customerId = deps.allowlist.authorize(parsed.customerId);
        parsed.customerId = customerId;
      }
      const structured = await def.handler(deps, parsed);
      deps.logger.debug(
        { tool: def.name, customerId, durationMs: Date.now() - started },
        'read_tool_call',
      );
      return toolResult(structured);
    } catch (err) {
      const toolError = toToolError(err);
      deps.logger.warn(
        {
          tool: def.name,
          customerId,
          errorCode: toolError.code,
          durationMs: Date.now() - started,
        },
        'read_tool_error',
      );
      return toolErrorResult(toolError, { ...(customerId !== undefined && { customerId }) });
    }
  };
}

/** Annotations every read tool carries. */
export const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
