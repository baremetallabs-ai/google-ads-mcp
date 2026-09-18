import { describe, it, expect, afterEach } from 'vitest';
import { GoogleAdsMock } from '../../helpers/mock-google-ads.js';
import { buildTestServer, callTool, TEST_CUSTOMER_ID, type TestHarness } from '../../helpers/build-test-server.js';

let harness: TestHarness | undefined;
let mock: GoogleAdsMock | undefined;

afterEach(async () => {
  await harness?.close();
  await mock?.close();
  harness = undefined;
  mock = undefined;
});

const campaignRow = (status = 'ENABLED') => ({
  campaign: {
    id: '456',
    name: 'US Search — Brand',
    status,
    resourceName: `customers/${TEST_CUSTOMER_ID}/campaigns/456`,
    advertisingChannelType: 'SEARCH',
  },
});

const failure = (errorCode: Record<string, string>, message: string) => ({
  error: {
    code: 400,
    status: 'INVALID_ARGUMENT',
    message: 'Request contains an invalid argument.',
    details: [
      {
        '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
        errors: [{ errorCode, message }],
        requestId: 'req-validate-fail',
      },
    ],
  },
});

describe('validate_only precedes execution', () => {
  it('sends validateOnly:true first, then executes', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow('ENABLED')] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { requestId: 'req-v' });
    mock.onMutate(
      TEST_CUSTOMER_ID,
      { mutateOperationResponses: [{ campaignResult: { resourceName: `customers/${TEST_CUSTOMER_ID}/campaigns/456` } }] },
      { requestId: 'req-e' },
    );

    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });
    const result = await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    expect(result.isError).toBe(false);
    const mutates = mock.mutateRequests();
    expect(mutates).toHaveLength(2);
    expect((mutates[0]?.body as { validateOnly: boolean }).validateOnly).toBe(true);
    expect((mutates[1]?.body as { validateOnly: boolean }).validateOnly).toBe(false);
  });

  it('executes exactly the operation that was validated', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow('ENABLED')] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] });

    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });
    await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    const [validate, execute] = mock.mutateRequests();
    const vBody = validate?.body as Record<string, unknown>;
    const eBody = execute?.body as Record<string, unknown>;

    // The two bodies must be identical apart from the validateOnly flag. Anything
    // else means model-controlled data altered the operation in between.
    expect(JSON.stringify(vBody.mutateOperations)).toBe(JSON.stringify(eBody.mutateOperations));
    expect({ ...vBody, validateOnly: null }).toEqual({ ...eBody, validateOnly: null });

    expect(vBody.mutateOperations).toEqual([
      {
        campaignOperation: {
          update: { resourceName: `customers/${TEST_CUSTOMER_ID}/campaigns/456`, status: 'PAUSED' },
          updateMask: 'status',
        },
      },
    ]);
  });

  it('disables partial failure on both requests', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow('ENABLED')] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { times: 2 });

    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });
    await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    for (const request of mock.mutateRequests()) {
      expect((request.body as { partialFailure: boolean }).partialFailure).toBe(false);
    }
  });

  it('a validation failure prevents execution entirely', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow('ENABLED')] });
    mock.onMutateError(
      TEST_CUSTOMER_ID,
      400,
      failure({ fieldError: 'REQUIRED' }, 'Required field missing.'),
      { requestId: 'req-validate-fail' },
    );

    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });
    const result = await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    expect(result.isError).toBe(true);
    expect(result.structured.error.code).toBe('VALIDATION_FAILED');
    // Exactly one mutate call: the validate. No execute followed it.
    expect(mock.mutateRequests()).toHaveLength(1);
    expect((mock.mutateRequests()[0]?.body as { validateOnly: boolean }).validateOnly).toBe(true);
  });

  it('surfaces the Google Ads request ID on success', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow('ENABLED')] });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { requestId: 'req-v' });
    mock.onMutate(TEST_CUSTOMER_ID, { mutateOperationResponses: [{}] }, { requestId: 'req-exec-42' });

    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });
    const result = await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    expect(result.structured.googleAdsRequestId).toBe('req-exec-42');
    const audit = harness.auditEvents().at(-1);
    expect(audit?.googleAdsRequestId).toBe('req-exec-42');
  });

  it('sends the required Google Ads headers and never logs the bearer token', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow('PAUSED')] });

    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });
    await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    const search = mock.requests[0];
    expect(search?.headers.authorization).toBe('Bearer test-access-token');
    expect(search?.headers['developer-token']).toBe('test-developer-token-value');
    expect(search?.headers['login-customer-id']).toBe('9876543210');

    const logs = JSON.stringify(harness.logs);
    expect(logs).not.toContain('test-access-token');
    expect(logs).not.toContain('test-developer-token-value');
  });
});

describe('rate limiting and API errors', () => {
  it('maps a 429 to RATE_LIMITED after exhausting retries', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow('ENABLED')] });
    // validateOnly requests are retryable, so all three attempts are consumed.
    mock.onMutateError(TEST_CUSTOMER_ID, 429, failure({ quotaError: 'RESOURCE_EXHAUSTED' }, 'Too many requests.'), {
      times: 3,
    });

    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });
    const result = await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    expect(result.isError).toBe(true);
    expect(result.structured.error.code).toBe('RATE_LIMITED');
  }, 15000);

  it('sanitizes an API error into code, message and field path', async () => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [campaignRow('ENABLED')] });
    mock.onMutateError(TEST_CUSTOMER_ID, 400, {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'Request contains an invalid argument.',
        details: [
          {
            '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
            errors: [
              {
                errorCode: { campaignError: 'CANNOT_MODIFY_REMOVED_CAMPAIGN' },
                message: 'Cannot modify a removed campaign.',
                location: { fieldPathElements: [{ fieldName: 'operations', index: 0 }] },
              },
            ],
            requestId: 'req-sanitize',
          },
        ],
      },
    }, { requestId: 'req-sanitize' });

    harness = await buildTestServer({ fetchImpl: mock.fetchImpl });
    const result = await callTool(harness.client, 'pause_campaign', {
      customerId: TEST_CUSTOMER_ID,
      campaignId: '456',
    });

    const error = result.structured.error;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details.errors[0].errorCode).toBe('campaignError.CANNOT_MODIFY_REMOVED_CAMPAIGN');
    expect(error.details.errors[0].operationIndex).toBe(0);
    expect(error.details.googleAdsRequestId).toBe('req-sanitize');
    // No raw upstream envelope, no stack.
    expect(JSON.stringify(error)).not.toContain('@type');
    expect(JSON.stringify(error)).not.toContain('stack');
  });
});
