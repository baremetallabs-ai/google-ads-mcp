import { describe, it, expect, afterEach } from 'vitest';
import { GoogleAdsMock } from '../../helpers/mock-google-ads.js';
import {
  buildTestServer,
  callTool,
  TEST_CUSTOMER_ID,
  type TestHarness,
} from '../../helpers/build-test-server.js';

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
  },
});

describe('audit events', () => {
  it('records an executed mutation with before/after and the request ID', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaign('ENABLED')] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { requestId: 'req-v' });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { requestId: 'req-e' });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    const event = harness.auditEvents().at(-1)!;
    expect(event.result).toBe('executed');
    expect(event.toolName).toBe('pause_campaign');
    expect(event.customerId).toBe(TEST_CUSTOMER_ID);
    expect(event.googleAdsRequestId).toBe('req-e');
    expect(event.beforeState).toMatchObject({ status: 'ENABLED' });
    expect(event.afterState).toMatchObject({ status: 'PAUSED' });
    expect(event.canonicalArguments).toMatchObject({ campaignId: '456', targetStatus: 'PAUSED' });
    expect(event.operationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof event.durationMs).toBe('number');
  });

  it('records a no-op', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaign('PAUSED')] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    const event = harness.auditEvents().at(-1)!;
    expect(event.result).toBe('no_op');
    expect(event.errorCode).toBeUndefined();
  });

  it('records a denied mutation, including one denied before any API call', async () => {
    mock = new GoogleAdsMock();
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    await callTool(harness.client, 'pause_campaign', {
      customerId: '9999999999',
      campaignId: '456',
    });

    const event = harness.auditEvents().at(-1)!;
    expect(event.result).toBe('denied');
    expect(event.errorCode).toBe('UNAUTHORIZED_CUSTOMER');
    expect(mock.requests).toHaveLength(0);
  });

  it('records a validation failure distinctly from a hard failure', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaign('ENABLED')] });
    mock.onMutateError(TEST_CUSTOMER_ID, 400, {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        details: [
          {
            '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
            errors: [{ errorCode: { fieldError: 'REQUIRED' }, message: 'Missing.' }],
            requestId: 'req-vf',
          },
        ],
      },
    }, { requestId: 'req-vf' });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    const event = harness.auditEvents().at(-1)!;
    expect(event.result).toBe('validation_failed');
    expect(event.errorCode).toBe('VALIDATION_FAILED');
    expect(event.googleAdsRequestId).toBe('req-vf');
  });

  it('records a constraint denial with no API mutation attempted', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [
        {
          campaignBudget: {
            id: '100',
            resourceName: `customers/${TEST_CUSTOMER_ID}/campaignBudgets/100`,
            name: 'B',
            amountMicros: '30000000',
            explicitlyShared: false,
            referenceCount: 1,
            status: 'ENABLED',
            period: 'DAILY',
          },
        },
      ],
    });
    mock.onSearch(TEST_CUSTOMER_ID, { results: [] });
    mock.onSearch(TEST_CUSTOMER_ID, {
      results: [
        {
          campaign: { id: '1', status: 'ENABLED' },
          campaignBudget: {
            id: '100',
            resourceName: `customers/${TEST_CUSTOMER_ID}/campaignBudgets/100`,
            amountMicros: '30000000',
            explicitlyShared: false,
            referenceCount: 1,
          },
        },
      ],
    });
    mock.onSearch(TEST_CUSTOMER_ID, { results: [{ customer: { currencyCode: 'USD' } }] });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    await callTool(harness.client, 'set_campaign_budget', {
      customerId: TEST_CUSTOMER_ID,
      budgetId: '100',
      amountMicros: '900000000',
    });

    const event = harness.auditEvents().at(-1)!;
    expect(event.result).toBe('denied');
    expect(event.errorCode).toBe('TOOL_CONSTRAINT_VIOLATION');
    expect(event.canonicalArguments).toMatchObject({ budgetId: '100', amountMicros: '900000000' });
    expect(mock.mutateRequests()).toHaveLength(0);
  });

  it('writes one audit event per mutation attempt and none for reads', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaign('PAUSED')] }, { times: 2 });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    await callTool(harness.client, 'get_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });
    expect(harness.auditEvents()).toHaveLength(0);

    await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });
    expect(harness.auditEvents()).toHaveLength(1);
  });

  it('never writes credentials into any log line', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaign('ENABLED')] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { times: 2 });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });

    await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    const all = JSON.stringify(harness.logs);
    expect(all).not.toContain('test-developer-token-value');
    expect(all).not.toContain('test-access-token');
    expect(all).not.toContain('Bearer ');
  });

  it('records the suppression report at startup', async () => {
    harness = await buildTestServer({ mutationsEnabledEnv: false });
    const registration = harness.logs.find((l) => l.msg === 'tool_registration_complete');
    expect(registration).toBeDefined();
    expect(registration?.mutationToolCount).toBe(0);
    expect((registration?.suppressed as unknown[]).length).toBe(15);
    expect(registration?.mutationsGloballyEnabled).toBe(false);
  });
});
