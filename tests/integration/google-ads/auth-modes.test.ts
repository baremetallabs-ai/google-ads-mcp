import { afterEach, describe, expect, it } from 'vitest';
import { GoogleAdsMock } from '../../helpers/mock-google-ads.js';
import { buildTestServer, callTool, TEST_CUSTOMER_ID, TEST_LOGIN_CUSTOMER_ID, type TestHarness } from '../../helpers/build-test-server.js';
import { ServiceAccountTokenProvider, StaticAccessTokenProvider } from '../../../src/google-ads/auth.js';

let harness: TestHarness | undefined;
let mock: GoogleAdsMock | undefined;
afterEach(async () => { await harness?.close(); await mock?.close(); harness = undefined; mock = undefined; });

describe('auth mode wire and MCP contract', () => {
  it.each([
    ['user', 'supplied', 'manager'], ['user', 'absent', 'manager'],
    ['service_account', 'supplied', 'direct'], ['service_account', 'absent', 'direct'],
    ['service_account', 'absent', 'manager'],
  ] as const)('%s mode sends %s token and %s routing', async (mode, token, routing) => {
    mock = new GoogleAdsMock();
    mock.onSearch(TEST_CUSTOMER_ID, { results: [] });
    mock.onListAccessibleCustomers([`customers/${TEST_CUSTOMER_ID}`]);
    harness = await buildTestServer({
      fetchImpl: mock.fetchImpl,
      developerToken: token === 'absent' ? null : 'developer-token',
      loginCustomerId: routing === 'direct' ? null : TEST_LOGIN_CUSTOMER_ID,
      tokenProvider: mode === 'service_account'
        ? new ServiceAccountTokenProvider({
            source: 'json',
            key: { type: 'service_account', client_email: 'svc@example.iam.gserviceaccount.com', private_key: 'test-key' },
            createKeyClient: () => ({
              credentials: { expiry_date: Date.now() + 3600_000 },
              getAccessToken: () => Promise.resolve({ token: 'service-bearer' }),
            }) as never,
          })
        : new StaticAccessTokenProvider('user-bearer'),
    });
    await harness.deps.transport.search({ customerId: TEST_CUSTOMER_ID, query: 'SELECT campaign.id FROM campaign' });
    await harness.deps.transport.listAccessibleCustomers();
    const [search, list] = mock.requests;
    expect(search?.headers.authorization).toBe(`Bearer ${mode === 'service_account' ? 'service-bearer' : 'user-bearer'}`);
    expect(search?.headers['developer-token']).toBe(token === 'absent' ? undefined : 'developer-token');
    expect(search?.headers['login-customer-id']).toBe(routing === 'direct' ? undefined : TEST_LOGIN_CUSTOMER_ID);
    expect(list?.headers['login-customer-id']).toBeUndefined();
  });
  it.each(['user', 'service_account'])('%s gives mode-neutral zero-queryable account guidance', async (mode) => {
    mock = new GoogleAdsMock();
    mock.onListAccessibleCustomers([]);
    mock.onSearchError(TEST_CUSTOMER_ID, 403, { error: { message: 'PRIVATE-SENTINEL' } });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl, loginCustomerId: mode === 'user' ? TEST_LOGIN_CUSTOMER_ID : null });
    const result = await callTool(harness.client, 'list_accessible_accounts', {});
    expect(result.structured.queryableCount).toBe(0);
    expect(result.structured.message).toContain('target-account access and role');
    expect(result.structured.message).not.toContain('developer token');
    expect(result.structured.loginCustomerId).toBeDefined();
  });
  it.each(['user', 'service_account'])('%s retains tools, allowlist, authorization envelope, and audit', async (mode) => {
    mock = new GoogleAdsMock();
    mock.onSearchError(TEST_CUSTOMER_ID, 403, { error: { message: 'PRIVATE-SENTINEL', details: [{ errors: [{ trigger: 'PRIVATE-SENTINEL' }] }] } }, { requestId: 'req-denied' });
    harness = await buildTestServer({ fetchImpl: mock.fetchImpl, developerToken: mode === 'user' ? 'dev' : null, loginCustomerId: mode === 'user' ? TEST_LOGIN_CUSTOMER_ID : null });
    const tools = await harness.client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'pause_campaign')).toBe(true);
    const denied = await callTool(harness.client, 'get_campaign', { customerId: '9999999999', campaignId: '456' });
    expect(denied.structured.error.code).toBe('UNAUTHORIZED_CUSTOMER');
    expect(mock.requests).toHaveLength(0);
    const auth = await callTool(harness.client, 'get_campaign', { customerId: TEST_CUSTOMER_ID, campaignId: '456' });
    expect(auth.structured.error.code).toBe('GOOGLE_ADS_API_ERROR');
    expect(JSON.stringify(auth.structured)).not.toContain('PRIVATE-SENTINEL');
    expect(auth.structured.error.details.googleAdsRequestId).toBe('req-denied');
    const mutation = await callTool(harness.client, 'pause_campaign', { customerId: '9999999999', campaignId: '456' });
    expect(mutation.structured.error.code).toBe('UNAUTHORIZED_CUSTOMER');
    expect(harness.auditEvents()).toHaveLength(1);
    expect(harness.auditEvents()[0]?.result).toBe('denied');
  });
});
