import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../../../src/config/env.js';
import { loadConfig, loadInstallConfig } from '../../../src/config/load-config.js';
import { installBaseline } from '../../../src/capabilities/install-baseline.js';
import { MUTATION_TOOL_NAMES } from '../../../src/capabilities/tool-names.js';

const credentials = { GOOGLE_ADS_AUTH_MODE: 'service_account', GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE: 'json',
  GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON: JSON.stringify({ type: 'service_account', client_email: 'svc@example.com', private_key: 'SECRET-KEY' }) };
const install = { ...credentials, GOOGLE_ADS_ALLOWED_CUSTOMER_IDS: '9876543210,8765432109',
  GOOGLE_ADS_INSTALL_MODE: 'mutations', GOOGLE_ADS_MASTER_BUDGET_MICROS: '500000000' };
const base = installBaseline(['9876543210', '8765432109'], 'mutations', '500000000');
const policy = () => structuredClone(base);
const from = (value: unknown, settings: Record<string, string> = {}) =>
  loadInstallConfig(loadEnv({ ...install, GOOGLE_ADS_CAPABILITIES_INLINE: JSON.stringify(value), ...settings }));

describe('effective install policy', () => {
  it('uses the conservative baseline without an extra policy', () => {
    const config = loadInstallConfig(loadEnv(install));
    expect(Object.keys(config.mutations.tools)).toHaveLength(15);
    expect(MUTATION_TOOL_NAMES.every((name) => config.mutations.tools[name]?.enabled)).toBe(true);
    expect(config.mutations.tools.update_tracking_parameters?.allowFinalUrlChanges).toBe(false);
    expect(config.budgets?.masterBudgetMicros).toBe('500000000');
    expect(loadInstallConfig(loadEnv({ ...credentials, GOOGLE_ADS_ALLOWED_CUSTOMER_IDS: '9876543210' })).mutations.enabled).toBe(false);
  });
  it('narrows customers, actions, budgets, and per-tool limits from inline JSON or YAML', () => {
    const narrow = policy();
    narrow.accounts.allowedCustomerIds = ['9876543210'];
    narrow.mutations.tools.pause_campaign!.enabled = false;
    narrow.mutations.tools.pause_ad!.maxResourcesPerCall = 2;
    narrow.budgets!.masterBudgetMicros = '300000000';
    expect(from(narrow)).toMatchObject({ accounts: { allowedCustomerIds: ['9876543210'] },
      mutations: { tools: { pause_campaign: { enabled: false }, pause_ad: { maxResourcesPerCall: 2 } } },
      budgets: { masterBudgetMicros: '300000000' } });
    const yaml = `version: 1\naccounts:\n  allowedCustomerIds: ['9876543210']\nmutations:\n  enabled: false\n  default: deny\n  tools: {}\n`;
    const result = loadInstallConfig(loadEnv({ ...install, GOOGLE_ADS_CAPABILITIES_INLINE: yaml }));
    expect(result.mutations.enabled).toBe(false);
    expect(result.mutations.tools).toEqual({});
    const noBudgetBlock = policy();
    delete (noBudgetBlock as { budgets?: unknown }).budgets;
    expect(from(noBudgetBlock).budgets?.masterBudgetMicros).toBe('500000000');
  });
  it('rejects widening and contradictory settings without exposing policy values', () => {
    const cases = [
      (p: typeof base) => { p.accounts.allowedCustomerIds = ['7654321098']; },
      (p: typeof base) => { p.budgets!.masterBudgetMicros = '600000000'; },
      (p: typeof base) => { p.budgets!.masterBudgetMicros = '0'; },
      (p: typeof base) => { p.mutations.tools.pause_ad!.maxResourcesPerCall = 11; },
      (p: typeof base) => { p.mutations.tools.update_tracking_parameters!.allowFinalUrlChanges = true; },
      (p: typeof base) => { p.reads.searchGoogleAds.blockedResources = []; },
      (p: typeof base) => { p.mutations.tools.create_paused_keyword!.allowCpcBidOverride = true; },
    ];
    for (const change of cases) {
      const candidate = policy(); change(candidate);
      expect(() => from(candidate)).toThrow();
    }
    const unknown = policy() as typeof base & { mutations: { tools: Record<string, unknown> } };
    unknown.mutations.tools.raw_google_ads_mutate = { enabled: true, maxResourcesPerCall: 1 };
    expect(() => from(unknown)).toThrow(/mutations.tools/);
    const readOnlyPolicy = policy(); readOnlyPolicy.accounts.allowedCustomerIds = ['9876543210'];
    expect(() => loadInstallConfig(loadEnv({ ...credentials, GOOGLE_ADS_ALLOWED_CUSTOMER_IDS: '9876543210',
      GOOGLE_ADS_CAPABILITIES_INLINE: JSON.stringify(readOnlyPolicy) }))).toThrow(/GOOGLE_ADS_MASTER_BUDGET_MICROS/);
    try { from('SECRET-POLICY'); } catch (error) { expect((error as Error).message).not.toContain('SECRET-POLICY'); }
  });
  it('keeps explicit file-based policy usable and applies narrowing in install mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ads-policy-'));
    try {
      const file = join(dir, 'policy.yaml');
      const narrow = policy(); narrow.accounts.allowedCustomerIds = ['9876543210'];
      writeFileSync(file, JSON.stringify(narrow));
      expect(loadConfig(file).accounts.allowedCustomerIds).toEqual(['9876543210']);
      expect(loadInstallConfig(loadEnv({ ...install, GOOGLE_ADS_MCP_CONFIG: file })).accounts.allowedCustomerIds).toEqual(['9876543210']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
