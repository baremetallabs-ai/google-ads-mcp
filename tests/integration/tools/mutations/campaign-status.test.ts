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

const campaign = (status: string) => ({
  campaign: {
    id: '456',
    name: 'US Search — Brand',
    status,
    resourceName: `customers/${TEST_CUSTOMER_ID}/campaigns/456`,
    advertisingChannelType: 'SEARCH',
  },
});

async function setup(status: string, mutates = 2) {
  mock = new GoogleAdsMock();
  mock.onSearch(TEST_CUSTOMER_ID, { results: [campaign(status)] });
  if (mutates > 0) mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { times: mutates });
  harness = await buildTestServer({ fetchImpl: mock.fetchImpl });
  return { mock, harness };
}

describe('pause_campaign', () => {
  it('pauses an enabled campaign and returns before/after state', async () => {
    const { harness: h } = await setup('ENABLED');
    const result = await callTool(h.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    expect(result.isError).toBe(false);
    expect(result.structured).toMatchObject({
      success: true,
      changed: true,
      customerId: TEST_CUSTOMER_ID,
      resourceType: 'campaign',
      resourceId: '456',
      before: { status: 'ENABLED' },
      after: { status: 'PAUSED' },
    });
    expect(result.text).toContain('Paused campaign "US Search — Brand"');
  });

  it('returns a successful no-op for an already paused campaign without calling Google Ads', async () => {
    // Scenario 6: a client retrying after a timeout must not issue a second mutation.
    const { mock: m, harness: h } = await setup('PAUSED', 0);
    const result = await callTool(h.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    expect(result.isError).toBe(false);
    expect(result.structured.success).toBe(true);
    expect(result.structured.changed).toBe(false);
    expect(result.structured.before).toEqual(result.structured.after);
    expect(result.text).toContain('already paused');
    expect(m.mutateRequests()).toHaveLength(0);
  });

  it('rejects a stale expected status', async () => {
    // Scenario 5: the client's previously observed state is not assumed still valid.
    const { mock: m, harness: h } = await setup('PAUSED', 0);
    const result = await callTool(h.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
      expectedCurrentStatus: 'ENABLED',
    });

    expect(result.isError).toBe(true);
    expect(result.structured.error.code).toBe('STALE_RESOURCE_STATE');
    expect(result.structured.error.details).toMatchObject({
      field: 'status',
      expected: 'ENABLED',
      actual: 'PAUSED',
    });
    expect(m.mutateRequests()).toHaveLength(0);
  });

  it('proceeds when the expected status matches', async () => {
    const { harness: h } = await setup('ENABLED');
    const result = await callTool(h.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
      expectedCurrentStatus: 'ENABLED',
    });
    expect(result.isError).toBe(false);
    expect(result.structured.changed).toBe(true);
  });

  it('reports a missing campaign as RESOURCE_NOT_FOUND', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '999',
    });
    expect(result.structured.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('refuses to act on a removed campaign', async () => {
    const { mock: m, harness: h } = await setup('REMOVED', 0);
    const result = await callTool(h.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });
    expect(result.structured.error.code).toBe('UNSUPPORTED_RESOURCE_STATE');
    expect(m.mutateRequests()).toHaveLength(0);
  });
});

describe('enable_campaign', () => {
  it('enables a paused campaign', async () => {
    const { harness: h } = await setup('PAUSED');
    const result = await callTool(h.client, 'enable_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });
    expect(result.structured).toMatchObject({
      changed: true,
      before: { status: 'PAUSED' },
      after: { status: 'ENABLED' },
    });
  });

  it('never silently enables a removed campaign', async () => {
    const { mock: m, harness: h } = await setup('REMOVED', 0);
    const result = await callTool(h.client, 'enable_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });
    expect(result.isError).toBe(true);
    expect(result.structured.error.code).toBe('UNSUPPORTED_RESOURCE_STATE');
    expect(m.mutateRequests()).toHaveLength(0);
  });

  it('is a no-op for an already enabled campaign', async () => {
    const { mock: m, harness: h } = await setup('ENABLED', 0);
    const result = await callTool(h.client, 'enable_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });
    expect(result.structured.changed).toBe(false);
    expect(m.mutateRequests()).toHaveLength(0);
  });
});

describe('authorization precedes any Google Ads call', () => {
  it('rejects an unauthorized customer before making a request', async () => {
    // Scenario 3. The mock has no interceptors, so any HTTP call would fail loudly.
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'pause_campaign', {
      customerId: '9999999999',
      campaignId: '456',
    });

    expect(result.isError).toBe(true);
    expect(result.structured.error.code).toBe('UNAUTHORIZED_CUSTOMER');
    expect(mock.requests).toHaveLength(0);
  });

  it('normalizes a dashed customer ID before authorizing', async () => {
    const { harness: h } = await setup('ENABLED');
    const result = await callTool(h.client, 'pause_campaign', {
      customerId: '123-456-7890',
      campaignId: '456',
    });
    expect(result.isError).toBe(false);
    expect(result.structured.customerId).toBe('1234567890');
  });
});

describe('confirmation independence', () => {
  it('behaves identically for two clients regardless of any client-side confirmation', async () => {
    // Scenario 2. The server has no notion of whether a confirmation was shown.
    const runs: Record<string, unknown>[] = [];
    for (let i = 0; i < 2; i++) {
      const { harness: h } = await setup('ENABLED');
      const result = await callTool(h.client, 'pause_campaign', {
        customerId: TEST_CUSTOMER_ID,
        campaignId: '456',
      });
      runs.push(result.structured);
      await h.close();
      await mock?.close();
      harness = undefined;
      mock = undefined;
    }
    const [a, b] = runs;
    expect({ ...a, googleAdsRequestId: null }).toEqual({ ...b, googleAdsRequestId: null });
  });
});
