import { z } from 'zod';
import { fetchDistinctBudgets } from '../../../google-ads/queries/budgets.js';
import { formatMicros, toBigIntMicros } from '../../../util/micros.js';
import { dateRangeShape, resolveDateRange } from '../shared/date-range.js';
import { CustomerIdInput } from '../shared/schemas.js';
import type { Deps, ReadToolDefinition } from '../../../types/index.js';

export const getBudgetPacing: ReadToolDefinition = {
  name: 'get_budget_pacing',
  title: 'Get budget pacing and master-budget headroom',
  description:
    "Reports every distinct campaign budget resource in the account, the account's current " +
    'total across those distinct budgets, the configured master budget, and the remaining ' +
    'headroom. Use this to plan a set_campaign_budget call without having to attempt one and ' +
    'be rejected. Each budget also reports whether this server is able to mutate it.',
  inputSchema: {
    customerId: CustomerIdInput,
    ...dateRangeShape,
    includeSpend: z.boolean().default(true).describe('Include period-to-date spend per budget.'),
  },
  outputSchema: {
    customerId: z.string(),
    currencyCode: z.string().nullable(),
    masterBudgetMicros: z.string().nullable(),
    currentTotalMicros: z.string(),
    headroomMicros: z.string().nullable(),
    overMaster: z.boolean(),
    distinctBudgetCount: z.number(),
    referencingCampaignCount: z.number(),
    budgets: z.array(z.record(z.string(), z.unknown())),
    message: z.string(),
  },
  async handler(deps: Deps, input): Promise<Record<string, unknown>> {
    const customerId = input.customerId as string;
    const totals = await fetchDistinctBudgets(
      deps.transport,
      customerId,
      deps.config.reads.maxRowLimit,
    );

    // Spend is aggregated per budget in TypeScript: GAQL has no GROUP BY.
    const spendByBudgetId = new Map<string, bigint>();
    if (input.includeSpend !== false) {
      const range = resolveDateRange(input, 'THIS_MONTH');
      try {
        const res = await deps.transport.searchPaginated(
          {
            customerId,
            query: `SELECT campaign.id, campaign_budget.id, metrics.cost_micros FROM campaign WHERE ${range.clause} AND campaign.status != 'REMOVED'`,
            maxRows: deps.config.reads.maxRowLimit,
          },
          { label: 'budget_spend' },
        );
        for (const row of res.rows) {
          const budgetId = String((row.campaignBudget as Record<string, unknown> | undefined)?.id ?? '');
          if (!budgetId) continue;
          const cost = toBigIntMicros(
            (row.metrics as Record<string, unknown> | undefined)?.costMicros ?? '0',
            'metrics.cost_micros',
          );
          spendByBudgetId.set(budgetId, (spendByBudgetId.get(budgetId) ?? 0n) + cost);
        }
      } catch {
        // Spend is supplementary; the invariant figures matter more.
      }
    }

    let currencyCode: string | null = null;
    try {
      const page = await deps.transport.search(
        { customerId, query: 'SELECT customer.currency_code FROM customer LIMIT 1' },
        { label: 'currency' },
      );
      currencyCode =
        ((page.results[0]?.customer as Record<string, unknown> | undefined)?.currencyCode as string) ??
        null;
    } catch {
      // Currency is cosmetic; the invariant figures matter more.
    }

    const masterRaw = deps.config.budgets?.masterBudgetMicros;
    const master = masterRaw === undefined ? undefined : BigInt(masterRaw);
    const currentTotal = totals.totalMicros;
    const headroom = master === undefined ? undefined : master - currentTotal;

    const budgets = [...totals.byResourceName.values()].map((f) => ({
      budgetId: f.budgetId,
      resourceName: f.resourceName,
      name: f.name ?? null,
      amountMicros: f.amountMicros.toString(),
      explicitlyShared: f.explicitlyShared,
      referenceCount: f.referenceCount,
      status: f.status ?? null,
      period: f.period ?? null,
      deliveryMethod: f.deliveryMethod ?? null,
      campaignIds: f.campaignIds,
      campaignCount: f.campaignIds.length,
      // An explicitly shared budget is rejected by set_campaign_budget. Surfacing it
      // here means a client learns this without a failed mutation attempt.
      mutableByThisServer: !f.explicitlyShared,
      periodSpendMicros: (spendByBudgetId.get(f.budgetId) ?? 0n).toString(),
    }));

    const cur = currencyCode ?? undefined;
    const message =
      master === undefined
        ? `${budgets.length} distinct budget(s) totalling ${formatMicros(currentTotal, cur)}/day. No master budget is configured.`
        : `${budgets.length} distinct budget(s) total ${formatMicros(currentTotal, cur)}/day against a ${formatMicros(master, cur)} master budget; ${formatMicros(headroom ?? 0n, cur)} headroom.`;

    return {
      customerId,
      currencyCode,
      masterBudgetMicros: masterRaw ?? null,
      currentTotalMicros: currentTotal.toString(),
      headroomMicros: headroom === undefined ? null : headroom.toString(),
      overMaster: master !== undefined && currentTotal > master,
      distinctBudgetCount: budgets.length,
      referencingCampaignCount: totals.referencingCampaignCount,
      budgets,
      message,
    };
  },
};
