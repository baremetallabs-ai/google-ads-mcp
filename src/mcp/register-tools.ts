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

/** The fixed tool contract, built once and registered onto each per-request server. */
export interface ToolSet {
  report: RegistrationReport;
  register(server: McpServer): void;
}

/**
 * Build the fixed read and mutation tool contract in every mode.
 */
export function buildToolSet(deps: Deps): ToolSet {
  const report: RegistrationReport = { readTools: [], mutationTools: [], suppressed: [] };
  const tools: ((server: McpServer) => void)[] = [];

  for (const def of READ_TOOLS) {
    const config = {
      title: def.title,
      description: def.description,
      inputSchema: z.strictObject(def.inputSchema),
      outputSchema: toolOutputSchema(def.outputSchema),
      annotations: { title: def.title, ...READ_ANNOTATIONS },
    };
    const handler = createReadHandler(def, deps) as never;
    tools.push((server) => {
      server.registerTool(def.name, config, handler);
    });
    report.readTools.push(def.name);
  }

  for (const name of MUTATION_TOOL_NAMES) {
    if (!deps.registry.isEnabled(name)) {
      report.suppressed.push({ name, reason: deps.registry.reasonFor(name) });
    }
    const def = MUTATION_TOOLS[name];
    // One strict schema, published and enforced. Strictness is what makes
    // "no custom approval arguments" visible to a client rather than only enforced
    // after the fact: the advertised JSON Schema carries additionalProperties: false.
    const inputSchema = z.strictObject(def.buildInputSchema());
    const config = {
      title: def.title,
      description: def.description,
      // Fixed descriptor; narrower policy is enforced in the handler.
      inputSchema,
      outputSchema: toolOutputSchema(def.outputSchema),
      annotations: def.annotations,
    };
    const handler = createMutationHandler(def, deps, inputSchema) as never;
    tools.push((server) => {
      server.registerTool(def.name, config, handler);
    });
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

  return {
    report,
    register(server) {
      for (const add of tools) add(server);
    },
  };
}
