import { describe, it, expect } from 'vitest';
import { AppConfigSchema } from '../../../src/capabilities/schema.js';

const valid = {
  version: 1,
  accounts: { allowedCustomerIds: ['1234567890'] },
  mutations: { enabled: true, default: 'deny', tools: {} },
};

const parse = (raw: unknown) => AppConfigSchema.safeParse(raw);
const issues = (raw: unknown) =>
  parse(raw).error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];

describe('capability configuration fails closed', () => {
  it('accepts a minimal valid configuration', () => {
    expect(parse(valid).success).toBe(true);
  });

  it('requires the customer allowlist', () => {
    expect(parse({ ...valid, accounts: undefined }).success).toBe(false);
    expect(parse({ ...valid, accounts: { allowedCustomerIds: [] } }).success).toBe(false);
  });

  it('normalizes dashed customer IDs in the allowlist', () => {
    const result = parse({ ...valid, accounts: { allowedCustomerIds: ['123-456-7890'] } });
    expect(result.success).toBe(true);
    expect(result.data?.accounts.allowedCustomerIds).toEqual(['1234567890']);
  });

  it('rejects duplicate customer IDs', () => {
    const result = parse({
      ...valid,
      accounts: { allowedCustomerIds: ['1234567890', '123-456-7890'] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown mutation tool name', () => {
    const result = parse({
      ...valid,
      mutations: {
        ...valid.mutations,
        tools: { delete_everything: { enabled: true, maxResourcesPerCall: 1 } },
      },
    });
    expect(result.success).toBe(false);
    expect(issues(result)).toBeDefined();
  });

  it('rejects a misspelled key rather than ignoring it', () => {
    // A silently ignored typo would leave an operator believing a constraint applies.
    expect(
      parse({
        ...valid,
        mutations: {
          ...valid.mutations,
          tools: { pause_campaign: { enabled: true, maxResourcesPerCal: 1 } },
        },
      }).success,
    ).toBe(false);
    expect(parse({ ...valid, acounts: valid.accounts }).success).toBe(false);
  });

  it('rejects out-of-range tool constraints', () => {
    const withPolicy = (policy: unknown) =>
      parse({ ...valid, mutations: { ...valid.mutations, tools: { pause_campaign: policy } } });
    expect(withPolicy({ enabled: true, maxResourcesPerCall: 0 }).success).toBe(false);
    expect(withPolicy({ enabled: true, maxResourcesPerCall: -1 }).success).toBe(false);
    expect(withPolicy({ enabled: true, maxResourcesPerCall: 101 }).success).toBe(false);
    expect(withPolicy({ enabled: true, maxResourcesPerCall: 1.5 }).success).toBe(false);
    expect(withPolicy({ enabled: 'yes', maxResourcesPerCall: 1 }).success).toBe(false);
  });

  it('caps set_campaign_budget at one resource per call', () => {
    const result = parse({
      ...valid,
      budgets: { masterBudgetMicros: '500000000' },
      mutations: {
        ...valid.mutations,
        tools: { set_campaign_budget: { enabled: true, maxResourcesPerCall: 2 } },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects set_campaign_budget enabled without a master budget', () => {
    const result = parse({
      ...valid,
      mutations: {
        ...valid.mutations,
        tools: { set_campaign_budget: { enabled: true, maxResourcesPerCall: 1 } },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['budgets', 'masterBudgetMicros']);
  });

  it('allows set_campaign_budget when a master budget is present', () => {
    expect(
      parse({
        ...valid,
        budgets: { masterBudgetMicros: '500000000' },
        mutations: {
          ...valid.mutations,
          tools: { set_campaign_budget: { enabled: true, maxResourcesPerCall: 1 } },
        },
      }).success,
    ).toBe(true);
  });

  it('rejects a non-integer master budget', () => {
    for (const bad of ['500.00', '-1', 'abc', '5e8']) {
      expect(parse({ ...valid, budgets: { masterBudgetMicros: bad } }).success).toBe(false);
    }
  });

  it("rejects mutations.default other than 'deny'", () => {
    // An operator writing `allow` must fail rather than get something that is not
    // default-deny.
    expect(parse({ ...valid, mutations: { ...valid.mutations, default: 'allow' } }).success).toBe(
      false,
    );
  });

  it('rejects an unknown config version', () => {
    expect(parse({ ...valid, version: 2 }).success).toBe(false);
  });
});
