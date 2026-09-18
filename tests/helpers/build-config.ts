import { AppConfigSchema, type AppConfig } from '../../src/capabilities/schema.js';

const BASE = {
  version: 1,
  accounts: { allowedCustomerIds: ['1234567890', '2345678901'] },
  reads: {
    defaultRowLimit: 100,
    maxRowLimit: 1000,
    requestTimeoutMs: 30000,
    maxPages: 20,
    searchGoogleAds: { enabled: true, maxRowLimit: 1000 },
  },
  mutations: {
    enabled: true,
    default: 'deny',
    tools: {
      pause_campaign: { enabled: true, maxResourcesPerCall: 1 },
      enable_campaign: { enabled: true, maxResourcesPerCall: 1 },
      pause_ad_group: { enabled: true, maxResourcesPerCall: 1 },
      enable_ad_group: { enabled: true, maxResourcesPerCall: 1 },
      pause_ad: { enabled: true, maxResourcesPerCall: 10 },
      enable_ad: { enabled: true, maxResourcesPerCall: 10 },
      pause_keyword: { enabled: true, maxResourcesPerCall: 20 },
      enable_keyword: { enabled: true, maxResourcesPerCall: 20 },
      add_negative_keyword: { enabled: true, maxResourcesPerCall: 20 },
      remove_negative_keyword: { enabled: true, maxResourcesPerCall: 20 },
      create_paused_ad: { enabled: true, maxResourcesPerCall: 10 },
      create_paused_keyword: { enabled: true, maxResourcesPerCall: 20 },
      dismiss_recommendation: { enabled: true, maxResourcesPerCall: 20 },
      update_tracking_parameters: { enabled: true, allowFinalUrlChanges: false },
      set_campaign_budget: { enabled: true, maxResourcesPerCall: 1 },
    },
  },
  budgets: { masterBudgetMicros: '500000000' },
};

/** Build a validated AppConfig for tests, with deep-ish overrides. */
export function buildConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const raw = {
    ...BASE,
    ...overrides,
    accounts: { ...BASE.accounts, ...(overrides.accounts ?? {}) },
    reads: { ...BASE.reads, ...(overrides.reads ?? {}) },
    mutations: {
      ...BASE.mutations,
      ...(overrides.mutations ?? {}),
      tools:
        overrides.mutations?.tools !== undefined
          ? overrides.mutations.tools
          : BASE.mutations.tools,
    },
    budgets: overrides.budgets === undefined ? BASE.budgets : overrides.budgets,
  };
  return AppConfigSchema.parse(raw);
}
