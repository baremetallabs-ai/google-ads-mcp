import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema, type AppConfig } from '../capabilities/schema.js';
import { ConfigurationError } from './env.js';
import type { Env } from './env.js';
import { installBaseline } from '../capabilities/install-baseline.js';
import { MUTATION_TOOL_NAMES } from '../capabilities/tool-names.js';

/** Path to the configuration shipped with the server. */
export function defaultConfigPath(): string {
  return fileURLToPath(new URL('../capabilities/default-config.yaml', import.meta.url));
}

/**
 * Load and validate the capability configuration.
 *
 * Fails closed: a missing allowlist, a malformed mutations block, an unknown tool
 * name, an invalid constraint, or set_campaign_budget enabled without a master budget
 * all abort startup rather than degrading to a permissive default.
 */
export function loadConfig(explicitPath?: string): AppConfig {
  const path = explicitPath ?? defaultConfigPath();
  if (!existsSync(path)) {
    throw new ConfigurationError(
      `Capability configuration not found at ${path}. ` +
        'Set GOOGLE_ADS_MCP_CONFIG to point at your configuration file.',
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigurationError(
      `Capability configuration at ${path} is not valid YAML: ${(err as Error).message}`,
    );
  }

  if (raw === null || typeof raw !== 'object') {
    throw new ConfigurationError(`Capability configuration at ${path} is empty or not a mapping.`);
  }

  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigurationError(`Invalid capability configuration at ${path}:\n${issues}`);
  }

  return Object.freeze(parsed.data);
}

function assertNarrow(base: unknown, proposed: unknown, path: string): void {
  if (proposed === undefined || base === undefined) return;
  const fail = () => { throw new ConfigurationError(`${path} cannot exceed the install defaults; lower or remove this capability setting.`); };
  if (typeof base === 'number' && typeof proposed === 'number' && proposed > base) fail();
  if (typeof base === 'boolean' && typeof proposed === 'boolean') {
    const protective = path.endsWith('requireHttps') || path.endsWith('requireLpurlPlaceholder');
    if (protective ? base && !proposed : !base && proposed) fail();
  }
  if (Array.isArray(base) && Array.isArray(proposed)) {
    if (path.endsWith('blockedResources')) {
      if (base.some((item) => !proposed.includes(item))) fail();
    } else if (proposed.some((item) => !base.includes(item))) fail();
  }
  if (base && proposed && typeof base === 'object' && typeof proposed === 'object' &&
      !Array.isArray(base) && !Array.isArray(proposed)) {
    for (const [key, value] of Object.entries(proposed)) {
      assertNarrow((base as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
  }
}

/** Apply optional capability configuration only within the environment authority. */
export function loadInstallConfig(env: Env): AppConfig {
  if (!env.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS || !env.GOOGLE_ADS_INSTALL_MODE) {
    throw new ConfigurationError('Set GOOGLE_ADS_ALLOWED_CUSTOMER_IDS and GOOGLE_ADS_INSTALL_MODE for an install.');
  }
  const ids = env.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS.split(',');
  const baseline = installBaseline(ids, env.GOOGLE_ADS_INSTALL_MODE, env.GOOGLE_ADS_MASTER_BUDGET_MICROS);
  const inline = env.GOOGLE_ADS_CAPABILITIES_INLINE;
  const path = env.GOOGLE_ADS_MCP_CONFIG;
  if (!inline && !path) return baseline;
  let raw: unknown;
  try { raw = parseYaml(inline ?? readFileSync(path ?? '', 'utf8')); }
  catch { throw new ConfigurationError(`Invalid ${inline ? 'GOOGLE_ADS_CAPABILITIES_INLINE' : 'GOOGLE_ADS_MCP_CONFIG'}; provide readable YAML or JSON capability configuration.`); }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && baseline.budgets &&
      !Object.hasOwn(raw, 'budgets')) {
    raw = { ...raw, budgets: baseline.budgets };
  }
  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const setting = inline ? 'GOOGLE_ADS_CAPABILITIES_INLINE' : 'GOOGLE_ADS_MCP_CONFIG';
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'root'))].join(', ');
    throw new ConfigurationError(`Invalid ${setting} capability configuration at ${fields}; correct the policy fields.`);
  }
  const policy = parsed.data;
  if (policy.accounts.allowedCustomerIds.some((id) => !ids.includes(id))) {
    throw new ConfigurationError('Capability accounts.allowedCustomerIds must be a nonempty subset of GOOGLE_ADS_ALLOWED_CUSTOMER_IDS.');
  }
  if (policy.budgets) {
    if (BigInt(policy.budgets.masterBudgetMicros) <= 0n || !env.GOOGLE_ADS_MASTER_BUDGET_MICROS ||
        BigInt(policy.budgets.masterBudgetMicros) > BigInt(env.GOOGLE_ADS_MASTER_BUDGET_MICROS)) {
      throw new ConfigurationError('Capability budgets.masterBudgetMicros must be positive and not exceed GOOGLE_ADS_MASTER_BUDGET_MICROS.');
    }
  }
  assertNarrow(baseline.reads, policy.reads, 'reads');
  if (policy.mutations.enabled && !baseline.mutations.enabled) {
    throw new ConfigurationError('Capability mutations.enabled cannot enable read-only install mutations.');
  }
  for (const name of MUTATION_TOOL_NAMES) {
    const candidate = policy.mutations.tools[name];
    if (candidate) assertNarrow(baseline.mutations.tools[name], candidate, `mutations.tools.${name}`);
  }
  const effective = {
    ...policy,
    mutations: { ...policy.mutations, enabled: baseline.mutations.enabled && policy.mutations.enabled },
    budgets: policy.budgets ?? baseline.budgets,
  };
  return AppConfigSchema.parse(effective);
}
