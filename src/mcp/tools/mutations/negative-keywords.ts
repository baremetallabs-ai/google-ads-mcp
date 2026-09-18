import { z } from 'zod';
import {
  DuplicateResourceError,
  InvalidArgumentError,
  ResourceNotFoundError,
  UnsupportedResourceStateError,
} from '../../../errors/tool-errors.js';
import { assertResourceNameCustomer, rn } from '../../../google-ads/resource-names.js';
import type { GoogleAdsTransport, MutateOperation } from '../../../google-ads/types.js';
import { gaqlIdList, gaqlStringList } from '../../../util/gaql.js';
import { CustomerIdInput, MatchTypeInput, NumericIdInput } from '../shared/schemas.js';
import {
  ADDITIVE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  MUTATION_OUTPUT_SHAPE,
  type MutationDefinition,
} from './pipeline.js';

/** Google rejects these characters in keyword text. */
const INVALID_KEYWORD_CHARS = /[!@%,*]/;

function validateKeywordText(text: string, maxLength: number): void {
  if (text.length > maxLength) {
    throw new InvalidArgumentError(
      `Keyword text exceeds the configured maximum of ${maxLength} characters.`,
      { maxLength, actualLength: text.length },
    );
  }
  if (INVALID_KEYWORD_CHARS.test(text)) {
    throw new InvalidArgumentError(
      'Keyword text may not contain the characters ! @ % , or *.',
      {},
    );
  }
  if (text.trim().split(/\s+/).length > 10) {
    throw new InvalidArgumentError('Keyword text may not exceed 10 words.', {});
  }
}

const dedupeKey = (text: string, matchType: string): string =>
  `${text.trim().toLowerCase()}|${matchType}`;

/* ------------------------------------------------------------------ *
 * add_negative_keyword
 * ------------------------------------------------------------------ */

interface AddInput {
  customerId: string;
  campaignId?: string;
  adGroupId?: string;
  keywords: { text: string; matchType: string }[];
}

interface AddState {
  scope: 'campaign' | 'ad_group';
  scopeId: string;
  scopeName: string;
  scopeResourceName: string;
  existing: Map<string, string>;
  toCreate: { text: string; matchType: string }[];
  duplicates: { text: string; matchType: string; resourceName: string }[];
}

export const addNegativeKeyword: MutationDefinition<'add_negative_keyword', AddInput, AddState> = {
  name: 'add_negative_keyword',
  title: 'Add negative keywords',
  description:
    'Adds negative keywords to exactly one campaign or one ad group, preventing ads from ' +
    'showing for matching searches. This reduces reach and can reduce spend. Keywords that ' +
    'already exist at that scope are reported as existing rather than duplicated. All ' +
    'operations succeed or all fail together. Shared negative keyword lists are not supported.',
  resourceType: 'campaign_criterion',
  annotations: { title: 'Add negative keywords', ...ADDITIVE_ANNOTATIONS },

  buildInputSchema: (policy) => ({
    customerId: CustomerIdInput,
    campaignId: NumericIdInput.optional().describe(
      'Target campaign. Supply exactly one of campaignId or adGroupId.',
    ),
    adGroupId: NumericIdInput.optional().describe(
      'Target ad group. Supply exactly one of campaignId or adGroupId.',
    ),
    keywords: z
      .array(
        z.strictObject({
          text: z.string().min(1).max(policy.maxTextLength),
          matchType: policy.allowedMatchTypes
            ? z.enum(policy.allowedMatchTypes as [string, ...string[]])
            : MatchTypeInput,
        }),
      )
      .min(1)
      .max(policy.maxResourcesPerCall),
  }),

  outputSchema: {
    ...MUTATION_OUTPUT_SHAPE,
    scope: z.string(),
    scopeId: z.string(),
    createdCount: z.number(),
    duplicateCount: z.number(),
    results: z.array(z.record(z.string(), z.unknown())),
    googleAdsRequestId: z.string().nullable().optional(),
    validatedOperationHash: z.string().optional(),
  },

  async fetchState(ctx, input): Promise<AddState> {
    const hasCampaign = input.campaignId !== undefined;
    const hasAdGroup = input.adGroupId !== undefined;
    if (hasCampaign === hasAdGroup) {
      throw new InvalidArgumentError(
        'Supply exactly one of campaignId or adGroupId to target a scope.',
        {},
      );
    }

    const scope: 'campaign' | 'ad_group' = hasCampaign ? 'campaign' : 'ad_group';
    const scopeId = (hasCampaign ? input.campaignId : input.adGroupId) as string;

    const ownerQuery = hasCampaign
      ? `SELECT campaign.id, campaign.name, campaign.status, campaign.resource_name FROM campaign WHERE campaign.id = ${gaqlIdList([scopeId])} LIMIT 1`
      : `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.resource_name, campaign.id, campaign.status FROM ad_group WHERE ad_group.id = ${gaqlIdList([scopeId])} LIMIT 1`;

    const ownerPage = await ctx.transport.search(
      { customerId: ctx.customerId, query: ownerQuery },
      { label: 'negative_scope' },
    );
    const ownerRow = ownerPage.results[0];
    if (!ownerRow) throw new ResourceNotFoundError(scope, scopeId);

    const owner = (hasCampaign ? ownerRow.campaign : ownerRow.adGroup) as Record<string, unknown>;
    if (owner.status === 'REMOVED') {
      throw new UnsupportedResourceStateError(
        `${scope} "${String(owner.name ?? scopeId)}" is REMOVED; negatives cannot be added to it.`,
        { resourceType: scope, resourceName: String(owner.resourceName ?? ''), state: 'REMOVED' },
      );
    }

    const existingQuery = hasCampaign
      ? `SELECT campaign_criterion.resource_name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign.id = ${gaqlIdList([scopeId])} AND campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'`
      : `SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group.id = ${gaqlIdList([scopeId])} AND ad_group_criterion.negative = TRUE AND ad_group_criterion.type = 'KEYWORD'`;

    const existingRes = await ctx.transport.searchPaginated(
      { customerId: ctx.customerId, query: existingQuery, maxRows: 5000 },
      { label: 'existing_negatives' },
    );

    const existing = new Map<string, string>();
    for (const row of existingRes.rows) {
      const node = (hasCampaign ? row.campaignCriterion : row.adGroupCriterion) as Record<string, any>;
      const text = node?.keyword?.text;
      const matchType = node?.keyword?.matchType;
      if (typeof text === 'string' && typeof matchType === 'string') {
        existing.set(dedupeKey(text, matchType), String(node.resourceName ?? ''));
      }
    }

    const seen = new Set<string>();
    const toCreate: { text: string; matchType: string }[] = [];
    const duplicates: { text: string; matchType: string; resourceName: string }[] = [];

    for (const kw of input.keywords) {
      validateKeywordText(kw.text, ctx.policy.maxTextLength);
      const key = dedupeKey(kw.text, kw.matchType);
      if (seen.has(key)) {
        throw new InvalidArgumentError(
          `Duplicate entry within the request: "${kw.text}" (${kw.matchType}).`,
          { text: kw.text, matchType: kw.matchType },
        );
      }
      seen.add(key);
      const existingResourceName = existing.get(key);
      if (existingResourceName !== undefined) {
        // Already present is a no-op, not an error: the desired end state holds.
        duplicates.push({ ...kw, resourceName: existingResourceName });
      } else {
        toCreate.push(kw);
      }
    }

    return {
      scope,
      scopeId,
      scopeName: String(owner.name ?? scopeId),
      scopeResourceName: String(owner.resourceName ?? ''),
      existing,
      toCreate,
      duplicates,
    };
  },

  checkConstraints(ctx, input, _state): void {
    const allowed = ctx.policy.allowedMatchTypes;
    if (allowed) {
      for (const kw of input.keywords) {
        if (!allowed.includes(kw.matchType as 'EXACT' | 'PHRASE' | 'BROAD')) {
          throw new InvalidArgumentError(
            `Match type ${kw.matchType} is not permitted. Allowed: ${allowed.join(', ')}.`,
            { matchType: kw.matchType, allowedMatchTypes: allowed },
          );
        }
      }
    }
  },

  detectNoOp(ctx, _input, state): Record<string, unknown> | null {
    if (state.toCreate.length > 0) return null;
    return {
      success: true,
      changed: false,
      customerId: ctx.customerId,
      resourceType: state.scope === 'campaign' ? 'campaign_criterion' : 'ad_group_criterion',
      scope: state.scope,
      scopeId: state.scopeId,
      createdCount: 0,
      duplicateCount: state.duplicates.length,
      results: state.duplicates.map((d) => ({
        text: d.text,
        matchType: d.matchType,
        resourceName: d.resourceName,
        created: false,
        alreadyExisted: true,
      })),
      googleAdsRequestId: null,
      message: `All ${state.duplicates.length} negative keyword(s) already existed on ${state.scope} "${state.scopeName}".`,
    };
  },

  buildOperations(ctx, _input, state): MutateOperation[] {
    return state.toCreate.map((kw) =>
      state.scope === 'campaign'
        ? {
            campaignCriterionOperation: {
              create: {
                campaign: rn.campaign(ctx.customerId, state.scopeId),
                negative: true,
                keyword: { text: kw.text, matchType: kw.matchType },
              },
            },
          }
        : {
            adGroupCriterionOperation: {
              create: {
                adGroup: rn.adGroup(ctx.customerId, state.scopeId),
                negative: true,
                keyword: { text: kw.text, matchType: kw.matchType },
              },
            },
          },
    );
  },

  buildResult(ctx, _input, state, exec): Record<string, unknown> {
    const created = state.toCreate.map((kw, i) => {
      const response = exec.responses[i];
      const resourceName =
        response?.campaignCriterionResult?.resourceName ??
        response?.adGroupCriterionResult?.resourceName ??
        null;
      return {
        text: kw.text,
        matchType: kw.matchType,
        resourceName,
        criterionId: typeof resourceName === 'string' ? (resourceName.split('~').pop() ?? null) : null,
        created: true,
        alreadyExisted: false,
      };
    });
    const duplicates = state.duplicates.map((d) => ({
      text: d.text,
      matchType: d.matchType,
      resourceName: d.resourceName,
      created: false,
      alreadyExisted: true,
    }));

    return {
      success: true,
      changed: true,
      customerId: ctx.customerId,
      resourceType: state.scope === 'campaign' ? 'campaign_criterion' : 'ad_group_criterion',
      scope: state.scope,
      scopeId: state.scopeId,
      createdCount: created.length,
      duplicateCount: duplicates.length,
      results: [...created, ...duplicates],
      googleAdsRequestId: exec.requestId ?? null,
      validatedOperationHash: exec.operationHash,
      message: `Added ${created.length} negative keyword(s) to ${state.scope} "${state.scopeName}"${duplicates.length > 0 ? `; ${duplicates.length} already existed` : ''}.`,
    };
  },

  canonicalArguments(input): unknown {
    return {
      campaignId: input.campaignId ?? null,
      adGroupId: input.adGroupId ?? null,
      count: input.keywords.length,
      matchTypes: [...new Set(input.keywords.map((k) => k.matchType))],
    };
  },
};

/* ------------------------------------------------------------------ *
 * remove_negative_keyword
 * ------------------------------------------------------------------ */

interface RemoveCriterion {
  resourceName?: string;
  scope?: 'campaign' | 'ad_group';
  scopeId?: string;
  criterionId?: string;
  text?: string;
  matchType?: string;
}

interface RemoveInput {
  customerId: string;
  criteria: RemoveCriterion[];
}

interface RemoveResolved {
  resourceName: string;
  scope: 'campaign' | 'ad_group';
  found: boolean;
  text?: string;
  matchType?: string;
}

interface RemoveState {
  resolved: RemoveResolved[];
  toRemove: RemoveResolved[];
}

const NEGATIVE_RESOURCE_NAME =
  /^customers\/\d{10}\/(campaignCriteria|adGroupCriteria)\/\d+~\d+$/;

export const removeNegativeKeyword: MutationDefinition<
  'remove_negative_keyword',
  RemoveInput,
  RemoveState
> = {
  name: 'remove_negative_keyword',
  title: 'Remove negative keywords',
  description:
    'Removes negative keywords, allowing ads to show again for matching searches. This can ' +
    'increase reach and spend. Each criterion must be identified concretely by resource name ' +
    'or by scope plus criterion ID; removal by text alone is refused when more than one ' +
    'criterion matches. A criterion that no longer exists is reported as not found rather ' +
    'than failing the call.',
  resourceType: 'campaign_criterion',
  annotations: { title: 'Remove negative keywords', ...DESTRUCTIVE_ANNOTATIONS },

  buildInputSchema: (policy) => ({
    customerId: CustomerIdInput,
    criteria: z
      .array(
        z.strictObject({
          resourceName: z.string().regex(NEGATIVE_RESOURCE_NAME).optional(),
          scope: z.enum(['campaign', 'ad_group']).optional(),
          scopeId: NumericIdInput.optional(),
          criterionId: NumericIdInput.optional(),
          ...(policy.allowTextResolution
            ? { text: z.string().min(1).max(80).optional(), matchType: MatchTypeInput.optional() }
            : {}),
        }),
      )
      .min(1)
      .max(policy.maxResourcesPerCall),
  }),

  outputSchema: {
    ...MUTATION_OUTPUT_SHAPE,
    removedCount: z.number(),
    notFoundCount: z.number(),
    results: z.array(z.record(z.string(), z.unknown())),
    googleAdsRequestId: z.string().nullable().optional(),
    validatedOperationHash: z.string().optional(),
  },

  async fetchState(ctx, input): Promise<RemoveState> {
    const resourceNames: { resourceName: string; scope: 'campaign' | 'ad_group' }[] = [];

    for (const criterion of input.criteria) {
      if (criterion.resourceName) {
        // A resource name is model-controlled input carrying a customer ID. Without
        // this check a well-formed name pointing at another account would bypass the
        // allowlist entirely.
        assertResourceNameCustomer(criterion.resourceName, ctx.customerId, ctx.deps.allowlist.size);
        resourceNames.push({
          resourceName: criterion.resourceName,
          scope: criterion.resourceName.includes('/campaignCriteria/') ? 'campaign' : 'ad_group',
        });
        continue;
      }

      if (criterion.scope && criterion.scopeId && criterion.criterionId) {
        resourceNames.push({
          resourceName:
            criterion.scope === 'campaign'
              ? rn.campaignCriterion(ctx.customerId, criterion.scopeId, criterion.criterionId)
              : rn.adGroupCriterion(ctx.customerId, criterion.scopeId, criterion.criterionId),
          scope: criterion.scope,
        });
        continue;
      }

      if (criterion.text) {
        if (!ctx.policy.allowTextResolution) {
          throw new InvalidArgumentError(
            'Removal by keyword text is disabled. Supply a resourceName, or scope plus ' +
              'scopeId and criterionId.',
            {},
          );
        }
        const resolved = await resolveByText(ctx, criterion);
        resourceNames.push(resolved);
        continue;
      }

      throw new InvalidArgumentError(
        'Each criterion needs either a resourceName, or scope plus scopeId and criterionId.',
        {},
      );
    }

    const campaignNames = resourceNames.filter((r) => r.scope === 'campaign').map((r) => r.resourceName);
    const adGroupNames = resourceNames.filter((r) => r.scope === 'ad_group').map((r) => r.resourceName);

    const found = new Map<string, Record<string, any>>();
    if (campaignNames.length > 0) {
      const res = await ctx.transport.searchPaginated(
        {
          customerId: ctx.customerId,
          query: `SELECT campaign_criterion.resource_name, campaign_criterion.negative, campaign_criterion.type, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.resource_name IN (${gaqlStringList(campaignNames)})`,
          maxRows: campaignNames.length + 10,
        },
        { label: 'verify_campaign_negatives' },
      );
      for (const row of res.rows) {
        const node = row.campaignCriterion as Record<string, any>;
        if (node?.resourceName) found.set(String(node.resourceName), node);
      }
    }
    if (adGroupNames.length > 0) {
      const res = await ctx.transport.searchPaginated(
        {
          customerId: ctx.customerId,
          query: `SELECT ad_group_criterion.resource_name, ad_group_criterion.negative, ad_group_criterion.type, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group_criterion.resource_name IN (${gaqlStringList(adGroupNames)})`,
          maxRows: adGroupNames.length + 10,
        },
        { label: 'verify_ad_group_negatives' },
      );
      for (const row of res.rows) {
        const node = row.adGroupCriterion as Record<string, any>;
        if (node?.resourceName) found.set(String(node.resourceName), node);
      }
    }

    const resolved: RemoveResolved[] = resourceNames.map((entry) => {
      const node = found.get(entry.resourceName);
      if (!node) return { ...entry, found: false };
      if (node.negative !== true) {
        // Refuse to delete a positive keyword through the negatives tool.
        throw new UnsupportedResourceStateError(
          `Criterion ${entry.resourceName} is not a negative keyword. Use pause_keyword to stop ` +
            'a bidding keyword.',
          { resourceName: entry.resourceName, negative: false },
        );
      }
      return {
        ...entry,
        found: true,
        ...(node.keyword?.text !== undefined && { text: String(node.keyword.text) }),
        ...(node.keyword?.matchType !== undefined && { matchType: String(node.keyword.matchType) }),
      };
    });

    return { resolved, toRemove: resolved.filter((r) => r.found) };
  },

  checkConstraints(): void {
    // Identity and ownership are established during fetchState.
  },

  detectNoOp(ctx, _input, state): Record<string, unknown> | null {
    if (state.toRemove.length > 0) return null;
    return {
      success: true,
      changed: false,
      customerId: ctx.customerId,
      resourceType: 'campaign_criterion',
      removedCount: 0,
      notFoundCount: state.resolved.length,
      results: state.resolved.map((r) => ({ resourceName: r.resourceName, result: 'not_found' })),
      googleAdsRequestId: null,
      message: `None of the ${state.resolved.length} criterion(s) exist; nothing to remove.`,
    };
  },

  buildOperations(_ctx, _input, state): MutateOperation[] {
    return state.toRemove.map((r) =>
      r.scope === 'campaign'
        ? { campaignCriterionOperation: { remove: r.resourceName } }
        : { adGroupCriterionOperation: { remove: r.resourceName } },
    );
  },

  buildResult(ctx, _input, state, exec): Record<string, unknown> {
    const removed = new Set(state.toRemove.map((r) => r.resourceName));
    return {
      success: true,
      changed: state.toRemove.length > 0,
      customerId: ctx.customerId,
      resourceType: 'campaign_criterion',
      removedCount: state.toRemove.length,
      notFoundCount: state.resolved.length - state.toRemove.length,
      results: state.resolved.map((r) => ({
        resourceName: r.resourceName,
        result: removed.has(r.resourceName) ? 'removed' : 'not_found',
        text: r.text ?? null,
        matchType: r.matchType ?? null,
      })),
      googleAdsRequestId: exec.requestId ?? null,
      validatedOperationHash: exec.operationHash,
      message: `Removed ${state.toRemove.length} negative keyword(s)${state.resolved.length > state.toRemove.length ? `; ${state.resolved.length - state.toRemove.length} not found` : ''}.`,
    };
  },

  canonicalArguments(input): unknown {
    return {
      count: input.criteria.length,
      identifiedBy: input.criteria.map((c) =>
        c.resourceName ? 'resourceName' : c.criterionId ? 'criterionId' : 'text',
      ),
    };
  },
};

/** Resolve a negative by text, refusing when the match is ambiguous. */
async function resolveByText(
  ctx: { customerId: string; transport: Pick<GoogleAdsTransport, 'searchPaginated'> },
  criterion: RemoveCriterion,
): Promise<{ resourceName: string; scope: 'campaign' | 'ad_group' }> {
  const text = criterion.text as string;
  const matchClause =
    criterion.matchType !== undefined
      ? ` AND campaign_criterion.keyword.match_type = '${criterion.matchType}'`
      : '';

  const campaignRes = await ctx.transport.searchPaginated(
    {
      customerId: ctx.customerId,
      query: `SELECT campaign_criterion.resource_name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.keyword.text = ${gaqlStringList([text])}${matchClause}`,
      maxRows: 50,
    },
    { label: 'resolve_negative_by_text' },
  );

  const candidates = campaignRes.rows
    .map((row) => (row.campaignCriterion as { resourceName?: string } | undefined)?.resourceName ?? '')
    .filter(Boolean);

  if (candidates.length === 0) {
    throw new ResourceNotFoundError('campaign_criterion', text);
  }
  if (candidates.length > 1) {
    // Never guess which of several matching negatives the caller meant.
    throw new DuplicateResourceError(
      `Keyword text "${text}" matches ${candidates.length} negative criteria. Supply a ` +
        'resourceName to identify exactly one.',
      { text, candidates },
    );
  }
  return { resourceName: candidates[0] as string, scope: 'campaign' };
}
