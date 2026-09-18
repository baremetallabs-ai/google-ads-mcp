import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema, type AppConfig } from '../capabilities/schema.js';
import { ConfigurationError } from './env.js';

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
