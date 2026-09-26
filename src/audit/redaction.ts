/**
 * Credential redaction for structured logs.
 *
 * Two layers, because either alone is insufficient:
 *
 *  1. Path-based redaction catches credentials sitting in known fields.
 *  2. A literal-value scrubber catches a credential that lands somewhere unexpected -
 *     inside a free-text error message, for instance - which path redaction cannot see.
 */
export const REDACT_PATHS: string[] = [
  'authorization',
  'Authorization',
  'headers.authorization',
  'headers.Authorization',
  'headers["developer-token"]',
  'headers["login-customer-id"]',
  'developerToken',
  'developer_token',
  'refreshToken',
  'refresh_token',
  'clientSecret',
  'client_secret',
  'serviceAccountKey',
  'service_account_key',
  'serviceAccountKeyJson',
  'service_account_key_json',
  'privateKey',
  'private_key',
  'client_email',
  'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON',
  'accessToken',
  'access_token',
  'token',
  '*.authorization',
  '*.developerToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.serviceAccountKey',
  '*.service_account_key',
  '*.serviceAccountKeyJson',
  '*.service_account_key_json',
  '*.privateKey',
  '*.private_key',
  '*.client_email',
  '*.GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON',
  '*.accessToken',
  '*.token',
];

const REDACTED = '[REDACTED]';

/**
 * Build a function that replaces any occurrence of a known secret with a placeholder.
 *
 * Short values are ignored: redacting a 4-character string would corrupt unrelated
 * text without meaningfully protecting anything.
 */
export function makeSecretScrubber(secrets: readonly (string | undefined)[]): (value: unknown) => unknown {
  const real = secrets.filter((s): s is string => typeof s === 'string' && s.length >= 8);
  if (real.length === 0) return (value) => value;
  // Longest first so a secret that contains another is masked whole.
  const ordered = [...real].sort((a, b) => b.length - a.length);

  const scrubString = (input: string): string => {
    let out = input;
    for (const secret of ordered) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  };

  const scrub = (value: unknown, depth = 0): unknown => {
    if (depth > 12) return value;
    if (typeof value === 'string') return scrubString(value);
    if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = scrub(v, depth + 1);
      }
      return out;
    }
    return value;
  };

  return (value) => scrub(value);
}
