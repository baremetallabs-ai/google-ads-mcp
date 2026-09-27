import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationError, loadEnv } from '../../../src/config/env.js';

const key = JSON.stringify({ type: 'service_account', client_email: 'svc@example.iam.gserviceaccount.com', private_key: 'PRIVATE-SENTINEL' });
const user = { GOOGLE_ADS_CLIENT_ID: 'client-id', GOOGLE_ADS_CLIENT_SECRET: 'CLIENT-SECRET-SENTINEL', GOOGLE_ADS_REFRESH_TOKEN: 'REFRESH-SENTINEL', GOOGLE_ADS_LOGIN_CUSTOMER_ID: '123-456-7890' };
const service = { GOOGLE_ADS_AUTH_MODE: 'service_account', GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE: 'json', GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON: key };

describe('authentication environment', () => {
  it.each([undefined, 'developer-token'])('accepts legacy user credentials with token %s', (token) => {
    const env = loadEnv({ ...user, ...(token && { GOOGLE_ADS_DEVELOPER_TOKEN: token }) });
    expect(env.GOOGLE_ADS_AUTH_MODE).toBe('user');
    expect(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).toBe('1234567890');
    expect(env.GOOGLE_ADS_DEVELOPER_TOKEN).toBe(token);
    expect(loadEnv({ ...user, GOOGLE_ADS_DEVELOPER_TOKEN: '' }).GOOGLE_ADS_DEVELOPER_TOKEN).toBeUndefined();
  });
  it('accepts explicit user and optional service-account manager routing', () => {
    expect(loadEnv({ ...user, GOOGLE_ADS_AUTH_MODE: 'user' }).GOOGLE_ADS_AUTH_MODE).toBe('user');
    expect(loadEnv(service).GOOGLE_ADS_LOGIN_CUSTOMER_ID).toBeUndefined();
    expect(loadEnv({ ...service, GOOGLE_ADS_LOGIN_CUSTOMER_ID: '1234567890' }).GOOGLE_ADS_LOGIN_CUSTOMER_ID).toBe('1234567890');
  });
  it('accepts file, JSON, and selected ADC', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ads-key-'));
    try {
      const file = join(dir, 'key.json'); writeFileSync(file, key);
      expect(loadEnv({ GOOGLE_ADS_AUTH_MODE: 'service_account', GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE: 'file', GOOGLE_ADS_SERVICE_ACCOUNT_KEY_FILE: file })).toMatchObject({ serviceAccountKey: { type: 'service_account' } });
      expect(loadEnv(service)).toMatchObject({ serviceAccountKey: { type: 'service_account' } });
      expect(loadEnv({ GOOGLE_ADS_AUTH_MODE: 'service_account', GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE: 'adc' }).GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE).toBe('adc');
      expect(loadEnv({ GOOGLE_ADS_AUTH_MODE: 'service_account', GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE: 'adc', GOOGLE_APPLICATION_CREDENTIALS: '/explicit/adc.json' }).GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE).toBe('adc');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([
    [{}, 'GOOGLE_ADS_AUTH_MODE'],
    [{ GOOGLE_ADS_CLIENT_ID: 'partial' }, 'GOOGLE_ADS_AUTH_MODE'],
    [{ ...user, GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON: key }, 'GOOGLE_ADS_AUTH_MODE'],
    [{ ...user, GOOGLE_APPLICATION_CREDENTIALS: '/explicit/adc.json' }, 'GOOGLE_ADS_AUTH_MODE'],
    [{ ...user, GOOGLE_ADS_AUTH_MODE: 'user', GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON: key }, 'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON'],
    [{ ...user, GOOGLE_ADS_AUTH_MODE: 'user', GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE: 'adc' }, 'GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE'],
    [{ ...user, GOOGLE_ADS_AUTH_MODE: 'user', GOOGLE_APPLICATION_CREDENTIALS: '/explicit/adc.json' }, 'GOOGLE_APPLICATION_CREDENTIALS'],
    [{ ...user, GOOGLE_ADS_AUTH_MODE: 'user', GOOGLE_ADS_LOGIN_CUSTOMER_ID: undefined }, 'GOOGLE_ADS_LOGIN_CUSTOMER_ID'],
    [{ ...service, GOOGLE_ADS_CLIENT_ID: 'partial' }, 'GOOGLE_ADS_CLIENT_ID'],
    [{ ...service, GOOGLE_ADS_SERVICE_ACCOUNT_KEY_FILE: '/other/file' }, 'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_FILE'],
    [{ ...service, GOOGLE_APPLICATION_CREDENTIALS: '/explicit/adc.json' }, 'GOOGLE_APPLICATION_CREDENTIALS'],
    [{ GOOGLE_ADS_AUTH_MODE: 'service_account' }, 'GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE'],
    [{ GOOGLE_ADS_AUTH_MODE: 'service_account', GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE: 'file' }, 'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_FILE'],
    [{ GOOGLE_ADS_AUTH_MODE: 'service_account', GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE: 'file', GOOGLE_ADS_SERVICE_ACCOUNT_KEY_FILE: '/missing/SENTINEL' }, 'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_FILE'],
    [{ ...service, GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON: '{SECRET-SENTINEL' }, 'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON'],
    [{ ...service, GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON: '   ' }, 'GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON'],
    [{ ...service, GOOGLE_ADS_DEVELOPER_TOKEN: '   ' }, 'GOOGLE_ADS_DEVELOPER_TOKEN'],
  ] as const)('rejects invalid credentials by setting name', (input, name) => {
    let message = '';
    try { loadEnv(input); } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      message = (err as Error).message;
    }
    expect(message).toContain(name);
    for (const secret of ['CLIENT-SECRET-SENTINEL', 'REFRESH-SENTINEL', 'PRIVATE-SENTINEL', 'SECRET-SENTINEL']) expect(message).not.toContain(secret);
  });
  it('explains invalid enums and IDs without echoing their values', () => {
    const badMode = () => loadEnv({ ...user, GOOGLE_ADS_AUTH_MODE: 'service-account-SENTINEL' });
    const badId = () => loadEnv({ ...user, GOOGLE_ADS_LOGIN_CUSTOMER_ID: 'BAD-ID-SENTINEL' });
    expect(badMode)
      .toThrow(/GOOGLE_ADS_AUTH_MODE: Invalid option: expected one of/);
    expect(badId)
      .toThrow(/GOOGLE_ADS_LOGIN_CUSTOMER_ID: Invalid string: must match pattern/);
    for (const [run, sentinel] of [[badMode, 'service-account-SENTINEL'], [badId, 'BAD-ID-SENTINEL']] as const) {
      try { run(); } catch (error) { expect((error as Error).message).not.toContain(sentinel); }
    }
  });
  it('names both missing user settings and ambiguous service-account settings', () => {
    expect(() => loadEnv({ GOOGLE_ADS_CLIENT_ID: 'CLIENT-ID-SENTINEL' }))
      .toThrow(/Missing user settings: GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID/);
    expect(() => loadEnv({ ...user, GOOGLE_APPLICATION_CREDENTIALS: '/SECRET-ADC-PATH' }))
      .toThrow(/Supplied service-account settings: GOOGLE_APPLICATION_CREDENTIALS/);
  });
});
