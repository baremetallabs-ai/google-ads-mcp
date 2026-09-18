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

const budgetRn = (id: string) => `customers/${TEST_CUSTOMER_ID}/campaignBudgets/${id}`;

const budgetRow = (id: string, amountMicros: string, extra: Record<string, unknown> = {}) => ({
  campaignBudget: {
    id,
    resourceName: budgetRn(id),
    name: `Budget ${id}`,
    amountMicros,
    explicitlyShared: false,
    referenceCount: 1,
    status: 'ENABLED',
    period: 'DAILY',
    deliveryMethod: 'STANDARD',
    ...extra,
  },
});

const campaignBudgetRow = (
  campaignId: string,
  budgetId: string,
  amountMicros: string,
  extra: Record<string, unknown> = {},
) => ({
  campaign: { id: campaignId, name: `Campaign ${campaignId}`, status: 'ENABLED' },
  ...budgetRow(budgetId, amountMicros, extra),
});

/**
 * The tool issues, in order: budget-by-id, campaigns-for-budget, distinct-budgets,
 * currency.
 */
function setupBudget(options: {
  budget: ReturnType<typeof budgetRow>;
  campaigns: unknown[];
  account: unknown[];
  mutates?: number;
}) {
  mock = new GoogleAdsMock();
  mock.onSearch(TEST_CUSTOMER_ID, { results: [options.budget] });
  mock.onSearch(TEST_CUSTOMER_ID, { results: options.campaigns });
  mock.onSearch(TEST_CUSTOMER_ID, { results: options.account });
  mock.onSearch(TEST_CUSTOMER_ID, { results: [{ customer: { currencyCode: 'USD' } }] });
  if (options.mutates) {
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { times: options.mutates });
  }
  return mock;
}

describe('set_campaign_budget within the master budget', () => {
  it('changes the amount and reports account totals', async () => {
    // Master budget is $500. Current total is $50; raising budget 100 to $250 -> $270.
    setupBudget({
      budget: budgetRow('100', '30000000'),
      campaigns: [{ campaign: { id: '1', name: 'Campaign 1', status: 'ENABLED' } }],
      account: [
        campaignBudgetRow('1', '100', '30000000'),
        campaignBudgetRow('2', '200', '20000000'),
      ],
      mutates: 2,
    });
    harness = await buildTestServer({ fetchImpl: mock!.fetchImpl });

    const result = await callTool(harness.client, 'set_campaign_budget', {
      customerId: TEST_CUSTOMER_ID,
      budgetId: '100',
      amountMicros: '250000000',
    });

    expect(result.isError).toBe(false);
    expect(result.structured).toMatchObject({
      success: true,
      changed: true,
      resourceType: 'campaign_budget',
      resourceId: '100',
      before: { amountMicros: '30000000' },
      after: { amountMicros: '250000000' },
    });
    expect(result.structured.accountTotals).toMatchObject({
      masterBudgetMicros: '500000000',
      previousTotalMicros: '50000000',
      newTotalMicros: '270000000',
      headroomMicros: '230000000',
      distinctBudgetCount: 2,
    });
    expect(result.text).toContain('$250.00');
  });

  it('sends an amountMicros update mask on the budget resource', async () => {
    const m = setupBudget({
      budget: budgetRow('100', '30000000'),
      campaigns: [],
      account: [campaignBudgetRow('1', '100', '30000000')],
      mutates: 2,
    });
    harness = await buildTestServer({ fetchImpl: m.fetchImpl });

    await callTool(harness.client, 'set_campaign_budget', {
      customerId: TEST_CUSTOMER_ID,
      budgetId: '100',
      amountMicros: '40000000',
    });

    const body = m.mutateRequests()[0]?.body as { mutateOperations: unknown[] };
    expect(body.mutateOperations).toEqual([
      {
        campaignBudgetOperation: {
          update: { resourceName: budgetRn('100'), amountMicros: '40000000' },
          updateMask: 'amountMicros',
        },
      },
    ]);
  });

  it('permits a decrease', async () => {
    setupBudget({
      budget: budgetRow('100', '30000000'),
      campaigns: [],
      account: [campaignBudgetRow('1', '100', '30000000')],
      mutates: 2,
    });
    harness = await buildTestServer({ fetchImpl: mock!.fetchImpl });

    const result = await callTool(harness.client, 'set_campaign_budget', {
      customerId: TEST_CUSTOMER_ID,
      budgetId: '100',
      amountMicros: '10000000',
    });
    expect(result.structured.changed).toBe(true);
    expect(result.structured.after.amountMicros).toBe('10000000');
  });
});

describe('master budget invariant', () => {
  it('rejects a change that would exceed the ceiling, before any Google Ads mutate', async () => {
    // Scenario 4.
    const m = setupBudget({
      budget: budgetRow('100', '30000000'),
      campaigns: [{ campaign: { id: '1', name: 'Campaign 1', status: 'ENABLED' } }],
      account: [
        campaignBudgetRow('1', '100', '30000000'),
        campaignBudgetRow('2', '200', '20000000'),
      ],
    });
    harness = await buildTestServer({ fetchImpl: m.fetchImpl });

    const result = await callTool(harness.client, 'set_campaign_budget', {
      customerId: TEST_CUSTOMER_ID,
      budgetId: '100',
      amountMicros: '600000000',
    });

    expect(result.isError).toBe(true);
    expect(result.structured.error.code).toBe('TOOL_CONSTRAINT_VIOLATION');
    // The details must let a client compute what would fit without guessing.
    expect(result.structured.error.details).toMatchObject({
      currentTotalMicros: '50000000',
      prospectiveTotalMicros: '620000000',
      masterBudgetMicros: '500000000',
      overageMicros: '120000000',
    });
    expect(m.mutateRequests()).toHaveLength(0);
  });

  it('counts a shared budget once when computing the total', async () => {
    // Budget 100 backs three campaigns. Counted per-campaign the total would be
    // $110 and this call would be rejected; counted per distinct resource it is $50.
    setupBudget({
      budget: budgetRow('100', '30000000'),
      campaigns: [],
      account: [
        campaignBudgetRow('1', '100', '30000000'),
        campaignBudgetRow('2', '100', '30000000'),
        campaignBudgetRow('3', '100', '30000000'),
        campaignBudgetRow('4', '200', '20000000'),
      ],
      mutates: 2,
    });
    harness = await buildTestServer({ fetchImpl: mock!.fetchImpl });

    const result = await callTool(harness.client, 'set_campaign_budget', {
      customerId: TEST_CUSTOMER_ID,
      budgetId: '100',
      amountMicros: '400000000',
    });

    expect(result.isError).toBe(false);
    expect(result.structured.accountTotals).toMatchObject({
      previousTotalMicros: '50000000',
      newTotalMicros: '420000000',
      distinctBudgetCount: 2,
    });
  });

  it('allows a change that lands exactly on the ceiling', async () => {
    setupBudget({
      budget: budgetRow('100', '30000000'),
      campaigns: [],
      account: [campaignBudgetRow('1', '100', '30000000')],
      mutates: 2,
    });
    harness = await buildTestServer({ fetchImpl: mock!.fetchImpl });

    const result = await callTool(harness.client, 'set_campaign_budget', {
      customerId: TEST_CUSTOMER_ID,
      budgetId: '100',
      amountMicros: '500000000',
    });
    expect(result.isError).toBe(false);
    expect(result.structured.accountTotals.headroomMicros).toBe('0');
  });
});

describe('shared budgets', () => {
  it('refuses to mutate an explicitly shared budget', async () => {
    const m = setupBudget({
      budget: budgetRow('100', '30000000', { explicitlyShared: true, referenceCount: 3 }),
      campaigns: [
        { campaign: { id: '1', name: 'A', status: 'ENABLED' } },
        { campaign: { id: '2', name: 'B', status: 'ENABLED' } },
      ],
      account: [campaignBudgetRow('1', '100', '30000000')],
    });
    harness = await buildTestServer({ fetchImpl: m.fetchImpl });

    const result = await callTool(harness.client, 'set_campaign_budget', {
      customerId: TEST_CUSTOMER_ID,
      budgetId: '100',
      amountMicros: '40000000',
    });

    expect(result.isError).toBe(true);
    expect(result.structured.error.code).toBe('UNSUPPORTED_RESOURCE_STATE');
    expect(result.structured.error.details).toMatchObject({
      explicitlyShared: true,
      referenceCount: 3,
    });
    expect(m.mutateRequests()).toHaveLength(0);
  });

  it('refuses a non-daily budget, which the daily invariant cannot represent', async () => {
    const m = setupBudget({
      budget: budgetRow('100', '30000000', { period: 'CUSTOM_PERIOD' }),
      campaigns: [],
      account: [campaignBudgetRow('1', '100', '30000000')],
    });
    harness = await buildTestServer({ fetchImpl: m.fetchImpl });

    const result = await callTool(harness.client, 'set_campaign_budget', {
      customerId: TEST_CUSTOMER_ID,
      budgetId: '100',
      amountMicros: '40000000',
    });
    expect(result.structured.error.code).toBe('UNSUPPORTED_RESOURCE_STATE');
    expect(m.mutateRequests()).toHaveLength(0);
  });
});

describe('budget idempotency and staleness', () => {
  it('returns a no-op when the amount is unchanged', async () => {
    const m = setupBudget({
      budget: budgetRow('100', '30000000'),
      campaigns: [],
      account: [campaignBudgetRow('1', '100', '30000000')],
    });
    harness = await buildTestServer({ fetchImpl: m.fetchImpl });

    const result = await callTool(harness.client, 'set_campaign_budget', {
      customerId: TEST_CUSTOMER_ID,
      budgetId: '100',
      amountMicros: '30000000',
    });

    expect(result.isError).toBe(false);
    expect(result.structured.changed).toBe(false);
    expect(result.structured.before).toEqual(result.structured.after);
    expect(m.mutateRequests()).toHaveLength(0);
  });

  it('rejects a stale expected amount', async () => {
    const m = setupBudget({
      budget: budgetRow('100', '30000000'),
      campaigns: [],
      account: [campaignBudgetRow('1', '100', '30000000')],
    });
    harness = await buildTestServer({ fetchImpl: m.fetchImpl });

    const result = await callTool(harness.client, 'set_campaign_budget', {
      customerId: TEST_CUSTOMER_ID,
      budgetId: '100',
      amountMicros: '40000000',
      expectedCurrentAmountMicros: '20000000',
    });

    expect(result.isError).toBe(true);
    expect(result.structured.error.code).toBe('STALE_RESOURCE_STATE');
    expect(result.structured.error.details).toMatchObject({
      field: 'amountMicros',
      expected: '20000000',
      actual: '30000000',
    });
    expect(m.mutateRequests()).toHaveLength(0);
  });
});

describe('budget capability gating', () => {
  it('is absent from tools/list when no master budget is configured', async () => {
    harness = await buildTestServer({
      config: {
        budgets: undefined,
        mutations: {
          enabled: true,
          default: 'deny',
          tools: { pause_campaign: { enabled: true, maxResourcesPerCall: 1 } },
        } as never,
      },
    });
    const names = (await harness.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('set_campaign_budget');
  });
});
