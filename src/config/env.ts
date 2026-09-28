import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CustomerIdSchema, MicrosStringSchema } from '../capabilities/schema.js';

const Booleanish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');
const Setting = z.string().trim().min(1);
const ManagerId = z.string().transform((s) => s.replace(/[-\s]/g, '')).pipe(z.string().regex(/^\d{10}$/));

export const EnvSchema = z.object({
  GOOGLE_ADS_AUTH_MODE: z.enum(['user', 'service_account']).optional(),
  GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE: z.enum(['file', 'json', 'adc']).optional(),
  GOOGLE_ADS_SERVICE_ACCOUNT_KEY_FILE: Setting.optional(),
  GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON: Setting.optional(),
  GOOGLE_APPLICATION_CREDENTIALS: Setting.optional(),
  GOOGLE_ADS_DEVELOPER_TOKEN: Setting.optional(),
  GOOGLE_ADS_CLIENT_ID: Setting.optional(),
  GOOGLE_ADS_CLIENT_SECRET: Setting.optional(),
  GOOGLE_ADS_REFRESH_TOKEN: Setting.optional(),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: ManagerId.optional(),
  GOOGLE_ADS_API_VERSION: z.string().regex(/^v\d+$/).default('v25'),
  GOOGLE_ADS_MUTATIONS_ENABLED: Booleanish.default(true),
  GOOGLE_ADS_MCP_CONFIG: Setting.optional(),
  GOOGLE_ADS_INSTALL_MODE: z.enum(['read_only', 'mutations']).optional(),
  GOOGLE_ADS_ALLOWED_CUSTOMER_IDS: Setting.optional(),
  GOOGLE_ADS_MASTER_BUDGET_MICROS: Setting.optional(),
  GOOGLE_ADS_CAPABILITIES_INLINE: Setting.optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

type BaseEnv = z.infer<typeof EnvSchema>;
export interface ServiceAccountKey { client_email: string; private_key: string; type: 'service_account' }
export type Env = BaseEnv & (
  | { GOOGLE_ADS_AUTH_MODE: 'user'; GOOGLE_ADS_CLIENT_ID: string; GOOGLE_ADS_CLIENT_SECRET: string; GOOGLE_ADS_REFRESH_TOKEN: string; GOOGLE_ADS_LOGIN_CUSTOMER_ID: string }
  | { GOOGLE_ADS_AUTH_MODE: 'service_account'; GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE: 'file' | 'json' | 'adc'; serviceAccountKey?: ServiceAccountKey }
);

const ENV_KEYS = [
  'GOOGLE_ADS_AUTH_MODE', 'GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE',
  'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_FILE', 'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID', 'GOOGLE_ADS_API_VERSION',
  'GOOGLE_ADS_MUTATIONS_ENABLED', 'GOOGLE_ADS_MCP_CONFIG', 'LOG_LEVEL',
  'GOOGLE_ADS_INSTALL_MODE', 'GOOGLE_ADS_ALLOWED_CUSTOMER_IDS',
  'GOOGLE_ADS_MASTER_BUDGET_MICROS', 'GOOGLE_ADS_CAPABILITIES_INLINE',
] as const;

export class ConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigurationError'; }
}

function parseKey(raw: string, setting: string): ServiceAccountKey {
  let key: unknown;
  try { key = JSON.parse(raw); } catch { throw new ConfigurationError(`${setting} must contain a valid service-account JSON key.`); }
  if (key === null || typeof key !== 'object' ||
      (key as Record<string, unknown>).type !== 'service_account' ||
      typeof (key as Record<string, unknown>).client_email !== 'string' ||
      !((key as Record<string, string>).client_email ?? '').trim() ||
      typeof (key as Record<string, unknown>).private_key !== 'string' ||
      !((key as Record<string, string>).private_key ?? '').trim()) {
    throw new ConfigurationError(`${setting} must contain a service-account key with client_email and private_key.`);
  }
  return key as ServiceAccountKey;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source.GOOGLE_ADS_CAPABILITIES_INLINE !== undefined && source.GOOGLE_ADS_MCP_CONFIG !== undefined) {
    throw new ConfigurationError('Set only one of GOOGLE_ADS_CAPABILITIES_INLINE or GOOGLE_ADS_MCP_CONFIG.');
  }
  const picked: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && (value !== '' ||
        ['GOOGLE_ADS_ALLOWED_CUSTOMER_IDS', 'GOOGLE_ADS_INSTALL_MODE',
          'GOOGLE_ADS_MASTER_BUDGET_MICROS', 'GOOGLE_ADS_CAPABILITIES_INLINE',
          'GOOGLE_ADS_MCP_CONFIG'].includes(key))) picked[key] = value;
  }
  const parsed = EnvSchema.safeParse(picked);
  if (!parsed.success) {
    throw new ConfigurationError('Invalid environment configuration: ' +
      [...new Set(parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`))].join(', '));
  }
  const env = parsed.data;
  const installing = source.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS !== undefined || source.GOOGLE_ADS_INSTALL_MODE !== undefined;
  if (installing) {
    if (!env.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS) {
      throw new ConfigurationError('Set GOOGLE_ADS_ALLOWED_CUSTOMER_IDS to at least one real ten-digit customer ID.');
    }
    const ids = env.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS.split(',').map((id) => CustomerIdSchema.safeParse(id));
    const normalized = ids.map((id) => id.success ? id.data : '');
    const placeholders = new Set(['1234567890', '2345678901']);
    if (normalized.some((id) => !id || placeholders.has(id) || /^(\d)\1{9}$/.test(id)) ||
        new Set(normalized).size !== normalized.length) {
      throw new ConfigurationError('GOOGLE_ADS_ALLOWED_CUSTOMER_IDS must contain unique, real ten-digit customer IDs.');
    }
    env.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS = normalized.join(',');
    env.GOOGLE_ADS_INSTALL_MODE ??= 'read_only';
    if (env.GOOGLE_ADS_MASTER_BUDGET_MICROS !== undefined) {
      const ceiling = MicrosStringSchema.safeParse(env.GOOGLE_ADS_MASTER_BUDGET_MICROS);
      if (!ceiling.success || BigInt(ceiling.data) <= 0n) {
        throw new ConfigurationError('GOOGLE_ADS_MASTER_BUDGET_MICROS must be a positive decimal micros amount.');
      }
    } else if (env.GOOGLE_ADS_INSTALL_MODE === 'mutations') {
      throw new ConfigurationError('Set GOOGLE_ADS_MASTER_BUDGET_MICROS to a positive ceiling for mutation mode.');
    }
  }
  const present = (key: keyof BaseEnv): boolean => env[key] !== undefined;
  const userKeys = ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN'] as const;
  const serviceKeys = ['GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE', 'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_FILE', 'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON', 'GOOGLE_APPLICATION_CREDENTIALS'] as const;
  const mode = env.GOOGLE_ADS_AUTH_MODE;
  if (!mode) {
    const missing = [...userKeys, 'GOOGLE_ADS_LOGIN_CUSTOMER_ID' as const].filter((key) => !present(key));
    const conflicting = serviceKeys.filter(present);
    if (missing.length || conflicting.length) {
      throw new ConfigurationError('Set GOOGLE_ADS_AUTH_MODE to select one complete credential mode.' +
        (missing.length ? ` Missing user settings: ${missing.join(', ')}.` : '') +
        (conflicting.length ? ` Supplied service-account settings: ${conflicting.join(', ')}.` : ''));
    }
    return { ...env, GOOGLE_ADS_AUTH_MODE: 'user' } as Env;
  }
  if (mode === 'user') {
    const conflicts = serviceKeys.filter(present);
    if (conflicts.length) throw new ConfigurationError(`GOOGLE_ADS_AUTH_MODE=user does not accept ${conflicts.join(', ')}.`);
    const missing = [...userKeys, 'GOOGLE_ADS_LOGIN_CUSTOMER_ID' as const].filter((key) => !present(key));
    if (missing.length) throw new ConfigurationError(`Missing required user settings: ${missing.join(', ')}.`);
    return env as Env;
  }
  const conflicts = userKeys.filter(present);
  if (conflicts.length) throw new ConfigurationError(`GOOGLE_ADS_AUTH_MODE=service_account does not accept ${conflicts.join(', ')}.`);
  const selected = env.GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE;
  if (!selected) throw new ConfigurationError('Set GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE to file, json, or adc.');
  const forbidden = selected === 'file'
    ? ['GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON', 'GOOGLE_APPLICATION_CREDENTIALS'] as const
    : selected === 'json'
      ? ['GOOGLE_ADS_SERVICE_ACCOUNT_KEY_FILE', 'GOOGLE_APPLICATION_CREDENTIALS'] as const
      : ['GOOGLE_ADS_SERVICE_ACCOUNT_KEY_FILE', 'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON'] as const;
  const supplied = forbidden.filter(present);
  if (supplied.length) throw new ConfigurationError(`GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE=${selected} does not accept ${supplied.join(', ')}.`);
  if (selected === 'adc') return env as Env;
  const setting = selected === 'file' ? 'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_FILE' : 'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON';
  const value = env[setting];
  if (!value) throw new ConfigurationError(`${setting} is required.`);
  let raw = value;
  if (selected === 'file') {
    try { raw = readFileSync(value, 'utf8'); }
    catch { throw new ConfigurationError(`${setting} must name a readable service-account key file.`); }
  }
  return { ...env, serviceAccountKey: parseKey(raw, setting) } as Env;
}
