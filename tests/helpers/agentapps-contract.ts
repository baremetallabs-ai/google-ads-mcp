import { z } from 'zod';

// Snapshot for the module entry from sovereign-ai commit 0ba289d3af4b4278c6895125a131c70ec2b97157:
// packages/agent-apps-contracts/src/index.ts and packages/agent-apps-mcp/src/app-client.ts.
// Only the module-entry branch of the upstream union is needed by this private entry.
const primitive = z.union([z.string(), z.number(), z.boolean()]);
const jsonObject = z.custom<Record<string, unknown>>((value) => value !== null &&
  typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)));

const EnvironmentVariableSchema = z.object({
  name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  description: z.string().optional(),
  isSecret: z.boolean(),
  isRequired: z.boolean(),
  format: z.enum(['string', 'number', 'boolean', 'filepath']),
  choices: z.array(primitive).min(1).optional(),
  default: primitive.optional(),
}).strict().superRefine((variable, context) => {
  if (variable.isSecret && variable.default !== undefined)
    context.addIssue({ code: 'custom', message: 'secret_default_unsupported' });
  const expectedType = variable.format === 'filepath' ? 'string' : variable.format;
  if (variable.default !== undefined && typeof variable.default !== expectedType)
    context.addIssue({ code: 'custom', message: 'variable_default_type_mismatch' });
  if (variable.choices?.some((choice) => typeof choice !== expectedType))
    context.addIssue({ code: 'custom', message: 'variable_choice_type_mismatch' });
  if (variable.default !== undefined && variable.choices && !variable.choices.includes(variable.default))
    context.addIssue({ code: 'custom', message: 'variable_default_not_allowed' });
});

const DeclaredToolSchema = z.object({
  name: z.string().min(1), description: z.string().min(1),
  externalDescription: z.string().min(1).optional(),
  inputSchema: jsonObject.optional(), outputSchema: jsonObject.optional(),
}).strict();

export const ServerManifestSchema = z.object({
  name: z.string().min(1), version: z.string().min(1), description: z.string().min(1),
  repository: z.object({ url: z.url(), subfolder: z.string().min(1).optional() }).strict().optional(),
  packages: z.array(z.object({
    registryType: z.enum(['npm', 'pypi']), identifier: z.string().min(1),
    version: z.string().min(1), transport: z.object({ type: z.literal('stdio') }).strict(),
    environmentVariables: z.array(EnvironmentVariableSchema).optional(),
  }).strict()),
  _meta: z.object({ 'ai.baremetal/agentapps': z.object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(48),
    callerContext: z.enum(['none', 'session', 'inbound']).optional(),
    handlesMissingCallerContext: z.literal(true).optional(),
    deliveryProgress: z.literal(true).optional(),
    runtime: z.literal('process'),
    entry: z.object({ module: z.string().min(1) }).strict(),
    state: z.enum(['none', 'kv']),
    egress: z.array(z.string().regex(/^[a-z0-9.-]+:\d+$/i)),
    startup: z.object({ attempts: z.number().int().positive(), intervalMs: z.number().int().positive() }).strict(),
    limits: z.object({ memoryMb: z.number().int().positive(), cpu: z.string().min(1) }).strict(),
    idle: z.object({ reapAfterMs: z.number().int().positive() }).strict(),
    environmentVariables: z.array(EnvironmentVariableSchema),
    compatibility: z.object({ era: z.literal('modern'), requiredClientCapabilities: z.array(z.literal('elicitation.url')).default([]) }).strict(),
    externalInstructions: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 2048).optional(),
    tools: z.array(DeclaredToolSchema).min(1),
  }).strict() }).strict(),
}).strict().superRefine((manifest, context) => {
  const profile = manifest._meta['ai.baremetal/agentapps'];
  if (manifest.packages.length !== 0) context.addIssue({ code: 'custom', message: 'module_packages_must_be_empty' });
  for (const values of [profile.environmentVariables.map((v) => v.name), profile.tools.map((t) => t.name)]) {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'duplicate_variable_or_tool' });
  }
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The four-field configured-start match from app-client.ts, ignoring presentation metadata. */
export function matchesDeclaredTools(declared: unknown[], discovered: unknown[]): boolean {
  const names = (values: unknown[]) => new Map(values.map((item) => [
    (item as { name: string }).name, item as Record<string, unknown>,
  ]));
  const expected = names(declared), actual = names(discovered);
  if (expected.size !== declared.length || actual.size !== discovered.length || declared.length !== discovered.length) return false;
  for (const [name, declaration] of expected) {
    const descriptor = actual.get(name);
    if (!descriptor || descriptor.description !== declaration.description) return false;
    for (const field of ['inputSchema', 'outputSchema'] as const) {
      if (canonical({ present: Object.hasOwn(descriptor, field), value: descriptor[field] ?? null }) !==
          canonical({ present: Object.hasOwn(declaration, field), value: declaration[field] ?? null })) return false;
    }
  }
  return true;
}
