import { z } from 'zod';

/**
 * Build the published output schema for a tool.
 *
 * Two constraints from the MCP SDK shape this:
 *
 *  1. `outputSchema` must be an object schema. A union (a success variant and an
 *     error variant) has no object root, so clients cannot treat `structuredContent`
 *     as a record of named fields.
 *
 *  2. The server skips output validation for `isError: true` results, but a strict
 *     *client* validates `structuredContent` against the advertised schema either
 *     way. So the one schema has to admit the error envelope too, or every failure
 *     becomes a protocol error at the client.
 *
 * The resolution is a single object that declares every field a tool can return,
 * with the payload fields optional and `success` plus `error` always present as
 * options. Field names and types stay advertised, which is what a client actually
 * uses the schema for.
 */
export function toolOutputSchema(shape: z.ZodRawShape): z.ZodObject {
  const optional: Record<string, z.ZodType> = {};
  for (const [key, schema] of Object.entries(shape)) {
    optional[key] = (schema as z.ZodType).optional();
  }
  // A plain (non-strict) object, matching how SDK 1.x wrapped a raw output shape.
  return z.object({
    ...optional,
    success: z.boolean().optional().describe('False when the call failed; see `error`.'),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .optional()
      .describe('Present only on failure. `code` is a stable machine-readable error code.'),
  });
}
