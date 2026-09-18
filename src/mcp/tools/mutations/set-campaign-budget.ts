import { z } from 'zod';
import {
  ResourceNotFoundError,
  StaleResourceStateError,
  ToolConstraintViolationError,
  UnsupportedResourceStateError,
} from '../../../errors/tool-errors.js';
import {
  fetchDistinctBudgets,
  budgetByIdQuery,
  campaignsForBudgetQuery,
  prospectiveTotal,
  type BudgetFacts,
} from '../../../google-ads/queries/budgets.js';
import { rn } from '../../../google-ads/resource-names.js';
import type { MutateOperation } from '../../../google-ads/types.js';
import { formatMicros, toBigIntMicros } from '../../../util/micros.js';
import { CustomerIdInput, MicrosInput, NumericIdInput } from '../shared/schemas.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATION_OUTPUT_SHAPE,
  type MutationDefinition,
} from './pipeline.js';

interface BudgetInput {
  customerId: string;
  budgetId: string;
  amountMicros: string;
  expectedCurrentAmountMicros?: string;
}

interface BudgetState {
  resourceName: string;
  budgetId: string;
  name: string;
  currentMicros: bigint;
  explicitlyShared: boolean;
  referenceCount: number;
  status: string;
  period: string;
  campaigns: { campaignId: string; name: string; status: string }[];
  byResourceName: Map<string, BudgetFacts>;
  currentTotalMicros: bigint;
  prospectiveTotalMicros: bigint;
  masterBudgetMicros: bigint;
  currencyCode?: string;
}

export const setCampaignBudget: MutationDefinition<'set_campaign_budget', BudgetInput, BudgetState> = {
  name: 'set_campaign_budget',
  title: 'Set a campaign budget amount',
  description:
    'CHANGES AN ADVERTISING BUDGET AND MAY AFFECT CHARGES. Sets the daily amount of a Google ' +
    'Ads campaign budget, changing how much the account can spend each day. Increases raise ' +
    "potential charges; decreases lower them. The budget is addressed directly by budget ID, " +
    'not through a campaign, so a budget shared by several campaigns cannot be changed by ' +
    'accident; explicitly shared budgets are rejected outright. The call is refused if the ' +
    "account's total across all distinct budgets would exceed the configured master budget. " +
    'Use get_budget_pacing first to see the current total and remaining headroom.',
  resourceType: 'campaign_budget',
  annotations: { title: 'Set campaign budget', ...DESTRUCTIVE_ANNOTATIONS },

  buildInputSchema: () => ({
    customerId: CustomerIdInput,
    budgetId: NumericIdInput.describe(
      'The campaign budget resource ID, from list_campaigns or get_budget_pacing. This is not ' +
        'a campaign ID.',
    ),
    amountMicros: MicrosInput.describe(
      'New daily budget in micros of the account currency. 50000000 is 50.00.',
    ),
    expectedCurrentAmountMicros: MicrosInput.optional().describe(
      'Optional optimistic concurrency check. If supplied and the budget no longer holds this ' +
        'amount, the call is rejected with STALE_RESOURCE_STATE.',
    ),
  }),

  outputSchema: {
    ...MUTATION_OUTPUT_SHAPE,
    resourceId: z.string(),
    resourceName: z.string(),
    before: z.record(z.string(), z.unknown()),
    after: z.record(z.string(), z.unknown()),
    referencingCampaigns: z.array(z.record(z.string(), z.unknown())),
    accountTotals: z.record(z.string(), z.unknown()),
    googleAdsRequestId: z.string().nullable().optional(),
    validatedOperationHash: z.string().optional(),
  },

  async fetchState(ctx, input): Promise<BudgetState> {
    const masterRaw = ctx.deps.config.budgets?.masterBudgetMicros;
    if (masterRaw === undefined) {
      // Startup validation prevents this; belt and braces.
      throw new ToolConstraintViolationError(
        'No master budget is configured, so budget changes cannot be authorized.',
        {},
      );
    }

    const page = await ctx.transport.search(
      { customerId: ctx.customerId, query: budgetByIdQuery(input.budgetId) },
      { label: 'budget_by_id' },
    );
    const b = page.results[0]?.campaignBudget as Record<string, any> | undefined;
    if (!b) throw new ResourceNotFoundError('campaign_budget', input.budgetId);

    const resourceName = String(b.resourceName ?? rn.campaignBudget(ctx.customerId, input.budgetId));

    const campaignsRes = await ctx.transport.searchPaginated(
      { customerId: ctx.customerId, query: campaignsForBudgetQuery(input.budgetId), maxRows: 1000 },
      { label: 'campaigns_for_budget' },
    );
    const campaigns = campaignsRes.rows.map((row) => {
      const c = (row.campaign ?? {}) as Record<string, unknown>;
      return {
        campaignId: String(c.id ?? ''),
        name: String(c.name ?? ''),
        status: String(c.status ?? ''),
      };
    });

    const totals = await fetchDistinctBudgets(
      ctx.transport,
      ctx.customerId,
      ctx.deps.config.reads.maxRowLimit,
    );

    let currencyCode: string | undefined;
    try {
      const cur = await ctx.transport.search(
        { customerId: ctx.customerId, query: 'SELECT customer.currency_code FROM customer LIMIT 1' },
        { label: 'currency' },
      );
      const code = (cur.results[0]?.customer as Record<string, unknown> | undefined)?.currencyCode;
      if (typeof code === 'string') currencyCode = code;
    } catch {
      currencyCode = undefined;
    }

    const requested = toBigIntMicros(input.amountMicros, 'amountMicros');

    return {
      resourceName,
      budgetId: input.budgetId,
      name: String(b.name ?? input.budgetId),
      currentMicros: toBigIntMicros(b.amountMicros, 'campaign_budget.amount_micros'),
      explicitlyShared: b.explicitlyShared === true,
      referenceCount: Number(b.referenceCount ?? 1),
      status: String(b.status ?? ''),
      period: String(b.period ?? ''),
      campaigns,
      byResourceName: totals.byResourceName,
      currentTotalMicros: totals.totalMicros,
      prospectiveTotalMicros: prospectiveTotal(totals.byResourceName, resourceName, requested),
      masterBudgetMicros: BigInt(masterRaw),
      ...(currencyCode !== undefined && { currencyCode }),
    };
  },

  checkConstraints(_ctx, input, state): void {
    const cur = state.currencyCode;

    if (state.status === 'REMOVED') {
      throw new UnsupportedResourceStateError(
        `Campaign budget "${state.name}" is REMOVED and cannot be changed.`,
        { resourceType: 'campaign_budget', resourceName: state.resourceName, state: state.status },
      );
    }

    // The invariant is a sum of daily amounts; a non-daily budget is not comparable.
    if (state.period !== '' && state.period !== 'DAILY') {
      throw new UnsupportedResourceStateError(
        `Campaign budget "${state.name}" has period ${state.period}. This server only manages ` +
          'DAILY budgets, because the master budget invariant is a daily total.',
        { resourceType: 'campaign_budget', resourceName: state.resourceName, period: state.period },
      );
    }

    // An explicitly shared budget backs several campaigns; changing it through one
    // of them would have effects this tool's contract cannot represent.
    if (state.explicitlyShared) {
      throw new UnsupportedResourceStateError(
        `Campaign budget "${state.name}" is an explicitly shared budget referenced by ` +
          `${state.referenceCount} campaign(s). This server does not mutate shared budgets.`,
        {
          resourceType: 'campaign_budget',
          budgetResourceName: state.resourceName,
          explicitlyShared: true,
          referenceCount: state.referenceCount,
          campaignIds: state.campaigns.map((c) => c.campaignId),
        },
      );
    }

    if (input.expectedCurrentAmountMicros !== undefined) {
      const expected = BigInt(input.expectedCurrentAmountMicros);
      if (expected !== state.currentMicros) {
        throw new StaleResourceStateError(
          'amountMicros',
          input.expectedCurrentAmountMicros,
          state.currentMicros.toString(),
          { resourceName: state.resourceName },
        );
      }
    }

    // The single budget-level constraint. Checked here, before any mutate call.
    if (state.prospectiveTotalMicros > state.masterBudgetMicros) {
      throw new ToolConstraintViolationError(
        `This change would raise the account's total daily budget to ` +
          `${formatMicros(state.prospectiveTotalMicros, cur)}, above the configured master budget ` +
          `of ${formatMicros(state.masterBudgetMicros, cur)}.`,
        {
          budgetResourceName: state.resourceName,
          budgetId: state.budgetId,
          currentAmountMicros: state.currentMicros.toString(),
          requestedAmountMicros: input.amountMicros,
          currentTotalMicros: state.currentTotalMicros.toString(),
          prospectiveTotalMicros: state.prospectiveTotalMicros.toString(),
          masterBudgetMicros: state.masterBudgetMicros.toString(),
          overageMicros: (state.prospectiveTotalMicros - state.masterBudgetMicros).toString(),
          distinctBudgetCount: state.byResourceName.size,
        },
      );
    }
  },

  detectNoOp(ctx, input, state): Record<string, unknown> | null {
    const requested = BigInt(input.amountMicros);
    if (requested !== state.currentMicros) return null;
    const cur = state.currencyCode;
    const snapshot = {
      amountMicros: state.currentMicros.toString(),
      name: state.name,
      explicitlyShared: state.explicitlyShared,
      referenceCount: state.referenceCount,
    };
    return {
      success: true,
      changed: false,
      customerId: ctx.customerId,
      resourceType: 'campaign_budget',
      resourceId: state.budgetId,
      resourceName: state.resourceName,
      before: snapshot,
      after: snapshot,
      referencingCampaigns: state.campaigns,
      accountTotals: {
        masterBudgetMicros: state.masterBudgetMicros.toString(),
        previousTotalMicros: state.currentTotalMicros.toString(),
        newTotalMicros: state.currentTotalMicros.toString(),
        headroomMicros: (state.masterBudgetMicros - state.currentTotalMicros).toString(),
        distinctBudgetCount: state.byResourceName.size,
      },
      googleAdsRequestId: null,
      message: `Budget "${state.name}" is already ${formatMicros(state.currentMicros, cur)}/day; nothing changed.`,
    };
  },

  buildOperations(_ctx, input, state): MutateOperation[] {
    return [
      {
        campaignBudgetOperation: {
          update: { resourceName: state.resourceName, amountMicros: input.amountMicros },
          updateMask: 'amountMicros',
        },
      },
    ];
  },

  buildResult(ctx, input, state, exec): Record<string, unknown> {
    const cur = state.currencyCode;
    const requested = BigInt(input.amountMicros);
    return {
      success: true,
      changed: true,
      customerId: ctx.customerId,
      resourceType: 'campaign_budget',
      resourceId: state.budgetId,
      resourceName: state.resourceName,
      before: {
        amountMicros: state.currentMicros.toString(),
        name: state.name,
        explicitlyShared: state.explicitlyShared,
        referenceCount: state.referenceCount,
      },
      after: {
        amountMicros: requested.toString(),
        name: state.name,
        explicitlyShared: state.explicitlyShared,
        referenceCount: state.referenceCount,
      },
      referencingCampaigns: state.campaigns,
      accountTotals: {
        masterBudgetMicros: state.masterBudgetMicros.toString(),
        previousTotalMicros: state.currentTotalMicros.toString(),
        newTotalMicros: state.prospectiveTotalMicros.toString(),
        headroomMicros: (state.masterBudgetMicros - state.prospectiveTotalMicros).toString(),
        distinctBudgetCount: state.byResourceName.size,
      },
      googleAdsRequestId: exec.requestId ?? null,
      validatedOperationHash: exec.operationHash,
      message:
        `Set budget "${state.name}" to ${formatMicros(requested, cur)}/day (was ` +
        `${formatMicros(state.currentMicros, cur)}). Account total is now ` +
        `${formatMicros(state.prospectiveTotalMicros, cur)}/day of a ` +
        `${formatMicros(state.masterBudgetMicros, cur)} master budget.`,
    };
  },

  canonicalArguments(input): unknown {
    return {
      budgetId: input.budgetId,
      amountMicros: input.amountMicros,
      expectedCurrentAmountMicros: input.expectedCurrentAmountMicros ?? null,
    };
  },
};
