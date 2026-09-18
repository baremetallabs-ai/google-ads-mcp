import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Regression guards for GAQL field names that were wrong against the live API.
 *
 * Both of these typecheck and pass every mocked test, because a mock happily returns
 * whatever it is told to. Only a real Google Ads call rejects them, so they are
 * pinned here.
 */
const campaigns = readFileSync('src/mcp/tools/read/campaigns.ts', 'utf8');
const insights = readFileSync('src/mcp/tools/read/insights.ts', 'utf8');

describe('GAQL field names verified against the live API', () => {
  it('uses campaign.start_date_time, not the removed campaign.start_date', () => {
    expect(campaigns).toContain('campaign.start_date_time');
    expect(campaigns).toContain('campaign.end_date_time');
    expect(campaigns).not.toMatch(/campaign\.start_date[^_]/);
    expect(campaigns).not.toMatch(/campaign\.end_date[^_]/);
  });

  it('selects recommendation.impact whole, since its nested paths are not selectable', () => {
    expect(insights).toContain('recommendation.impact');
    expect(insights).not.toContain('recommendation.impact.base_metrics');
    expect(insights).not.toContain('recommendation.impact.potential_metrics');
  });
});
