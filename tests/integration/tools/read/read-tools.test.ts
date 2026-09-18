import { describe, it, expect, afterEach } from 'vitest';
import { GoogleAdsMock } from '../../../helpers/mock-google-ads.js';
import {
  buildTestServer,
  callTool,
  TEST_CUSTOMER_ID,
  type TestHarness,
} from '../../../helpers/build-test-server.js';

let harness: TestHarness | undefined;
let mock: GoogleAdsMock | undefined;

afterEach(async () => {
  await harness?.close();
  await mock?.close();
  harness = undefined;
  mock = undefined;
});

describe('get_budget_pacing', () => {
  const budgetJoin = (campaignId: string, budgetId: string, amountMicros: string, extra = {}) => ({
    campaign: { id: campaignId, name: `C${campaignId}`, status: 'ENABLED' },
    campaignBudget: {
      id: budgetId,
      resourceName: `customers/${TEST_CUSTOMER_ID}/campaignBudgets/${budgetId}`,
      name: `Budget ${budgetId}`,
      amountMicros,
      explicitlyShared: false,
      referenceCount: 1,
      status: 'ENABLED',
      period: 'DAILY',
      ...extra,
    },
  });

  it('reports the distinct-budget total, master budget and headroom', async () => {
    mock = new GoogleAdsMock();
    // distinct budgets, then spend, then currency
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [budgetJoin('1', '100', '30000000'), budgetJoin('2', '200', '20000000')],
    });
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [
        { campaign: { id: '1' }, campaignBudget: { id: '100' }, metrics: { costMicros: '15000000' } },
      ],
    });
    mock.onSearch(TEST_CUSTOMER_ID, { results: [{ customer: { currencyCode: 'USD' } }] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'get_budget_pacing', {
      customerId: TEST_CUSTOMER_ID,
    });

    expect(result.isError).toBe(false);
    expect(result.structured).toMatchObject({
      masterBudgetMicros: '500000000',
      currentTotalMicros: '50000000',
      headroomMicros: '450000000',
      overMaster: false,
      distinctBudgetCount: 2,
      currencyCode: 'USD',
    });
    // A client can compute headroom without attempting a mutation.
    expect(result.text).toContain('$450.00 headroom');
  });

  it('counts a shared budget once and flags it as not mutable here', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [
        budgetJoin('1', '100', '30000000', { explicitlyShared: true, referenceCount: 2 }),
        budgetJoin('2', '100', '30000000', { explicitlyShared: true, referenceCount: 2 }),
      ],
    });
    mock.onSearch(TEST_CUSTOMER_ID, { results: [] });
    mock.onSearch(TEST_CUSTOMER_ID, { results: [{ customer: { currencyCode: 'USD' } }] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'get_budget_pacing', {
      customerId: TEST_CUSTOMER_ID,
    });

    expect(result.structured.distinctBudgetCount).toBe(1);
    expect(result.structured.currentTotalMicros).toBe('30000000');
    expect(result.structured.budgets[0]).toMatchObject({
      explicitlyShared: true,
      mutableByThisServer: false,
      campaignCount: 2,
    });
  });

  it('reports being over the master budget rather than hiding it', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [budgetJoin('1', '100', '600000000')] });
    mock.onSearch(TEST_CUSTOMER_ID, { results: [] });
    mock.onSearch(TEST_CUSTOMER_ID, { results: [{ customer: { currencyCode: 'USD' } }] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'get_budget_pacing', {
      customerId: TEST_CUSTOMER_ID,
    });
    expect(result.structured.overMaster).toBe(true);
    expect(result.structured.headroomMicros).toBe('-100000000');
  });
});

describe('search_google_ads', () => {
  it('runs a permitted SELECT and applies a row limit', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(
      TEST_CUSTOMER_ID,
      { results: [{ campaign: { id: '1' } }], fieldMask: 'campaign.id', totalResultsCount: '1' },
      { requestId: 'req-gaql' },
    );
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'search_google_ads', {
      customerId: TEST_CUSTOMER_ID,
      query: 'SELECT campaign.id FROM campaign',
    });

    expect(result.isError).toBe(false);
    expect(result.structured.appliedQuery).toBe('SELECT campaign.id FROM campaign LIMIT 1000');
    expect(result.structured.resource).toBe('campaign');
    expect(result.structured.googleAdsRequestId).toBe('req-gaql');
    expect(result.structured.rowCount).toBe(1);
  });

  it('rejects non-SELECT statements before any request', async () => {
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    for (const query of [
      'DELETE FROM campaign WHERE campaign.id = 1',
      'SELECT campaign.id FROM campaign; DROP TABLE campaign',
      'SELECT campaign.id FROM campaign -- sneaky',
    ]) {
      const result = await callTool(harness.client, 'search_google_ads', {
        customerId: TEST_CUSTOMER_ID,
        query,
      });
      expect(result.structured.error?.code, query).toBe('INVALID_ARGUMENT');
    }
    expect(mock.requests).toHaveLength(0);
  });

  it('blocks billing and user-access resources', async () => {
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'search_google_ads', {
      customerId: TEST_CUSTOMER_ID,
      query: 'SELECT customer_user_access.email_address FROM customer_user_access',
    });
    expect(result.structured.error.code).toBe('INVALID_ARGUMENT');
    expect(mock.requests).toHaveLength(0);
  });

  it('takes the account from the argument, not the query', async () => {
    // GAQL has no customer clause, so authorization is structural. An unauthorized
    // customerId must be refused regardless of what the query says.
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'search_google_ads', {
      customerId: '9999999999',
      query: 'SELECT campaign.id FROM campaign',
    });
    expect(result.structured.error.code).toBe('UNAUTHORIZED_CUSTOMER');
    expect(mock.requests).toHaveLength(0);
  });
});

describe('reporting tools', () => {
  it('returns campaign performance with micros as strings', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [
        {
          campaign: { id: '1', name: 'Search', status: 'ENABLED' },
          metrics: {
            impressions: '1000',
            clicks: '50',
            costMicros: '39000000',
            ctr: 0.05,
            averageCpc: '780000',
            conversions: 2,
          },
        },
      ],
    });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'get_campaign_performance', {
      customerId: TEST_CUSTOMER_ID,
      datePreset: 'LAST_7_DAYS',
    });

    expect(result.isError).toBe(false);
    expect(result.structured.rows[0].metrics.costMicros).toBe('39000000');
    expect(typeof result.structured.rows[0].metrics.costMicros).toBe('string');
    expect(result.structured.totals.costMicros).toBe('39000000');
    expect(result.structured.totals.clicks).toBe('50');
  });

  it('rejects supplying both a preset and an explicit range', async () => {
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'get_campaign_performance', {
      customerId: TEST_CUSTOMER_ID,
      datePreset: 'LAST_7_DAYS',
      startDate: '2026-08-01',
      endDate: '2026-08-07',
    });
    expect(result.structured.error.code).toBe('INVALID_ARGUMENT');
    expect(mock.requests).toHaveLength(0);
  });

  it('paginates with a page token', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [{ campaign: { id: '1', name: 'A', status: 'ENABLED' } }],
      nextPageToken: 'page-2',
    });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'list_campaigns', {
      customerId: TEST_CUSTOMER_ID,
    });
    expect(result.structured.nextPageToken).toBe('page-2');
  });

  it('surfaces the budget each campaign references', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [
        {
          campaign: { id: '1', name: 'A', status: 'ENABLED', campaignBudget: `customers/${TEST_CUSTOMER_ID}/campaignBudgets/100` },
          campaignBudget: { id: '100', amountMicros: '30000000', explicitlyShared: false },
        },
      ],
    });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'list_campaigns', {
      customerId: TEST_CUSTOMER_ID,
    });
    // set_campaign_budget addresses the budget directly, so listing must expose its ID.
    expect(result.structured.campaigns[0].budget).toMatchObject({
      budgetId: '100',
      amountMicros: '30000000',
      explicitlyShared: false,
    });
  });
});

describe('get_change_history', () => {
  it('refuses a window beyond Google Ads retention', async () => {
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'get_change_history', {
      customerId: TEST_CUSTOMER_ID,
      startDate: '2020-01-01',
      endDate: '2020-02-01',
    });
    expect(result.structured.error.code).toBe('INVALID_ARGUMENT');
    expect(mock.requests).toHaveLength(0);
  });

  it('always sends an explicit LIMIT, which change_event requires', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    await callTool(harness.client, 'get_change_history', { customerId: TEST_CUSTOMER_ID });
    const body = mock.requests[0]?.body as { query: string };
    expect(body.query).toMatch(/LIMIT \d+/);
    expect(body.query).toContain('change_event.change_date_time >=');
  });
});

describe('list_accessible_accounts', () => {
  it('says plainly when no allowlisted account can be queried', async () => {
    // A cheerful "2 accounts" summary while every query fails sends an operator
    // hunting in the wrong place. Zero queryable means the credentials are wrong.
    mock = new GoogleAdsMock();
    mock.onListAccessibleCustomers([]);
    mock.onSearchError(TEST_CUSTOMER_ID, 401, { error: { code: 401, status: 'UNAUTHENTICATED' } }, { times: 2 });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'list_accessible_accounts', {});
    expect(result.structured.queryableCount).toBe(0);
    expect(result.structured.message).toContain('NONE could be queried');
    expect(result.structured.accounts[0].queryable).toBe(false);
  });
});
