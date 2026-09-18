import { describe, it, expect } from 'vitest';
import {
  sumDistinctBudgets,
  prospectiveTotal,
} from '../../../src/google-ads/queries/budgets.js';

const CID = '1234567890';
const budgetRn = (id: string) => `customers/${CID}/campaignBudgets/${id}`;

function row(campaignId: string, budgetId: string, amountMicros: string, extra = {}) {
  return {
    campaign: { id: campaignId, name: `Campaign ${campaignId}`, status: 'ENABLED' },
    campaignBudget: {
      id: budgetId,
      resourceName: budgetRn(budgetId),
      name: `Budget ${budgetId}`,
      amountMicros,
      explicitlyShared: false,
      referenceCount: 1,
      ...extra,
    },
  };
}

describe('distinct budget totals', () => {
  it('sums one budget per campaign', () => {
    const { totalMicros, byResourceName } = sumDistinctBudgets([
      row('1', '100', '30000000'),
      row('2', '200', '20000000'),
    ]);
    expect(byResourceName.size).toBe(2);
    expect(totalMicros).toBe(50_000_000n);
  });

  it('counts a shared budget exactly once across its campaigns', () => {
    // Three campaigns, but only two distinct budget resources. A naive per-campaign
    // sum would report 110.00 instead of 50.00.
    const { totalMicros, byResourceName } = sumDistinctBudgets([
      row('1', '100', '30000000', { explicitlyShared: true, referenceCount: 3 }),
      row('2', '100', '30000000', { explicitlyShared: true, referenceCount: 3 }),
      row('3', '100', '30000000', { explicitlyShared: true, referenceCount: 3 }),
      row('4', '200', '20000000'),
    ]);
    expect(byResourceName.size).toBe(2);
    expect(totalMicros).toBe(50_000_000n);
    expect(byResourceName.get(budgetRn('100'))?.campaignIds).toEqual(['1', '2', '3']);
  });

  it('records every referencing campaign against its budget', () => {
    const { referencingCampaignCount } = sumDistinctBudgets([
      row('1', '100', '30000000'),
      row('2', '100', '30000000'),
    ]);
    expect(referencingCampaignCount).toBe(2);
  });

  it('ignores rows with no budget join', () => {
    const { totalMicros, byResourceName } = sumDistinctBudgets([
      row('1', '100', '30000000'),
      { campaign: { id: '2', status: 'ENABLED' } },
    ]);
    expect(byResourceName.size).toBe(1);
    expect(totalMicros).toBe(30_000_000n);
  });

  it('sums paused campaigns too, so pausing never changes the total', () => {
    const enabled = sumDistinctBudgets([row('1', '100', '30000000')]);
    const paused = sumDistinctBudgets([
      { ...row('1', '100', '30000000'), campaign: { id: '1', status: 'PAUSED' } },
    ]);
    expect(paused.totalMicros).toBe(enabled.totalMicros);
  });

  it('handles int64 amounts beyond Number precision', () => {
    const { totalMicros } = sumDistinctBudgets([
      row('1', '100', '9007199254740993'),
      row('2', '200', '1'),
    ]);
    expect(totalMicros).toBe(9_007_199_254_740_994n);
  });
});

describe('prospective total', () => {
  const budgets = sumDistinctBudgets([
    row('1', '100', '30000000'),
    row('2', '200', '20000000'),
  ]).byResourceName;

  it('swaps the target budget amount and keeps the others', () => {
    expect(prospectiveTotal(budgets, budgetRn('100'), 50_000_000n)).toBe(70_000_000n);
  });

  it('reflects a decrease', () => {
    expect(prospectiveTotal(budgets, budgetRn('100'), 10_000_000n)).toBe(30_000_000n);
  });

  it('is unchanged when the requested amount equals the current one', () => {
    expect(prospectiveTotal(budgets, budgetRn('100'), 30_000_000n)).toBe(50_000_000n);
  });

  it('still counts a budget no live campaign references', () => {
    // Otherwise an orphaned budget could be set to any amount at all and pass the
    // ceiling check, because replacing an absent entry is a no-op.
    expect(prospectiveTotal(budgets, budgetRn('999'), 40_000_000n)).toBe(90_000_000n);
  });

  it('handles an empty account', () => {
    expect(prospectiveTotal(new Map(), budgetRn('100'), 25_000_000n)).toBe(25_000_000n);
  });
});
