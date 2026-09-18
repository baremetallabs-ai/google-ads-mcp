import { z } from 'zod';
import { MUTATION_TOOL_NAMES, type MutationToolName } from './tool-names.js';

/**
 * Typed capability configuration.
 *
 * Every enabled mutation tool has its own schema. There is deliberately no generic
 * rule language and no risk-level enum: the operational decision comes from concrete,
 * locally-checkable settings.
 *
 * Every object is strict, so a misspelled key fails startup instead of being silently
 * ignored and leaving an operator believing a constraint is in force.
 */

/** A Google Ads customer ID with dashes and spaces removed. */
export const CustomerIdSchema = z
  .string()
  .transform((s) => s.replace(/[-\s]/g, ''))
  .pipe(z.string().regex(/^\d{10}$/, 'customer ID must be 10 digits once dashes are removed'));

/**
 * Micros as a decimal string.
 *
 * Deliberately not z.bigint(): Zod v4 cannot represent bigint in JSON Schema, and the
 * MCP SDK converts every tool schema to JSON Schema for tools/list.
 */
export const MicrosStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,18})$/, 'must be a non-negative integer number of micros')
  .refine((s) => {
    // Zod v4 runs later checks even when the regex above failed, so this must not
    // assume it received a numeric string - BigInt('500.00') throws.
    try {
      return BigInt(s) <= 9_223_372_036_854_775_807n;
    } catch {
      return false;
    }
  }, 'exceeds the maximum supported value');

const MatchTypeSchema = z.enum(['EXACT', 'PHRASE', 'BROAD']);

const statusTogglePolicy = (max: number) =>
  z.strictObject({
    enabled: z.boolean(),
    maxResourcesPerCall: z.number().int().positive().max(max),
  });

export const PolicySchemas = {
  pause_campaign: statusTogglePolicy(100),
  enable_campaign: statusTogglePolicy(100),
  pause_ad_group: statusTogglePolicy(100),
  enable_ad_group: statusTogglePolicy(100),
  pause_ad: statusTogglePolicy(100),
  enable_ad: statusTogglePolicy(100),
  pause_keyword: statusTogglePolicy(1000),
  enable_keyword: statusTogglePolicy(1000),

  add_negative_keyword: z.strictObject({
    enabled: z.boolean(),
    maxResourcesPerCall: z.number().int().positive().max(1000),
    allowedMatchTypes: z.array(MatchTypeSchema).nonempty().optional(),
    maxTextLength: z.number().int().positive().max(80).default(80),
  }),

  remove_negative_keyword: z.strictObject({
    enabled: z.boolean(),
    maxResourcesPerCall: z.number().int().positive().max(1000),
    // Off by default: removing by text risks deleting the wrong criterion when
    // several match. When on, an ambiguous match is still refused.
    allowTextResolution: z.boolean().default(false),
  }),

  create_paused_ad: z.strictObject({
    enabled: z.boolean(),
    maxResourcesPerCall: z.number().int().positive().max(100),
    allowedAdTypes: z.array(z.literal('RESPONSIVE_SEARCH_AD')).nonempty().default(['RESPONSIVE_SEARCH_AD']),
    allowedFinalUrlHosts: z.array(z.string().min(1)).optional(),
    requireHttps: z.boolean().default(true),
  }),

  create_paused_keyword: z.strictObject({
    enabled: z.boolean(),
    maxResourcesPerCall: z.number().int().positive().max(1000),
    allowedMatchTypes: z.array(MatchTypeSchema).nonempty().optional(),
    allowCpcBidOverride: z.boolean().default(false),
  }),

  dismiss_recommendation: z.strictObject({
    enabled: z.boolean(),
    // Google caps recommendations:dismiss at 100 operations per request.
    maxResourcesPerCall: z.number().int().positive().max(100),
    allowedTypes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).nonempty().optional(),
  }),

  update_tracking_parameters: z.strictObject({
    enabled: z.boolean(),
    allowFinalUrlChanges: z.boolean(),
    allowFinalUrlSuffixChanges: z.boolean().default(true),
    // A tracking template without an {lpurl} placeholder *is* the destination, so
    // requiring one is part of keeping the effective destination unchanged.
    requireLpurlPlaceholder: z.boolean().default(true),
    allowedTrackingHosts: z.array(z.string().min(1)).optional(),
    maxCustomParameters: z.number().int().nonnegative().max(8).default(8),
  }),

  set_campaign_budget: z.strictObject({
    enabled: z.boolean(),
    maxResourcesPerCall: z.number().int().positive().max(1),
  }),
} as const satisfies Record<MutationToolName, z.ZodType>;

export type PolicyFor<N extends MutationToolName> = z.infer<(typeof PolicySchemas)[N]>;

const SearchGoogleAdsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  maxRowLimit: z.number().int().positive().max(10_000).default(1000),
  /**
   * Resources the generic GAQL reader may not select from.
   *
   * Billing, payments and user-access are listed by the spec as prohibited
   * capabilities. Nothing else stops a generic reader reaching them, so they are
   * blocked here by default.
   */
  blockedResources: z
    .array(z.string())
    .default([
      'customer_client',
      'customer_user_access',
      'customer_user_access_invitation',
      'customer_manager_link',
      'customer_client_link',
      'billing_setup',
      'account_budget',
      'account_budget_proposal',
      'payments_account',
      'invoice',
    ]),
});

const ReadsSchema = z.strictObject({
  defaultRowLimit: z.number().int().positive().max(10_000).default(100),
  maxRowLimit: z.number().int().positive().max(10_000).default(1000),
  requestTimeoutMs: z.number().int().positive().max(120_000).default(30_000),
  maxPages: z.number().int().positive().max(100).default(20),
  searchGoogleAds: SearchGoogleAdsSchema.prefault({}),
});

const MutationToolsSchema = z.strictObject(
  Object.fromEntries(MUTATION_TOOL_NAMES.map((n) => [n, PolicySchemas[n].optional()])) as {
    [N in MutationToolName]: z.ZodOptional<(typeof PolicySchemas)[N]>;
  },
);

const MutationsSchema = z.strictObject({
  enabled: z.boolean(),
  // Literal 'deny': an operator writing `allow` gets a startup failure rather than a
  // config that quietly means something other than default-deny.
  default: z.literal('deny'),
  tools: MutationToolsSchema.prefault({}),
});

export const AppConfigSchema = z
  .strictObject({
    version: z.literal(1),
    accounts: z.strictObject({
      allowedCustomerIds: z.array(CustomerIdSchema).nonempty(),
    }),
    reads: ReadsSchema.prefault({}),
    mutations: MutationsSchema,
    budgets: z
      .strictObject({
        masterBudgetMicros: MicrosStringSchema,
      })
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.mutations.tools.set_campaign_budget?.enabled && !cfg.budgets?.masterBudgetMicros) {
      ctx.addIssue({
        code: 'custom',
        path: ['budgets', 'masterBudgetMicros'],
        message:
          'budgets.masterBudgetMicros is required when set_campaign_budget is enabled. ' +
          'Without a ceiling there is no budget invariant to enforce.',
      });
    }
    const duplicates = cfg.accounts.allowedCustomerIds.filter(
      (id, i, all) => all.indexOf(id) !== i,
    );
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['accounts', 'allowedCustomerIds'],
        message: `duplicate customer IDs in allowlist: ${[...new Set(duplicates)].join(', ')}`,
      });
    }
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;
