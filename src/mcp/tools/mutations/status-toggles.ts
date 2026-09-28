import { z } from 'zod';
import {
  ResourceNotFoundError,
  StaleResourceStateError,
  UnsupportedResourceStateError,
  InvalidArgumentError,
} from '../../../errors/tool-errors.js';
import { rn } from '../../../google-ads/resource-names.js';
import type { MutateOperation } from '../../../google-ads/types.js';
import { gaqlIdList, gaqlStringList } from '../../../util/gaql.js';
import { CustomerIdInput, NumericIdInput } from '../shared/schemas.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATION_OUTPUT_SHAPE,
  type MutationDefinition,
} from './pipeline.js';
import type { MutationToolName } from '../../../capabilities/tool-names.js';

type Target = 'ENABLED' | 'PAUSED';

/* ------------------------------------------------------------------ *
 * Single-resource toggles: campaign and ad group
 * ------------------------------------------------------------------ */

interface SingleState {
  resourceName: string;
  status: string;
  name: string;
  parentStatus?: string;
  parentName?: string;
}

interface SingleInput {
  customerId: string;
  expectedCurrentStatus?: Target;
  [key: string]: unknown;
}

function singleToggleTool<N extends MutationToolName>(config: {
  name: N;
  target: Target;
  entity: 'campaign' | 'ad_group';
  idField: 'campaignId' | 'adGroupId';
  title: string;
  description: string;
}): MutationDefinition<N, SingleInput, SingleState> {
  const isCampaign = config.entity === 'campaign';
  const resourceType = isCampaign ? 'campaign' : 'ad_group';

  return {
    name: config.name,
    title: config.title,
    description: config.description,
    resourceType,
    annotations: { title: config.title, ...DESTRUCTIVE_ANNOTATIONS },
    buildInputSchema: () => ({
      customerId: CustomerIdInput,
      [config.idField]: NumericIdInput,
      expectedCurrentStatus: z
        .enum(['ENABLED', 'PAUSED'])
        .optional()
        .describe(
          'Optional optimistic concurrency check. If supplied and the resource is no longer ' +
            'in this state, the call is rejected with STALE_RESOURCE_STATE.',
        ),
    }),
    outputSchema: {
      ...MUTATION_OUTPUT_SHAPE,
      resourceId: z.string(),
      resourceName: z.string(),
      before: z.record(z.string(), z.unknown()),
      after: z.record(z.string(), z.unknown()),
      googleAdsRequestId: z.string().nullable().optional(),
      validatedOperationHash: z.string().optional(),
    },

    async fetchState(ctx, input): Promise<SingleState> {
      const id = String(input[config.idField]);
      const query = isCampaign
        ? `SELECT campaign.id, campaign.name, campaign.status, campaign.resource_name, campaign.advertising_channel_type FROM campaign WHERE campaign.id = ${gaqlIdList([id])} LIMIT 1`
        : `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.resource_name, campaign.id, campaign.name, campaign.status FROM ad_group WHERE ad_group.id = ${gaqlIdList([id])} LIMIT 1`;

      const page = await ctx.transport.search({ customerId: ctx.customerId, query }, { label: config.name });
      const row = page.results[0];
      if (!row) throw new ResourceNotFoundError(resourceType, id);

      if (isCampaign) {
        const c = row.campaign as Record<string, unknown>;
        return {
          resourceName: String(c.resourceName ?? rn.campaign(ctx.customerId, id)),
          status: String(c.status ?? ''),
          name: String(c.name ?? ''),
        };
      }
      const g = row.adGroup as Record<string, unknown>;
      const parent = (row.campaign ?? {}) as Record<string, unknown>;
      return {
        resourceName: String(g.resourceName ?? rn.adGroup(ctx.customerId, id)),
        status: String(g.status ?? ''),
        name: String(g.name ?? ''),
        parentStatus: String(parent.status ?? ''),
        parentName: String(parent.name ?? ''),
      };
    },

    checkConstraints(_ctx, input, state): void {
      // Never silently act on a removed resource - REMOVED is terminal in Google Ads
      // and "enabling" one is not a state this tool can reach.
      if (state.status === 'REMOVED') {
        throw new UnsupportedResourceStateError(
          `${resourceType} "${state.name}" is REMOVED. Removed resources cannot be paused or enabled.`,
          { resourceType, resourceName: state.resourceName, state: state.status },
        );
      }
      if (state.status !== 'ENABLED' && state.status !== 'PAUSED') {
        throw new UnsupportedResourceStateError(
          `${resourceType} "${state.name}" is in unsupported state ${state.status}.`,
          { resourceType, resourceName: state.resourceName, state: state.status },
        );
      }
      if (state.parentStatus === 'REMOVED') {
        throw new UnsupportedResourceStateError(
          `The parent campaign of ${resourceType} "${state.name}" is REMOVED.`,
          { resourceType, resourceName: state.resourceName, parentStatus: state.parentStatus },
        );
      }
      if (input.expectedCurrentStatus && state.status !== input.expectedCurrentStatus) {
        throw new StaleResourceStateError('status', input.expectedCurrentStatus, state.status, {
          resourceType,
          resourceName: state.resourceName,
        });
      }
    },

    detectNoOp(ctx, input, state): Record<string, unknown> | null {
      if (state.status !== config.target) return null;
      const verb = config.target === 'PAUSED' ? 'paused' : 'enabled';
      return {
        success: true,
        changed: false,
        customerId: ctx.customerId,
        resourceType,
        resourceId: String(input[config.idField]),
        resourceName: state.resourceName,
        before: { status: state.status, name: state.name },
        after: { status: state.status, name: state.name },
        googleAdsRequestId: null,
        message: `${isCampaign ? 'Campaign' : 'Ad group'} "${state.name}" was already ${verb}.`,
      };
    },

    buildOperations(_ctx, _input, state): MutateOperation[] {
      const update = { resourceName: state.resourceName, status: config.target };
      // updateMask in REST JSON is a comma-separated string of camelCase paths.
      return isCampaign
        ? [{ campaignOperation: { update, updateMask: 'status' } }]
        : [{ adGroupOperation: { update, updateMask: 'status' } }];
    },

    buildResult(ctx, input, state, exec): Record<string, unknown> {
      const verb = config.target === 'PAUSED' ? 'Paused' : 'Enabled';
      const parentNote =
        !isCampaign && config.target === 'ENABLED' && state.parentStatus === 'PAUSED'
          ? ' Its campaign is still paused, so it will not serve.'
          : '';
      return {
        success: true,
        changed: true,
        customerId: ctx.customerId,
        resourceType,
        resourceId: String(input[config.idField]),
        resourceName: state.resourceName,
        before: { status: state.status, name: state.name },
        after: { status: config.target, name: state.name },
        googleAdsRequestId: exec.requestId ?? null,
        validatedOperationHash: exec.operationHash,
        message: `${verb} ${isCampaign ? 'campaign' : 'ad group'} "${state.name}".${parentNote}`,
      };
    },

    canonicalArguments(input): unknown {
      return {
        [config.idField]: input[config.idField],
        targetStatus: config.target,
        expectedCurrentStatus: input.expectedCurrentStatus ?? null,
      };
    },
  };
}

export const pauseCampaign = singleToggleTool({
  name: 'pause_campaign',
  target: 'PAUSED',
  entity: 'campaign',
  idField: 'campaignId',
  title: 'Pause a campaign',
  description:
    'Sets a campaign\'s status to PAUSED. The campaign immediately stops serving ads and ' +
    'stops accruing spend; its budget, ad groups, keywords and ads are left untouched and it ' +
    'can be re-enabled with enable_campaign. If the campaign is already paused this returns a ' +
    'successful no-op without calling Google Ads.',
});

export const enableCampaign = singleToggleTool({
  name: 'enable_campaign',
  target: 'ENABLED',
  entity: 'campaign',
  idField: 'campaignId',
  title: 'Enable a campaign',
  description:
    'Sets a campaign\'s status to ENABLED. The campaign resumes serving ads and will begin ' +
    'accruing spend against its budget. Removed campaigns are rejected rather than enabled. ' +
    'If the campaign is already enabled this returns a successful no-op.',
});

export const pauseAdGroup = singleToggleTool({
  name: 'pause_ad_group',
  target: 'PAUSED',
  entity: 'ad_group',
  idField: 'adGroupId',
  title: 'Pause an ad group',
  description:
    'Sets an ad group\'s status to PAUSED. Its ads stop serving and stop accruing spend; the ' +
    'rest of the campaign is unaffected. Already-paused ad groups return a successful no-op.',
});

export const enableAdGroup = singleToggleTool({
  name: 'enable_ad_group',
  target: 'ENABLED',
  entity: 'ad_group',
  idField: 'adGroupId',
  title: 'Enable an ad group',
  description:
    'Sets an ad group\'s status to ENABLED, allowing its ads to serve and accrue spend. If the ' +
    'parent campaign is paused the ad group still will not serve, and the result says so. ' +
    'Already-enabled ad groups return a successful no-op.',
});

/* ------------------------------------------------------------------ *
 * Batch toggles: ads and keywords
 * ------------------------------------------------------------------ */

interface BatchItem {
  resourceName: string;
  status: string;
  label: string;
  keys: Record<string, string>;
}

interface BatchState {
  items: BatchItem[];
  toChange: BatchItem[];
}

interface BatchInput {
  customerId: string;
  [key: string]: unknown;
}

function batchToggleTool<N extends MutationToolName>(config: {
  name: N;
  target: Target;
  entity: 'ad' | 'keyword';
  title: string;
  description: string;
}): MutationDefinition<N, BatchInput, BatchState> {
  const isAd = config.entity === 'ad';
  const resourceType = isAd ? 'ad_group_ad' : 'ad_group_criterion';
  const collection = isAd ? 'ads' : 'keywords';

  return {
    name: config.name,
    title: config.title,
    description: config.description,
    resourceType,
    annotations: { title: config.title, ...DESTRUCTIVE_ANNOTATIONS },
    buildInputSchema: () => ({
      customerId: CustomerIdInput,
      [collection]: z
        .array(
          z.strictObject(
            isAd
              ? {
                  adGroupId: NumericIdInput,
                  adId: NumericIdInput,
                  expectedCurrentStatus: z.enum(['ENABLED', 'PAUSED']).optional(),
                }
              : {
                  adGroupId: NumericIdInput,
                  criterionId: NumericIdInput,
                  expectedCurrentStatus: z.enum(['ENABLED', 'PAUSED']).optional(),
                },
          ),
        )
        .min(1)
        .max(isAd ? 100 : 1000)
        .describe(
          `Up to ${isAd ? 100 : 1000} items. ` +
            'All succeed or all fail: partial success is disabled.',
        ),
    }),
    outputSchema: {
      ...MUTATION_OUTPUT_SHAPE,
      requested: z.number(),
      changedCount: z.number(),
      unchangedCount: z.number(),
      results: z.array(z.record(z.string(), z.unknown())),
      googleAdsRequestId: z.string().nullable().optional(),
      validatedOperationHash: z.string().optional(),
    },

    async fetchState(ctx, input): Promise<BatchState> {
      const requested = input[collection] as Record<string, string>[];

      const seen = new Set<string>();
      const resourceNames = requested.map((item) => {
        const childId = isAd ? item.adId : item.criterionId;
        const resourceName = isAd
          ? rn.adGroupAd(ctx.customerId, item.adGroupId as string, childId as string)
          : rn.adGroupCriterion(ctx.customerId, item.adGroupId as string, childId as string);
        if (seen.has(resourceName)) {
          throw new InvalidArgumentError(`Duplicate entry for ${resourceName}.`, { resourceName });
        }
        seen.add(resourceName);
        return resourceName;
      });

      const query = isAd
        ? `SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.name, ad_group.id, campaign.id, campaign.status FROM ad_group_ad WHERE ad_group_ad.resource_name IN (${gaqlStringList(resourceNames)})`
        : `SELECT ad_group_criterion.resource_name, ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.type, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group.id, campaign.id FROM ad_group_criterion WHERE ad_group_criterion.resource_name IN (${gaqlStringList(resourceNames)})`;

      const res = await ctx.transport.searchPaginated(
        { customerId: ctx.customerId, query, maxRows: resourceNames.length + 10 },
        { label: config.name },
      );

      const byResourceName = new Map<string, Record<string, any>>();
      for (const row of res.rows) {
        const node = (isAd ? row.adGroupAd : row.adGroupCriterion) as Record<string, any>;
        if (node?.resourceName) byResourceName.set(String(node.resourceName), node);
      }

      const missing = resourceNames.filter((r) => !byResourceName.has(r));
      if (missing.length > 0) {
        throw new ResourceNotFoundError(resourceType, missing[0] as string, { missing });
      }

      const items: BatchItem[] = requested.map((item, i) => {
        const resourceName = resourceNames[i] as string;
        const node = byResourceName.get(resourceName) as Record<string, any>;
        return {
          resourceName,
          status: String(node.status ?? ''),
          label: isAd
            ? String(node.ad?.name ?? node.ad?.id ?? item.adId)
            : String(node.keyword?.text ?? item.criterionId),
          keys: (isAd
            ? { adGroupId: item.adGroupId as string, adId: item.adId as string }
            : {
                adGroupId: item.adGroupId as string,
                criterionId: item.criterionId as string,
              }) as Record<string, string>,
        };
      });

      // Validate expected statuses and reject unsupported states here, where the raw
      // node is still available.
      requested.forEach((item, i) => {
        const node = byResourceName.get(resourceNames[i] as string) as Record<string, any>;
        const current = String(node.status ?? '');
        if (current === 'REMOVED') {
          throw new UnsupportedResourceStateError(
            `${resourceType} ${resourceNames[i] as string} is REMOVED.`,
            { resourceType, resourceName: resourceNames[i], state: current },
          );
        }
        if (!isAd) {
          // Negative criteria carry no status; pausing one is meaningless and the API
          // rejects it. Refuse rather than emitting an operation that will fail.
          if (node.negative === true) {
            throw new UnsupportedResourceStateError(
              `Criterion ${resourceNames[i] as string} is a negative keyword. Negative keywords have no ` +
                'status and cannot be paused or enabled; use remove_negative_keyword instead.',
              { resourceType, resourceName: resourceNames[i], negative: true },
            );
          }
          if (node.type !== undefined && node.type !== 'KEYWORD') {
            throw new UnsupportedResourceStateError(
              `Criterion ${resourceNames[i] as string} is of type ${String(node.type)}, not KEYWORD.`,
              { resourceType, resourceName: resourceNames[i], criterionType: node.type },
            );
          }
        }
        if (item.expectedCurrentStatus && current !== item.expectedCurrentStatus) {
          throw new StaleResourceStateError('status', item.expectedCurrentStatus, current, {
            resourceType,
            resourceName: resourceNames[i],
          });
        }
      });

      return { items, toChange: items.filter((it) => it.status !== config.target) };
    },

    checkInputConstraints(ctx, input): void {
      const requested = (input[collection] as unknown[]).length;
      const max = (ctx.policy as { maxResourcesPerCall: number }).maxResourcesPerCall;
      if (requested > max) {
        throw new InvalidArgumentError(
          `${config.name} accepts at most ${max} items per call; ${requested} were supplied.`,
          { requested, maximum: max },
        );
      }
    },

    checkConstraints(): void {},

    detectNoOp(ctx, _input, state): Record<string, unknown> | null {
      if (state.toChange.length > 0) return null;
      const verb = config.target === 'PAUSED' ? 'paused' : 'enabled';
      return {
        success: true,
        changed: false,
        customerId: ctx.customerId,
        resourceType,
        requested: state.items.length,
        changedCount: 0,
        unchangedCount: state.items.length,
        results: state.items.map((it) => ({
          ...it.keys,
          resourceName: it.resourceName,
          before: { status: it.status },
          after: { status: it.status },
          changed: false,
        })),
        googleAdsRequestId: null,
        message: `All ${state.items.length} ${isAd ? 'ad(s)' : 'keyword(s)'} were already ${verb}.`,
      };
    },

    buildOperations(_ctx, _input, state): MutateOperation[] {
      return state.toChange.map((it) => {
        const update = { resourceName: it.resourceName, status: config.target };
        return isAd
          ? { adGroupAdOperation: { update, updateMask: 'status' } }
          : { adGroupCriterionOperation: { update, updateMask: 'status' } };
      });
    },

    buildResult(ctx, _input, state, exec): Record<string, unknown> {
      const changing = new Set(state.toChange.map((it) => it.resourceName));
      const verb = config.target === 'PAUSED' ? 'Paused' : 'Enabled';
      return {
        success: true,
        changed: state.toChange.length > 0,
        customerId: ctx.customerId,
        resourceType,
        requested: state.items.length,
        changedCount: state.toChange.length,
        unchangedCount: state.items.length - state.toChange.length,
        results: state.items.map((it) => ({
          ...it.keys,
          resourceName: it.resourceName,
          before: { status: it.status },
          after: { status: changing.has(it.resourceName) ? config.target : it.status },
          changed: changing.has(it.resourceName),
        })),
        googleAdsRequestId: exec.requestId ?? null,
        validatedOperationHash: exec.operationHash,
        message: `${verb} ${state.toChange.length} ${isAd ? 'ad(s)' : 'keyword(s)'}; ${state.items.length - state.toChange.length} already in that state.`,
      };
    },

    canonicalArguments(input): unknown {
      const items = input[collection] as Record<string, string>[];
      return {
        targetStatus: config.target,
        count: items.length,
        // IDs only - never keyword text or ad copy.
        items: items.map((it) => (isAd ? { adGroupId: it.adGroupId, adId: it.adId } : { adGroupId: it.adGroupId, criterionId: it.criterionId })),
      };
    },
  };
}

export const pauseAd = batchToggleTool({
  name: 'pause_ad',
  target: 'PAUSED',
  entity: 'ad',
  title: 'Pause ads',
  description:
    'Sets one or more ads to PAUSED so they stop serving. Ads already paused are skipped and ' +
    'reported as unchanged. All operations succeed or all fail together: partial success is ' +
    'disabled, so one invalid ad rejects the whole batch.',
});

export const enableAd = batchToggleTool({
  name: 'enable_ad',
  target: 'ENABLED',
  entity: 'ad',
  title: 'Enable ads',
  description:
    'Sets one or more ads to ENABLED so they can serve and accrue spend. Ads already enabled ' +
    'are skipped. All operations succeed or all fail together.',
});

export const pauseKeyword = batchToggleTool({
  name: 'pause_keyword',
  target: 'PAUSED',
  entity: 'keyword',
  title: 'Pause keywords',
  description:
    'Sets one or more bidding keywords to PAUSED so they stop triggering ads and stop ' +
    'accruing spend. Negative keywords are rejected: they have no status. All operations ' +
    'succeed or all fail together.',
});

export const enableKeyword = batchToggleTool({
  name: 'enable_keyword',
  target: 'ENABLED',
  entity: 'keyword',
  title: 'Enable keywords',
  description:
    'Sets one or more bidding keywords to ENABLED so they can trigger ads and accrue spend. ' +
    'Negative keywords are rejected. All operations succeed or all fail together.',
});
