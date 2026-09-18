import { z } from 'zod';
import { toolOutputSchema } from './output-schema.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MUTATION_TOOL_NAMES, type MutationToolName } from '../capabilities/tool-names.js';
import type { ToolDisabledReason } from '../errors/tool-errors.js';
import { READ_TOOLS } from './tools/read/index.js';
import { createReadHandler, READ_ANNOTATIONS } from './tools/read/framework.js';
import { MUTATION_TOOLS } from './tools/mutations/index.js';
import { createMutationHandler } from './tools/mutations/pipeline.js';
import type { Deps } from '../types/index.js';

export interface RegistrationReport {
  readTools: string[];
  mutationTools: string[];
  suppressed: { name: MutationToolName; reason: ToolDisabledReason }[];
}

/**
 * Register read tools always, and mutation tools only when explicitly enabled.
 *
 * Disabled tools are never registered, so they are absent from tools/list entirely -
 * the spec's preferred behaviour over registering and rejecting. A consequence worth
 * being explicit about: because an unregistered tool is rejected by the SDK before any
 * of our code runs, a call to one produces no audit event. The startup
 * `tool_registration_complete` record is the audit trail for suppression.
 */
export function registerTools(server: McpServer, deps: Deps): RegistrationReport {
  const report: RegistrationReport = { readTools: [], mutationTools: [], suppressed: [] };

  for (const def of READ_TOOLS) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: z.strictObject(def.inputSchema),
        outputSchema: toolOutputSchema(def.outputSchema),
        annotations: { title: def.title, ...READ_ANNOTATIONS },
      },
      createReadHandler(def, deps) as never,
    );
    report.readTools.push(def.name);
  }

  for (const name of MUTATION_TOOL_NAMES) {
    if (!deps.registry.isEnabled(name)) {
      report.suppressed.push({ name, reason: deps.registry.reasonFor(name) });
      continue;
    }
    // isEnabled() already proved the policy is present and enabled.
    const policy = deps.registry.assertEnabled(name);
    const def = MUTATION_TOOLS[name];
    // One strict schema, published and enforced. Strictness is what makes
    // "no custom approval arguments" visible to a client rather than only enforced
    // after the fact: the advertised JSON Schema carries additionalProperties: false.
    const inputSchema = z.strictObject(def.buildInputSchema(policy));
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        // Built from the policy, so published limits match enforced limits.
        inputSchema,
        outputSchema: toolOutputSchema(def.outputSchema),
        annotations: def.annotations,
      },
      createMutationHandler(def, policy, deps, inputSchema) as never,
    );
    report.mutationTools.push(name);
  }

  deps.logger.info(
    {
      readToolCount: report.readTools.length,
      mutationToolCount: report.mutationTools.length,
      mutationTools: report.mutationTools,
      suppressed: report.suppressed,
      mutationsGloballyEnabled: deps.registry.mutationsGloballyEnabled,
    },
    'tool_registration_complete',
  );

  return report;
}
