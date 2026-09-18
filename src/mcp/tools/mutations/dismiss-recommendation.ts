import { z } from 'zod';
import { ResourceNotFoundError, ToolConstraintViolationError } from '../../../errors/tool-errors.js';
import { assertResourceNameCustomer } from '../../../google-ads/resource-names.js';
import type { MutateOperation } from '../../../google-ads/types.js';
import type { ExecOutcome } from '../../../google-ads/validation.js';
import { canonicalJson, sha256Hex } from '../../../util/json.js';
import { gaqlStringList } from '../../../util/gaql.js';
import { CustomerIdInput } from '../shared/schemas.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATION_OUTPUT_SHAPE,
  type MutationDefinition,
} from './pipeline.js';

const RECOMMENDATION_RESOURCE_NAME = /^customers\/\d{10}\/recommendations\/[A-Za-z0-9_-]+$/;

interface DismissInput {
  customerId: string;
  recommendationResourceNames: string[];
}

interface DismissRecord {
  resourceName: string;
  type: string;
  dismissed: boolean;
}

interface DismissState {
  records: DismissRecord[];
  toDismiss: DismissRecord[];
}

export const dismissRecommendation: MutationDefinition<
  'dismiss_recommendation',
  DismissInput,
  DismissState
> = {
  name: 'dismiss_recommendation',
  title: 'Dismiss Google Ads recommendations',
  description:
    'Dismisses one or more Google Ads recommendations so they stop appearing. Dismissing a ' +
    'recommendation does not change any campaign setting and does not affect spend; it only ' +
    'hides the suggestion. This server cannot apply recommendations, only dismiss them. Note ' +
    'that the Google Ads dismiss endpoint offers no validate-only mode, so unlike other ' +
    'mutation tools this one cannot pre-validate before executing.',
  resourceType: 'recommendation',
  annotations: { title: 'Dismiss recommendations', ...DESTRUCTIVE_ANNOTATIONS },

  buildInputSchema: (policy) => ({
    customerId: CustomerIdInput,
    recommendationResourceNames: z
      .array(z.string().regex(RECOMMENDATION_RESOURCE_NAME))
      .min(1)
      .max(policy.maxResourcesPerCall)
      .describe('Full recommendation resource names, as returned by list_recommendations.'),
  }),

  outputSchema: {
    ...MUTATION_OUTPUT_SHAPE,
    dismissedCount: z.number(),
    alreadyDismissedCount: z.number(),
    results: z.array(z.record(z.string(), z.unknown())),
    validateOnlySupported: z.boolean(),
    googleAdsRequestId: z.string().nullable().optional(),
  },

  async fetchState(ctx, input): Promise<DismissState> {
    for (const name of input.recommendationResourceNames) {
      assertResourceNameCustomer(name, ctx.customerId, ctx.deps.allowlist.size);
    }

    const res = await ctx.transport.searchPaginated(
      {
        customerId: ctx.customerId,
        query: `SELECT recommendation.resource_name, recommendation.type, recommendation.dismissed FROM recommendation WHERE recommendation.resource_name IN (${gaqlStringList(input.recommendationResourceNames)})`,
        maxRows: input.recommendationResourceNames.length + 10,
      },
      { label: 'verify_recommendations' },
    );

    const found = new Map<string, Record<string, any>>();
    for (const row of res.rows) {
      const r = row.recommendation as Record<string, any>;
      if (r?.resourceName) found.set(String(r.resourceName), r);
    }

    const missing = input.recommendationResourceNames.filter((n) => !found.has(n));
    if (missing.length > 0) {
      throw new ResourceNotFoundError('recommendation', missing[0] as string, { missing });
    }

    const records: DismissRecord[] = input.recommendationResourceNames.map((name) => {
      const r = found.get(name) as Record<string, any>;
      return {
        resourceName: name,
        type: String(r.type ?? 'UNKNOWN'),
        dismissed: r.dismissed === true,
      };
    });

    return { records, toDismiss: records.filter((r) => !r.dismissed) };
  },

  checkConstraints(ctx, _input, state): void {
    const allowed = ctx.policy.allowedTypes;
    if (allowed) {
      for (const record of state.records) {
        if (!allowed.includes(record.type)) {
          throw new ToolConstraintViolationError(
            `Recommendation type ${record.type} is not in the configured allowed types.`,
            { recommendationType: record.type, allowedTypes: allowed },
          );
        }
      }
    }
    // With partialFailure disabled Google requires a single-type batch.
    const types = new Set(state.toDismiss.map((r) => r.type));
    if (types.size > 1) {
      throw new ToolConstraintViolationError(
        'All recommendations in one dismiss call must be of the same type, because partial ' +
          `failure is disabled. Received: ${[...types].join(', ')}.`,
        { types: [...types] },
      );
    }
  },

  detectNoOp(ctx, _input, state): Record<string, unknown> | null {
    if (state.toDismiss.length > 0) return null;
    return {
      success: true,
      changed: false,
      customerId: ctx.customerId,
      resourceType: 'recommendation',
      dismissedCount: 0,
      alreadyDismissedCount: state.records.length,
      results: state.records.map((r) => ({
        resourceName: r.resourceName,
        type: r.type,
        result: 'already_dismissed',
      })),
      validateOnlySupported: false,
      googleAdsRequestId: null,
      message: `All ${state.records.length} recommendation(s) were already dismissed.`,
    };
  },

  buildOperations(_ctx, _input, _state): MutateOperation[] {
    // Not used: dismissal goes through recommendations:dismiss, not googleAds:mutate.
    return [];
  },

  async execute(ctx, _operations, _input, state): Promise<ExecOutcome> {
    const operations = state.toDismiss.map((r) => ({ resourceName: r.resourceName }));
    const operationHash = sha256Hex(canonicalJson(operations));

    // DismissRecommendationRequest has no validateOnly field, so there is no
    // pre-validation pass to run here. The tool description says so explicitly.
    const result = await ctx.transport.dismissRecommendation(
      { customerId: ctx.customerId, operations, partialFailure: false },
      { label: 'dismiss_recommendation' },
    );

    return {
      responses: [],
      ...(result.meta.requestId !== undefined && { requestId: result.meta.requestId }),
      validateMeta: result.meta,
      executeMeta: result.meta,
      operationHash,
      validateOnlySupported: false,
    };
  },

  buildResult(ctx, _input, state, exec): Record<string, unknown> {
    const dismissed = new Set(state.toDismiss.map((r) => r.resourceName));
    return {
      success: true,
      changed: state.toDismiss.length > 0,
      customerId: ctx.customerId,
      resourceType: 'recommendation',
      dismissedCount: state.toDismiss.length,
      alreadyDismissedCount: state.records.length - state.toDismiss.length,
      results: state.records.map((r) => ({
        resourceName: r.resourceName,
        type: r.type,
        result: dismissed.has(r.resourceName) ? 'dismissed' : 'already_dismissed',
      })),
      before: { dismissedCount: state.records.length - state.toDismiss.length },
      after: { dismissedCount: state.records.length },
      validateOnlySupported: false,
      googleAdsRequestId: exec.requestId ?? null,
      message: `Dismissed ${state.toDismiss.length} recommendation(s).`,
    };
  },

  canonicalArguments(input): unknown {
    return {
      count: input.recommendationResourceNames.length,
      resourceNames: input.recommendationResourceNames,
    };
  },
};
