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

const campaignCriterionRn = (criterionId: string) =>
  `customers/${TEST_CUSTOMER_ID}/campaignCriteria/1~${criterionId}`;

const existingNegative = (criterionId: string, text: string, matchType: string) => ({
  campaignCriterion: {
    resourceName: campaignCriterionRn(criterionId),
    criterionId,
    negative: true,
    type: 'KEYWORD',
    keyword: { text, matchType },
  },
});

describe('add_negative_keyword', () => {
  it('adds negatives to a campaign scope', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [{ campaign: { id: '1', name: 'Search', status: 'ENABLED', resourceName: `customers/${TEST_CUSTOMER_ID}/campaigns/1` } }],
    });
    mock.onSearch(TEST_CUSTOMER_ID, { results: [] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] });
    mock.onMutate(TEST_CUSTOMER_ID, {
      mutateOperationResponses: [{ campaignCriterionResult: { resourceName: campaignCriterionRn('99') } }],
    });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'add_negative_keyword', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '1',
      keywords: [{ text: 'free', matchType: 'PHRASE' }],
    });

    expect(result.isError).toBe(false);
    expect(result.structured.createdCount).toBe(1);
    expect(result.structured.results[0]).toMatchObject({ text: 'free', created: true });

    const body = mock.mutateRequests()[0]?.body as { mutateOperations: unknown[] };
    expect(body.mutateOperations).toEqual([
      {
        campaignCriterionOperation: {
          create: {
            campaign: `customers/${TEST_CUSTOMER_ID}/campaigns/1`,
            negative: true,
            keyword: { text: 'free', matchType: 'PHRASE' },
          },
        },
      },
    ]);
  });

  it('never sets status on a negative criterion', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [{ campaign: { id: '1', name: 'Search', status: 'ENABLED' } }],
    });
    mock.onSearch(TEST_CUSTOMER_ID, { results: [] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { times: 2 });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    await callTool(harness.client, 'add_negative_keyword', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '1',
      keywords: [{ text: 'free', matchType: 'PHRASE' }],
    });

    // Negative criteria carry no status; setting one is rejected by the API.
    expect(mock.mutateRequests()[0]?.rawBody).not.toContain('status');
  });

  it('treats an existing negative as a no-op rather than an error', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [{ campaign: { id: '1', name: 'Search', status: 'ENABLED' } }],
    });
    mock.onSearch(TEST_CUSTOMER_ID, { results: [existingNegative('99', 'free', 'PHRASE')] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'add_negative_keyword', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '1',
      keywords: [{ text: 'free', matchType: 'PHRASE' }],
    });

    expect(result.isError).toBe(false);
    expect(result.structured.changed).toBe(false);
    expect(result.structured.duplicateCount).toBe(1);
    expect(result.structured.results[0].alreadyExisted).toBe(true);
    expect(result.structured.results[0].resourceName).toBe(campaignCriterionRn('99'));
    expect(mock.mutateRequests()).toHaveLength(0);
  });

  it('matches existing negatives case-insensitively', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [{ campaign: { id: '1', name: 'Search', status: 'ENABLED' } }],
    });
    mock.onSearch(TEST_CUSTOMER_ID, { results: [existingNegative('99', 'Free', 'PHRASE')] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'add_negative_keyword', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '1',
      keywords: [{ text: 'free', matchType: 'PHRASE' }],
    });
    expect(result.structured.duplicateCount).toBe(1);
  });

  it('requires exactly one target scope', async () => {
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const both = await callTool(harness.client, 'add_negative_keyword', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '1',
      adGroupId: '2',
      keywords: [{ text: 'free', matchType: 'PHRASE' }],
    });
    expect(both.structured.error.code).toBe('INVALID_ARGUMENT');

    const neither = await callTool(harness.client, 'add_negative_keyword', {
      customerId: TEST_CUSTOMER_ID,
      keywords: [{ text: 'free', matchType: 'PHRASE' }],
    });
    expect(neither.structured.error.code).toBe('INVALID_ARGUMENT');
    expect(mock.requests).toHaveLength(0);
  });

  it('enforces the configured batch maximum in the published schema', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    const schema = tools.find((t) => t.name === 'add_negative_keyword')?.inputSchema as {
      properties?: { keywords?: { maxItems?: number } };
    };
    expect(schema.properties?.keywords?.maxItems).toBe(20);
  });

  it('rejects a match type outside the configured allowlist', async () => {
    mock = new GoogleAdsMock();
    harness = await buildTestServer({
      fetchImpl: mock.fetchImpl,
      config: {
        mutations: {
          enabled: true,
          default: 'deny',
          tools: {
            add_negative_keyword: {
              enabled: true,
              maxResourcesPerCall: 20,
              allowedMatchTypes: ['PHRASE'],
            },
          },
        } as never,
        budgets: undefined,
      },
    });

    const result = await callTool(harness.client, 'add_negative_keyword', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '1',
      keywords: [{ text: 'free', matchType: 'BROAD' }],
    });
    // The published enum rejects it at the protocol layer.
    expect(result.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('remove_negative_keyword', () => {
  it('removes by concrete resource name', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [existingNegative('99', 'free', 'PHRASE')] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { times: 2 });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'remove_negative_keyword', {
      customerId: TEST_CUSTOMER_ID,
      criteria: [{ resourceName: campaignCriterionRn('99') }],
    });

    expect(result.isError).toBe(false);
    expect(result.structured.removedCount).toBe(1);
    const body = mock.mutateRequests()[0]?.body as { mutateOperations: unknown[] };
    expect(body.mutateOperations).toEqual([
      { campaignCriterionOperation: { remove: campaignCriterionRn('99') } },
    ]);
  });

  it('rejects a resource name belonging to another customer', async () => {
    // A resource name is model-controlled input carrying a customer ID. Without this
    // check a well-formed name would bypass the allowlist entirely.
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'remove_negative_keyword', {
      customerId: TEST_CUSTOMER_ID,
      criteria: [{ resourceName: 'customers/9999999999/campaignCriteria/1~99' }],
    });

    expect(result.isError).toBe(true);
    expect(result.structured.error.code).toBe('UNAUTHORIZED_CUSTOMER');
    expect(mock.requests).toHaveLength(0);
  });

  it('reports a criterion that no longer exists as not found, not an error', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'remove_negative_keyword', {
      customerId: TEST_CUSTOMER_ID,
      criteria: [{ resourceName: campaignCriterionRn('99') }],
    });

    expect(result.isError).toBe(false);
    expect(result.structured.success).toBe(true);
    expect(result.structured.changed).toBe(false);
    expect(result.structured.notFoundCount).toBe(1);
    expect(result.structured.results[0].result).toBe('not_found');
    expect(mock.mutateRequests()).toHaveLength(0);
  });

  it('refuses to delete a positive keyword through the negatives tool', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [
        {
          campaignCriterion: {
            resourceName: campaignCriterionRn('99'),
            negative: false,
            type: 'KEYWORD',
            keyword: { text: 'shoes', matchType: 'PHRASE' },
          },
        },
      ],
    });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'remove_negative_keyword', {
      customerId: TEST_CUSTOMER_ID,
      criteria: [{ resourceName: campaignCriterionRn('99') }],
    });
    expect(result.structured.error.code).toBe('UNSUPPORTED_RESOURCE_STATE');
    expect(mock.mutateRequests()).toHaveLength(0);
  });

  it('does not expose text-based removal when it is disabled', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    const schema = tools.find((t) => t.name === 'remove_negative_keyword')?.inputSchema as {
      properties?: { criteria?: { items?: { properties?: Record<string, unknown> } } };
    };
    const itemProps = schema.properties?.criteria?.items?.properties ?? {};
    expect(Object.keys(itemProps)).not.toContain('text');
  });
});
