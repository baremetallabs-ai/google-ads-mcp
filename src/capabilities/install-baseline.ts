import { AppConfigSchema, type AppConfig } from './schema.js';

/** Version 1 install defaults. Keep limits aligned with config/capabilities.example.yaml. */
export function installBaseline(customerIds: string[], mode: 'read_only' | 'mutations', ceiling?: string): AppConfig {
  return AppConfigSchema.parse({
    version: 1,
    accounts: { allowedCustomerIds: customerIds },
    reads: { defaultRowLimit: 100, maxRowLimit: 1000, requestTimeoutMs: 30000, maxPages: 20,
      searchGoogleAds: { enabled: true, maxRowLimit: 1000 } },
    mutations: { enabled: mode === 'mutations', default: 'deny', tools: {
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
      set_campaign_budget: { enabled: !!ceiling, maxResourcesPerCall: 1 },
    } },
    ...(ceiling ? { budgets: { masterBudgetMicros: ceiling } } : {}),
  });
}
