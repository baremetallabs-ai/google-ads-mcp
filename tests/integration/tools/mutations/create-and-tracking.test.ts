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

const adGroupRow = {
  adGroup: { id: '77', name: 'Brand — Exact', status: 'ENABLED', type: 'SEARCH_STANDARD' },
  campaign: { id: '1', name: 'Search', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
};

const VALID_AD = {
  finalUrls: ['https://example.com/landing'],
  headlines: [{ text: 'Fast Online Filing' }, { text: 'Secure And Simple' }, { text: 'Done In Minutes' }],
  descriptions: [{ text: 'We file it for you, securely.' }, { text: 'Secure and fast.' }],
};

describe('create_paused_ad', () => {
  it('creates ads with a server-set PAUSED status', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [adGroupRow] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] });
    mock.onMutate(TEST_CUSTOMER_ID, {
      mutateOperationResponses: [
        { adGroupAdResult: { resourceName: `customers/${TEST_CUSTOMER_ID}/adGroupAds/77~500` } },
      ],
    });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'create_paused_ad', {
      customerId: TEST_CUSTOMER_ID,
      adGroupId: '77',
      ads: [VALID_AD],
    });

    expect(result.isError).toBe(false);
    expect(result.structured.createdCount).toBe(1);
    expect(result.structured.results[0]).toMatchObject({ adId: '500', status: 'PAUSED' });

    const op = (mock.mutateRequests()[0]?.body as { mutateOperations: any[] }).mutateOperations[0];
    expect(op.adGroupAdOperation.create.status).toBe('PAUSED');
    expect(op.adGroupAdOperation.create.ad.responsiveSearchAd.headlines).toHaveLength(3);
  });

  it('rejects an attempt to create an enabled ad', async () => {
    // The schema has no status field at all and is strict, so this cannot be smuggled.
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    for (const extra of [{ status: 'ENABLED' }, { enabled: true }]) {
      const result = await callTool(harness.client, 'create_paused_ad', {
        customerId: TEST_CUSTOMER_ID,
        adGroupId: '77',
        ads: [{ ...VALID_AD, ...extra }],
      });
      expect(result.isError).toBe(true);
    }
    expect(mock.requests).toHaveLength(0);
  });

  it('does not advertise a status field', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    const schema = JSON.stringify(tools.find((t) => t.name === 'create_paused_ad')?.inputSchema);
    expect(schema).not.toContain('"status"');
    expect(schema).not.toContain('"enabled"');
  });

  it('enforces responsive search ad field limits', async () => {
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const tooFewHeadlines = await callTool(harness.client, 'create_paused_ad', {
      customerId: TEST_CUSTOMER_ID,
      adGroupId: '77',
      ads: [{ ...VALID_AD, headlines: [{ text: 'One' }] }],
    });
    expect(tooFewHeadlines.isError).toBe(true);

    const headlineTooLong = await callTool(harness.client, 'create_paused_ad', {
      customerId: TEST_CUSTOMER_ID,
      adGroupId: '77',
      ads: [{ ...VALID_AD, headlines: [{ text: 'x'.repeat(31) }, { text: 'b' }, { text: 'c' }] }],
    });
    expect(headlineTooLong.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });

  it('does not log ad copy in the audit event', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [adGroupRow] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { times: 2 });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    await callTool(harness.client, 'create_paused_ad', {
      customerId: TEST_CUSTOMER_ID,
      adGroupId: '77',
      ads: [VALID_AD],
    });

    const audit = harness.auditEvents().at(-1);
    const serialized = JSON.stringify(audit?.canonicalArguments);
    // IDs and counts are enough; full advertising content is not logged.
    expect(serialized).not.toContain('Fast Online Filing');
    expect(serialized).toContain('adCount');
    expect(serialized).toContain('example.com');
  });
});

describe('create_paused_keyword', () => {
  it('creates keywords with a server-set PAUSED status', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [adGroupRow] });
    mock.onSearch(TEST_CUSTOMER_ID, { results: [] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] });
    mock.onMutate(TEST_CUSTOMER_ID, {
      mutateOperationResponses: [
        { adGroupCriterionResult: { resourceName: `customers/${TEST_CUSTOMER_ID}/adGroupCriteria/77~900` } },
      ],
    });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'create_paused_keyword', {
      customerId: TEST_CUSTOMER_ID,
      adGroupId: '77',
      keywords: [{ text: 'online filing', matchType: 'PHRASE' }],
    });

    expect(result.structured.createdCount).toBe(1);
    expect(result.structured.results[0]).toMatchObject({ criterionId: '900', status: 'PAUSED' });
    const op = (mock.mutateRequests()[0]?.body as { mutateOperations: any[] }).mutateOperations[0];
    expect(op.adGroupCriterionOperation.create.status).toBe('PAUSED');
  });

  it('rejects an attempt to create an active keyword', async () => {
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });
    const result = await callTool(harness.client, 'create_paused_keyword', {
      customerId: TEST_CUSTOMER_ID,
      adGroupId: '77',
      keywords: [{ text: 'filing', matchType: 'PHRASE', status: 'ENABLED' }],
    });
    expect(result.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });

  it('reports an existing keyword as a no-op', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [adGroupRow] });
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [
        {
          adGroupCriterion: {
            resourceName: `customers/${TEST_CUSTOMER_ID}/adGroupCriteria/77~900`,
            status: 'ENABLED',
            keyword: { text: 'online filing', matchType: 'PHRASE' },
          },
        },
      ],
    });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'create_paused_keyword', {
      customerId: TEST_CUSTOMER_ID,
      adGroupId: '77',
      keywords: [{ text: 'online filing', matchType: 'PHRASE' }],
    });
    expect(result.structured.changed).toBe(false);
    expect(result.structured.duplicateCount).toBe(1);
    expect(mock.mutateRequests()).toHaveLength(0);
  });
});

describe('update_tracking_parameters', () => {
  const campaignRow = {
    campaign: {
      id: '1',
      name: 'Search',
      resourceName: `customers/${TEST_CUSTOMER_ID}/campaigns/1`,
      trackingUrlTemplate: '{lpurl}?utm_source=google',
      finalUrlSuffix: null,
      urlCustomParameters: [],
    },
  };

  it('updates a tracking template that preserves the destination', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { times: 2 });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'update_tracking_parameters', {
      customerId: TEST_CUSTOMER_ID,
      entityType: 'campaign',
      campaignId: '1',
      trackingUrlTemplate: '{lpurl}?utm_source=google&utm_medium=cpc',
    });

    expect(result.isError).toBe(false);
    expect(result.structured.finalUrlChanged).toBe(false);
    expect(result.structured.changedFields).toEqual(['trackingUrlTemplate']);
    const op = (mock.mutateRequests()[0]?.body as { mutateOperations: any[] }).mutateOperations[0];
    expect(op.campaignOperation.updateMask).toBe('trackingUrlTemplate');
  });

  it('rejects a final URL change when the capability is disabled', async () => {
    // Scenario 7. finalUrls is absent from the schema in this mode.
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'update_tracking_parameters', {
      customerId: TEST_CUSTOMER_ID,
      entityType: 'campaign',
      campaignId: '1',
      trackingUrlTemplate: '{lpurl}?x=1',
      finalUrls: ['https://example.com/b'],
    });

    expect(result.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });

  it('rejects a tracking template that would replace the destination', async () => {
    // A template without {lpurl} IS the destination. A domain check alone misses this.
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'update_tracking_parameters', {
      customerId: TEST_CUSTOMER_ID,
      entityType: 'campaign',
      campaignId: '1',
      trackingUrlTemplate: 'https://evil.example.com/redirect',
    });

    expect(result.isError).toBe(true);
    expect(result.structured.error.code).toBe('TOOL_CONSTRAINT_VIOLATION');
    expect(mock.mutateRequests()).toHaveLength(0);
  });

  it('rejects a final URL suffix that could alter path or query structure', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow] }, { times: 3 });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    for (const suffix of ['?utm=1', 'a=1#frag', '//evil.com']) {
      const result = await callTool(harness.client, 'update_tracking_parameters', {
        customerId: TEST_CUSTOMER_ID,
        entityType: 'campaign',
        campaignId: '1',
        finalUrlSuffix: suffix,
      });
      expect(result.structured.error?.code, suffix).toBe('TOOL_CONSTRAINT_VIOLATION');
    }
    expect(mock.mutateRequests()).toHaveLength(0);
  });

  it('accepts a well-formed key=value suffix', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { times: 2 });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'update_tracking_parameters', {
      customerId: TEST_CUSTOMER_ID,
      entityType: 'campaign',
      campaignId: '1',
      finalUrlSuffix: 'utm_source=google&utm_medium=cpc',
    });
    expect(result.isError).toBe(false);
  });

  it('is a no-op when the requested values already match', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'update_tracking_parameters', {
      customerId: TEST_CUSTOMER_ID,
      entityType: 'campaign',
      campaignId: '1',
      trackingUrlTemplate: '{lpurl}?utm_source=google',
    });
    expect(result.structured.changed).toBe(false);
    expect(mock.mutateRequests()).toHaveLength(0);
  });

  it('rejects a stale expected tracking template', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'update_tracking_parameters', {
      customerId: TEST_CUSTOMER_ID,
      entityType: 'campaign',
      campaignId: '1',
      trackingUrlTemplate: '{lpurl}?new=1',
      expectedCurrentTrackingTemplate: '{lpurl}?something_else=1',
    });
    expect(result.structured.error.code).toBe('STALE_RESOURCE_STATE');
  });

  it('targets AdService when updating an ad, not AdGroupAdService', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [
        {
          adGroupAd: {
            status: 'ENABLED',
            ad: {
              id: '500',
              name: 'Ad',
              finalUrls: ['https://example.com/landing'],
              trackingUrlTemplate: null,
              finalUrlSuffix: null,
              urlCustomParameters: [],
            },
          },
        },
      ],
    });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { times: 2 });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    await callTool(harness.client, 'update_tracking_parameters', {
      customerId: TEST_CUSTOMER_ID,
      entityType: 'ad',
      adGroupId: '77',
      adId: '500',
      trackingUrlTemplate: '{lpurl}?utm_source=google',
    });

    const op = (mock.mutateRequests()[0]?.body as { mutateOperations: any[] }).mutateOperations[0];
    // ad_group_ad owns only status; URL fields live on the ad resource.
    expect(op.adOperation).toBeDefined();
    expect(op.adGroupAdOperation).toBeUndefined();
    expect(op.adOperation.update.resourceName).toBe(`customers/${TEST_CUSTOMER_ID}/ads/500`);
  });
});

describe('dismiss_recommendation', () => {
  const recRn = `customers/${TEST_CUSTOMER_ID}/recommendations/AbC123`;

  it('dismisses without a validate_only pass, and says so', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [{ recommendation: { resourceName: recRn, type: 'KEYWORD', dismissed: false } }],
    });
    mock.onDismiss(TEST_CUSTOMER_ID, { results: [{ recommendation: recRn }] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'dismiss_recommendation', {
      customerId: TEST_CUSTOMER_ID,
      recommendationResourceNames: [recRn],
    });

    expect(result.isError).toBe(false);
    expect(result.structured.dismissedCount).toBe(1);
    // The dismiss endpoint has no validateOnly field, so no mutate call is made.
    expect(result.structured.validateOnlySupported).toBe(false);
    expect(mock.mutateRequests()).toHaveLength(0);
    const dismissBody = mock.requests.find((r) => r.path.endsWith(':dismiss'))?.body as {
      partialFailure: boolean;
    };
    expect(dismissBody.partialFailure).toBe(false);
  });

  it('is a no-op for an already dismissed recommendation', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [{ recommendation: { resourceName: recRn, type: 'KEYWORD', dismissed: true } }],
    });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'dismiss_recommendation', {
      customerId: TEST_CUSTOMER_ID,
      recommendationResourceNames: [recRn],
    });
    expect(result.structured.changed).toBe(false);
    expect(result.structured.alreadyDismissedCount).toBe(1);
    expect(mock.requests.filter((r) => r.path.endsWith(':dismiss'))).toHaveLength(0);
  });

  it('refuses a mixed-type batch, which partial-failure-disabled cannot express', async () => {
    mock = new GoogleAdsMock();
    const other = `customers/${TEST_CUSTOMER_ID}/recommendations/XyZ789`;
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [
        { recommendation: { resourceName: recRn, type: 'KEYWORD', dismissed: false } },
        { recommendation: { resourceName: other, type: 'TARGET_CPA_OPT_IN', dismissed: false } },
      ],
    });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    const result = await callTool(harness.client, 'dismiss_recommendation', {
      customerId: TEST_CUSTOMER_ID,
      recommendationResourceNames: [recRn, other],
    });
    expect(result.structured.error.code).toBe('TOOL_CONSTRAINT_VIOLATION');
  });

  it('rejects a recommendation belonging to another customer', async () => {
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });
    const result = await callTool(harness.client, 'dismiss_recommendation', {
      customerId: TEST_CUSTOMER_ID,
      recommendationResourceNames: ['customers/9999999999/recommendations/AbC123'],
    });
    expect(result.structured.error.code).toBe('UNAUTHORIZED_CUSTOMER');
    expect(mock.requests).toHaveLength(0);
  });
});
