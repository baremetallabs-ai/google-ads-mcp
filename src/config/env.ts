import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Deliberately NOT a strict object: process.env carries hundreds of unrelated keys.
 * We validate an explicitly picked subset instead. Only the YAML capability file is
 * strict, because that is the file an operator edits by hand.
 */
const Booleanish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

export const EnvSchema = z.object({
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().min(1, 'GOOGLE_ADS_DEVELOPER_TOKEN is required'),
  GOOGLE_ADS_CLIENT_ID: z.string().min(1, 'GOOGLE_ADS_CLIENT_ID is required'),
  GOOGLE_ADS_CLIENT_SECRET: z.string().min(1, 'GOOGLE_ADS_CLIENT_SECRET is required'),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().min(1, 'GOOGLE_ADS_REFRESH_TOKEN is required'),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z
    .string()
    .transform((s) => s.replace(/[-\s]/g, ''))
    .pipe(z.string().regex(/^\d{10}$/, 'GOOGLE_ADS_LOGIN_CUSTOMER_ID must be 10 digits')),
  GOOGLE_ADS_API_VERSION: z
    .string()
    .regex(/^v\d+$/, 'GOOGLE_ADS_API_VERSION must look like "v25"')
    .default('v25'),
  /** Emergency kill switch. Read-only tools keep working when this is false. */
  GOOGLE_ADS_MUTATIONS_ENABLED: Booleanish.default(true),
  GOOGLE_ADS_MCP_CONFIG: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

const ENV_KEYS = [
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  'GOOGLE_ADS_API_VERSION',
  'GOOGLE_ADS_MUTATIONS_ENABLED',
  'GOOGLE_ADS_MCP_CONFIG',
  'LOG_LEVEL',
] as const;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const picked: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== '') picked[key] = value;
  }
  const parsed = EnvSchema.safeParse(picked);
  if (!parsed.success) {
    // Report which variables are wrong, never their values.
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigurationError(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
