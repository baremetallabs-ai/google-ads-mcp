import type { GoogleAdsRow, GoogleAdsTransport } from '../types.js';
import { toBigIntMicros } from '../../util/micros.js';

export interface BudgetFacts {
  resourceName: string;
  budgetId: string;
  name?: string;
  amountMicros: bigint;
  explicitlyShared: boolean;
  referenceCount: number;
  status?: string;
  period?: string;
  deliveryMethod?: string;
  campaignIds: string[];
}

/**
 * Every distinct campaign budget referenced by a non-removed campaign.
 *
 * Selected FROM campaign rather than FROM campaign_budget on purpose: the invariant
 * is defined over budgets *referenced by* non-removed campaigns, so the join
 * direction is what decides which budgets are in the set. A budget referenced by five
 * campaigns produces five rows and must be counted once.
 *
 * Campaign status is not filtered beyond REMOVED, so pausing or enabling a campaign
 * never changes the total - which is why pause_campaign needs no budget logic.
 */
export const DISTINCT_BUDGETS_QUERY = `
SELECT
  campaign.id,
  campaign.name,
  campaign.status,
  campaign_budget.id,
  campaign_budget.resource_name,
  campaign_budget.name,
  campaign_budget.amount_micros,
  campaign_budget.explicitly_shared,
  campaign_budget.reference_count,
  campaign_budget.status,
  campaign_budget.period,
  campaign_budget.delivery_method
FROM campaign
WHERE campaign.status != 'REMOVED'
`.trim();

export interface DistinctBudgetTotals {
  byResourceName: Map<string, BudgetFacts>;
  totalMicros: bigint;
  referencingCampaignCount: number;
}

/** Fold GAQL rows into distinct budget resources, counting each exactly once. */
export function sumDistinctBudgets(rows: readonly GoogleAdsRow[]): DistinctBudgetTotals {
  const byResourceName = new Map<string, BudgetFacts>();
  let referencingCampaignCount = 0;

  for (const row of rows) {
    const budget = row.campaignBudget as Record<string, unknown> | undefined;
    const campaign = row.campaign as Record<string, unknown> | undefined;
    const resourceName = budget?.resourceName as string | undefined;
    if (!budget || !resourceName) continue;

    referencingCampaignCount += 1;
    const campaignId = campaign?.id === undefined ? undefined : String(campaign.id);

    const existing = byResourceName.get(resourceName);
    if (existing) {
      if (campaignId) existing.campaignIds.push(campaignId);
      continue;
    }

    byResourceName.set(resourceName, {
      resourceName,
      budgetId: String(budget.id ?? ''),
      ...(budget.name !== undefined && { name: String(budget.name) }),
      amountMicros: toBigIntMicros(budget.amountMicros, 'campaign_budget.amount_micros'),
      explicitlyShared: budget.explicitlyShared === true,
      referenceCount: Number(budget.referenceCount ?? 1),
      ...(budget.status !== undefined && { status: String(budget.status) }),
      ...(budget.period !== undefined && { period: String(budget.period) }),
      ...(budget.deliveryMethod !== undefined && { deliveryMethod: String(budget.deliveryMethod) }),
      campaignIds: campaignId ? [campaignId] : [],
    });
  }

  let totalMicros = 0n;
  for (const facts of byResourceName.values()) totalMicros += facts.amountMicros;

  return { byResourceName, totalMicros, referencingCampaignCount };
}

/**
 * The account total that would result from setting one budget to a new amount.
 *
 * If the target budget is not in the referenced set - it exists but no non-removed
 * campaign points at it - its requested amount is still added. Leaving it out would
 * mean any amount at all passed the ceiling check for an orphaned budget.
 */
export function prospectiveTotal(
  byResourceName: ReadonlyMap<string, BudgetFacts>,
  targetResourceName: string,
  requestedMicros: bigint,
): bigint {
  let total = 0n;
  let sawTarget = false;
  for (const [resourceName, facts] of byResourceName) {
    if (resourceName === targetResourceName) {
      total += requestedMicros;
      sawTarget = true;
    } else {
      total += facts.amountMicros;
    }
  }
  if (!sawTarget) total += requestedMicros;
  return total;
}

/** Fetch and fold the distinct-budget set for an account. */
export async function fetchDistinctBudgets(
  transport: GoogleAdsTransport,
  customerId: string,
  maxRows: number,
): Promise<DistinctBudgetTotals> {
  const { rows } = await transport.searchPaginated(
    { customerId, query: DISTINCT_BUDGETS_QUERY, maxRows },
    { label: 'distinct_budgets' },
  );
  return sumDistinctBudgets(rows);
}

/** Fetch one budget resource by ID. */
export const budgetByIdQuery = (budgetId: string): string =>
  `
SELECT
  campaign_budget.id,
  campaign_budget.resource_name,
  campaign_budget.name,
  campaign_budget.amount_micros,
  campaign_budget.explicitly_shared,
  campaign_budget.reference_count,
  campaign_budget.status,
  campaign_budget.period,
  campaign_budget.delivery_method,
  campaign_budget.type
FROM campaign_budget
WHERE campaign_budget.id = ${budgetId}
LIMIT 1
`.trim();

/** Campaigns referencing a given budget. */
export const campaignsForBudgetQuery = (budgetId: string): string =>
  `
SELECT campaign.id, campaign.name, campaign.status, campaign_budget.id
FROM campaign
WHERE campaign_budget.id = ${budgetId} AND campaign.status != 'REMOVED'
`.trim();
