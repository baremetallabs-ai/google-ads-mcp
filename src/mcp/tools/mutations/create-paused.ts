import { z } from 'zod';
import {
  InvalidArgumentError,
  ResourceNotFoundError,
  UnsupportedResourceStateError,
} from '../../../errors/tool-errors.js';
import { rn } from '../../../google-ads/resource-names.js';
import type { GoogleAdsTransport, MutateOperation } from '../../../google-ads/types.js';
import { gaqlIdList } from '../../../util/gaql.js';
import {
  CustomerIdInput,
  HttpsUrlInput,
  MatchTypeInput,
  MicrosInput,
  NumericIdInput,
} from '../shared/schemas.js';
import {
  ADDITIVE_ANNOTATIONS,
  MUTATION_OUTPUT_SHAPE,
  type MutationDefinition,
} from './pipeline.js';

interface AdGroupState {
  adGroupId: string;
  adGroupName: string;
  campaignId: string;
  campaignName: string;
  existing?: Map<string, string>;
}

async function fetchAdGroup(
  ctx: { customerId: string; transport: Pick<GoogleAdsTransport, 'search'> },
  adGroupId: string,
): Promise<AdGroupState> {
  const page = await ctx.transport.search(
    {
      customerId: ctx.customerId,
      query: `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM ad_group WHERE ad_group.id = ${gaqlIdList([adGroupId])} LIMIT 1`,
    },
    { label: 'create_paused_scope' },
  );
  const row = page.results[0];
  if (!row) throw new ResourceNotFoundError('ad_group', adGroupId);
  const g = row.adGroup as Record<string, unknown>;
  const c = (row.campaign ?? {}) as Record<string, unknown>;
  if (g.status === 'REMOVED') {
    throw new UnsupportedResourceStateError(
      `Ad group "${String(g.name ?? adGroupId)}" is REMOVED.`,
      { resourceType: 'ad_group', state: 'REMOVED' },
    );
  }
  if (c.status === 'REMOVED') {
    throw new UnsupportedResourceStateError(
      `The parent campaign of ad group "${String(g.name ?? adGroupId)}" is REMOVED.`,
      { resourceType: 'campaign', state: 'REMOVED' },
    );
  }
  return {
    adGroupId,
    adGroupName: String(g.name ?? adGroupId),
    campaignId: String(c.id ?? ''),
    campaignName: String(c.name ?? ''),
  };
}

/* ------------------------------------------------------------------ *
 * create_paused_ad
 * ------------------------------------------------------------------ */

interface CreateAdInput {
  customerId: string;
  adGroupId: string;
  ads: {
    finalUrls: string[];
    headlines: { text: string; pinnedField?: string }[];
    descriptions: { text: string; pinnedField?: string }[];
    path1?: string;
    path2?: string;
    trackingUrlTemplate?: string;
    finalUrlSuffix?: string;
    urlCustomParameters?: { key: string; value: string }[];
  }[];
}

export const createPausedAd: MutationDefinition<'create_paused_ad', CreateAdInput, AdGroupState> = {
  name: 'create_paused_ad',
  title: 'Create paused responsive search ads',
  description:
    'Creates one or more responsive search ads in an ad group. Created ads are always PAUSED ' +
    'and will not serve or accrue spend until enable_ad is called on them; there is no way to ' +
    'create an enabled ad through this tool. Google Ads policy review still applies, and ' +
    'policy findings are returned in the result. All operations succeed or all fail together.',
  resourceType: 'ad_group_ad',
  annotations: { title: 'Create paused ads', ...ADDITIVE_ANNOTATIONS },
  responseContentType: 'RESOURCE_NAME_ONLY',

  buildInputSchema: (policy) => ({
    customerId: CustomerIdInput,
    adGroupId: NumericIdInput,
    // No status or enabled field exists here, and the schema is strict, so supplying
    // one is rejected at the protocol layer.
    ads: z
      .array(
        z.strictObject({
          finalUrls: z.array(HttpsUrlInput).min(1).max(4),
          headlines: z
            .array(
              z.strictObject({
                text: z.string().min(1).max(30),
                pinnedField: z.enum(['HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3']).optional(),
              }),
            )
            .min(3)
            .max(15),
          descriptions: z
            .array(
              z.strictObject({
                text: z.string().min(1).max(90),
                pinnedField: z.enum(['DESCRIPTION_1', 'DESCRIPTION_2']).optional(),
              }),
            )
            .min(2)
            .max(4),
          path1: z.string().max(15).optional(),
          path2: z.string().max(15).optional(),
          trackingUrlTemplate: z.string().max(2048).optional(),
          finalUrlSuffix: z.string().max(2048).optional(),
          urlCustomParameters: z
            .array(z.strictObject({ key: z.string().regex(/^\w{1,16}$/), value: z.string().max(250) }))
            .max(8)
            .optional(),
        }),
      )
      .min(1)
      .max(policy.maxResourcesPerCall),
  }),

  outputSchema: {
    ...MUTATION_OUTPUT_SHAPE,
    adGroupId: z.string(),
    createdCount: z.number(),
    results: z.array(z.record(z.string(), z.unknown())),
    googleAdsRequestId: z.string().nullable().optional(),
    validatedOperationHash: z.string().optional(),
  },

  fetchState(ctx, input): Promise<AdGroupState> {
    return fetchAdGroup(ctx, input.adGroupId);
  },

  checkConstraints(ctx, input): void {
    for (const ad of input.ads) {
      if (ad.path2 !== undefined && ad.path1 === undefined) {
        throw new InvalidArgumentError('path2 requires path1 to be supplied as well.', {});
      }
      for (const url of ad.finalUrls) {
        const parsed = new URL(url);
        if (ctx.policy.requireHttps && parsed.protocol !== 'https:') {
          throw new InvalidArgumentError(`Final URL ${url} must use https.`, { url });
        }
        if (ctx.policy.allowedFinalUrlHosts && !ctx.policy.allowedFinalUrlHosts.includes(parsed.host)) {
          throw new InvalidArgumentError(
            `Final URL host "${parsed.host}" is not in the configured allowed hosts.`,
            { host: parsed.host, allowedFinalUrlHosts: ctx.policy.allowedFinalUrlHosts },
          );
        }
      }
    }
  },

  detectNoOp(): null {
    // Creation is never a no-op: two identical ads are two distinct resources.
    return null;
  },

  buildOperations(ctx, input): MutateOperation[] {
    return input.ads.map((ad) => ({
      adGroupAdOperation: {
        create: {
          adGroup: rn.adGroup(ctx.customerId, input.adGroupId),
          // A server-side constant, never derived from input.
          status: 'PAUSED',
          ad: {
            finalUrls: ad.finalUrls,
            ...(ad.trackingUrlTemplate !== undefined && { trackingUrlTemplate: ad.trackingUrlTemplate }),
            ...(ad.finalUrlSuffix !== undefined && { finalUrlSuffix: ad.finalUrlSuffix }),
            ...(ad.urlCustomParameters !== undefined && { urlCustomParameters: ad.urlCustomParameters }),
            responsiveSearchAd: {
              headlines: ad.headlines.map((h) => ({
                text: h.text,
                ...(h.pinnedField !== undefined && { pinnedField: h.pinnedField }),
              })),
              descriptions: ad.descriptions.map((d) => ({
                text: d.text,
                ...(d.pinnedField !== undefined && { pinnedField: d.pinnedField }),
              })),
              ...(ad.path1 !== undefined && { path1: ad.path1 }),
              ...(ad.path2 !== undefined && { path2: ad.path2 }),
            },
          },
        },
      },
    }));
  },

  buildResult(ctx, input, state, exec): Record<string, unknown> {
    const results = input.ads.map((ad, i) => {
      const resourceName = exec.responses[i]?.adGroupAdResult?.resourceName ?? null;
      return {
        resourceName,
        adId: typeof resourceName === 'string' ? (resourceName.split('~').pop() ?? null) : null,
        status: 'PAUSED',
        adType: 'RESPONSIVE_SEARCH_AD',
        finalUrlHosts: [...new Set(ad.finalUrls.map((u) => new URL(u).host))],
        headlineCount: ad.headlines.length,
        descriptionCount: ad.descriptions.length,
      };
    });
    return {
      success: true,
      changed: true,
      customerId: ctx.customerId,
      resourceType: 'ad_group_ad',
      adGroupId: input.adGroupId,
      createdCount: results.length,
      results,
      before: null,
      after: { status: 'PAUSED', count: results.length },
      googleAdsRequestId: exec.requestId ?? null,
      validatedOperationHash: exec.operationHash,
      message: `Created ${results.length} paused responsive search ad(s) in ad group "${state.adGroupName}". They will not serve until enabled.`,
    };
  },

  canonicalArguments(input): unknown {
    // IDs, counts and hosts only - never the headline or description text itself.
    return {
      adGroupId: input.adGroupId,
      adCount: input.ads.length,
      headlineCounts: input.ads.map((a) => a.headlines.length),
      descriptionCounts: input.ads.map((a) => a.descriptions.length),
      finalUrlHosts: [
        ...new Set(input.ads.flatMap((a) => a.finalUrls.map((u) => new URL(u).host))),
      ],
    };
  },
};

/* ------------------------------------------------------------------ *
 * create_paused_keyword
 * ------------------------------------------------------------------ */

interface CreateKeywordInput {
  customerId: string;
  adGroupId: string;
  keywords: { text: string; matchType: string; cpcBidMicros?: string; finalUrls?: string[] }[];
}

interface CreateKeywordState extends AdGroupState {
  existing: Map<string, string>;
  toCreate: { text: string; matchType: string; cpcBidMicros?: string; finalUrls?: string[] }[];
  duplicates: { text: string; matchType: string; resourceName: string }[];
}

const keywordKey = (text: string, matchType: string): string =>
  `${text.trim().toLowerCase()}|${matchType}`;

export const createPausedKeyword: MutationDefinition<
  'create_paused_keyword',
  CreateKeywordInput,
  CreateKeywordState
> = {
  name: 'create_paused_keyword',
  title: 'Create paused keywords',
  description:
    'Adds one or more bidding keywords to an ad group. Created keywords are always PAUSED and ' +
    'will not trigger ads or accrue spend until enable_keyword is called on them; there is no ' +
    'way to create an enabled keyword through this tool. Keywords that already exist in the ' +
    'ad group are reported as existing rather than duplicated.',
  resourceType: 'ad_group_criterion',
  annotations: { title: 'Create paused keywords', ...ADDITIVE_ANNOTATIONS },
  responseContentType: 'RESOURCE_NAME_ONLY',

  buildInputSchema: (policy) => ({
    customerId: CustomerIdInput,
    adGroupId: NumericIdInput,
    keywords: z
      .array(
        z.strictObject({
          text: z.string().min(1).max(80),
          matchType: policy.allowedMatchTypes
            ? z.enum(policy.allowedMatchTypes as [string, ...string[]])
            : MatchTypeInput,
          ...(policy.allowCpcBidOverride ? { cpcBidMicros: MicrosInput.optional() } : {}),
          finalUrls: z.array(HttpsUrlInput).max(4).optional(),
        }),
      )
      .min(1)
      .max(policy.maxResourcesPerCall),
  }),

  outputSchema: {
    ...MUTATION_OUTPUT_SHAPE,
    adGroupId: z.string(),
    createdCount: z.number(),
    duplicateCount: z.number(),
    results: z.array(z.record(z.string(), z.unknown())),
    googleAdsRequestId: z.string().nullable().optional(),
    validatedOperationHash: z.string().optional(),
  },

  async fetchState(ctx, input): Promise<CreateKeywordState> {
    const base = await fetchAdGroup(ctx, input.adGroupId);

    const res = await ctx.transport.searchPaginated(
      {
        customerId: ctx.customerId,
        query: `SELECT ad_group_criterion.resource_name, ad_group_criterion.status, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group.id = ${gaqlIdList([input.adGroupId])} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'`,
        maxRows: 5000,
      },
      { label: 'existing_keywords' },
    );

    const existing = new Map<string, string>();
    for (const row of res.rows) {
      const node = row.adGroupCriterion as Record<string, any>;
      const text = node?.keyword?.text;
      const matchType = node?.keyword?.matchType;
      if (typeof text === 'string' && typeof matchType === 'string') {
        existing.set(keywordKey(text, matchType), String(node.resourceName ?? ''));
      }
    }

    const seen = new Set<string>();
    const toCreate: CreateKeywordInput['keywords'] = [];
    const duplicates: { text: string; matchType: string; resourceName: string }[] = [];

    for (const kw of input.keywords) {
      const key = keywordKey(kw.text, kw.matchType);
      if (seen.has(key)) {
        throw new InvalidArgumentError(
          `Duplicate entry within the request: "${kw.text}" (${kw.matchType}).`,
          {},
        );
      }
      seen.add(key);
      const found = existing.get(key);
      if (found !== undefined) duplicates.push({ text: kw.text, matchType: kw.matchType, resourceName: found });
      else toCreate.push(kw);
    }

    return { ...base, existing, toCreate, duplicates };
  },

  checkConstraints(ctx, input): void {
    if (!ctx.policy.allowCpcBidOverride) {
      for (const kw of input.keywords) {
        if (kw.cpcBidMicros !== undefined) {
          throw new InvalidArgumentError(
            'Per-keyword CPC bid overrides are disabled in this server configuration.',
            {},
          );
        }
      }
    }
  },

  detectNoOp(ctx, input, state): Record<string, unknown> | null {
    if (state.toCreate.length > 0) return null;
    return {
      success: true,
      changed: false,
      customerId: ctx.customerId,
      resourceType: 'ad_group_criterion',
      adGroupId: input.adGroupId,
      createdCount: 0,
      duplicateCount: state.duplicates.length,
      results: state.duplicates.map((d) => ({ ...d, created: false, alreadyExisted: true })),
      googleAdsRequestId: null,
      message: `All ${state.duplicates.length} keyword(s) already exist in ad group "${state.adGroupName}".`,
    };
  },

  buildOperations(ctx, input, state): MutateOperation[] {
    return state.toCreate.map((kw) => ({
      adGroupCriterionOperation: {
        create: {
          adGroup: rn.adGroup(ctx.customerId, input.adGroupId),
          // Server-side constant.
          status: 'PAUSED',
          keyword: { text: kw.text, matchType: kw.matchType },
          ...(kw.cpcBidMicros !== undefined && { cpcBidMicros: kw.cpcBidMicros }),
          ...(kw.finalUrls !== undefined && { finalUrls: kw.finalUrls }),
        },
      },
    }));
  },

  buildResult(ctx, input, state, exec): Record<string, unknown> {
    const created = state.toCreate.map((kw, i) => {
      const resourceName = exec.responses[i]?.adGroupCriterionResult?.resourceName ?? null;
      return {
        text: kw.text,
        matchType: kw.matchType,
        resourceName,
        criterionId: typeof resourceName === 'string' ? (resourceName.split('~').pop() ?? null) : null,
        status: 'PAUSED',
        created: true,
        alreadyExisted: false,
      };
    });
    const duplicates = state.duplicates.map((d) => ({ ...d, created: false, alreadyExisted: true }));
    return {
      success: true,
      changed: true,
      customerId: ctx.customerId,
      resourceType: 'ad_group_criterion',
      adGroupId: input.adGroupId,
      createdCount: created.length,
      duplicateCount: duplicates.length,
      results: [...created, ...duplicates],
      before: null,
      after: { status: 'PAUSED', count: created.length },
      googleAdsRequestId: exec.requestId ?? null,
      validatedOperationHash: exec.operationHash,
      message: `Created ${created.length} paused keyword(s) in ad group "${state.adGroupName}". They will not serve until enabled.`,
    };
  },

  canonicalArguments(input): unknown {
    return {
      adGroupId: input.adGroupId,
      count: input.keywords.length,
      matchTypes: [...new Set(input.keywords.map((k) => k.matchType))],
    };
  },
};
