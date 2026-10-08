import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import {
  MUTATION_TOOL_NAMES,
  PROHIBITED_TOOL_NAMES,
  READ_TOOL_NAMES,
} from '../../../src/capabilities/tool-names.js';
import { buildTestServer, callTool, type TestHarness } from '../../helpers/build-test-server.js';
import { GoogleAdsMock } from '../../helpers/mock-google-ads.js';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('standard tools/list', () => {
  it('advertises every read tool and every enabled mutation tool', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toHaveLength(30);
    for (const name of READ_TOOL_NAMES) expect(names).toContain(name);
    for (const name of MUTATION_TOOL_NAMES) expect(names).toContain(name);
  });

  it('keeps the staging slug limit tied to registered tool names', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    const script = readFileSync('scripts/stage-agentapps.mjs', 'utf8');
    const longest = /const LONGEST_TOOL = '([^']+)';/.exec(script)?.[1];
    expect(longest).toBeDefined();
    expect(tools.map((tool) => tool.name)).toContain(longest);
    for (const tool of tools) expect(tool.name.length, tool.name).toBeLessThanOrEqual(longest!.length);
  });

  it('gives every tool a title, a description and an input schema', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    for (const tool of tools) {
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect((tool.description ?? '').length, `${tool.name} description length`).toBeGreaterThan(40);
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeDefined();
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
    }
  });

  it('marks mutation tools with the client-facing behaviour hints', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of MUTATION_TOOL_NAMES) {
      const annotations = byName.get(name)?.annotations;
      expect(annotations?.readOnlyHint, `${name} readOnlyHint`).toBe(false);
      expect(annotations?.openWorldHint, `${name} openWorldHint`).toBe(true);
    }
    // Status changes are reversible but overwrite state, so they are destructive
    // and idempotent; creation tools add rather than replace.
    expect(byName.get('pause_campaign')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('pause_campaign')?.annotations?.idempotentHint).toBe(true);
    expect(byName.get('create_paused_ad')?.annotations?.destructiveHint).toBe(false);
    expect(byName.get('create_paused_ad')?.annotations?.idempotentHint).toBe(false);
  });

  it('marks read tools read-only', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of READ_TOOL_NAMES) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(false);
    }
  });

  it('states the charge implication in the budget tool description', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    const description = tools.find((t) => t.name === 'set_campaign_budget')?.description ?? '';
    expect(description.toLowerCase()).toContain('budget');
    expect(description.toLowerCase()).toContain('charge');
  });

  it('says plainly that paused creation does not serve', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    for (const name of ['create_paused_ad', 'create_paused_keyword']) {
      const description = tools.find((t) => t.name === name)?.description ?? '';
      expect(description.toLowerCase(), name).toContain('paused');
      expect(description.toLowerCase(), name).toContain('will not');
    }
  });
});

describe('no custom approval surface', () => {
  const BANNED = ['approved', 'approvalToken', 'approvedBy', 'proposalId', 'riskLevel'];

  it('no tool accepts an approval-shaped argument', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    const offenders: string[] = [];
    for (const tool of tools) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> };
      for (const banned of BANNED) {
        if (schema.properties && banned in schema.properties) offenders.push(`${tool.name}.${banned}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('advertises additionalProperties:false so a client can see extras are refused', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    for (const tool of tools) {
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties, tool.name)
        .toBe(false);
    }
  });

  it('rejects an approval argument at call time', async () => {
    harness = await buildTestServer();
    const result = (await harness.client.callTool({
      name: 'pause_campaign',
      arguments: { customerId: '1234567890', campaignId: '123', approved: true },
    })) as { isError?: boolean; content?: { text?: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? '').toContain('approved');
  });
});

describe('explicitly excluded operations', () => {
  it('registers none of the prohibited tool names', async () => {
    harness = await buildTestServer();
    const names = (await harness.client.listTools()).tools.map((t) => t.name);
    for (const prohibited of PROHIBITED_TOOL_NAMES) {
      expect(names, `${prohibited} must not be registered`).not.toContain(prohibited);
    }
  });

  it('exposes no generic mutate and no budget reallocation tool', async () => {
    harness = await buildTestServer();
    const names = (await harness.client.listTools()).tools.map((t) => t.name);
    // A generic mutate would make every other constraint bypassable.
    expect(names.some((n) => /raw|arbitrary|protobuf/i.test(n))).toBe(false);
    expect(names.some((n) => /reallocat/i.test(n))).toBe(false);
    expect(names.some((n) => /billing|payment|invoice/i.test(n))).toBe(false);
    expect(names.some((n) => /user_access|manager_link|create_customer/i.test(n))).toBe(false);
  });

  it('exposes no campaign creation or deletion', async () => {
    harness = await buildTestServer();
    const names = (await harness.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('create_campaign');
    expect(names).not.toContain('delete_campaign');
    expect(names.some((n) => n.startsWith('delete_') || n.startsWith('remove_campaign'))).toBe(false);
  });

  it('offers dismissal but not application of recommendations', async () => {
    harness = await buildTestServer();
    const names = (await harness.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('dismiss_recommendation');
    expect(names).not.toContain('apply_recommendation');
  });
});

describe('capability gating in discovery', () => {
  it('keeps disabled tools discoverable', async () => {
    harness = await buildTestServer({
      config: {
        mutations: {
          enabled: true,
          default: 'deny',
          tools: { pause_campaign: { enabled: true, maxResourcesPerCall: 1 } },
        } as never,
        budgets: undefined,
      },
    });
    const names = (await harness.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('pause_campaign');
    expect(names).toContain('set_campaign_budget');
    expect(names).toContain('enable_campaign');
    expect(names).toHaveLength(30);
  });

  it('the environment kill switch keeps every mutation discoverable', async () => {
    harness = await buildTestServer({ mutationsEnabledEnv: false });
    const names = (await harness.client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(30);
    for (const name of MUTATION_TOOL_NAMES) expect(names).toContain(name);
    for (const name of READ_TOOL_NAMES) expect(names).toContain(name);
  });

  it('the global mutations switch keeps every mutation discoverable', async () => {
    harness = await buildTestServer({
      config: { mutations: { enabled: false, default: 'deny', tools: {} } as never, budgets: undefined },
    });
    const names = (await harness.client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(30);
    for (const name of MUTATION_TOOL_NAMES) expect(names).toContain(name);
    for (const name of READ_TOOL_NAMES) expect(names).toContain(name);
  });

  it('publishes a fixed hard batch limit in the tool schema', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    const schema = tools.find((t) => t.name === 'pause_ad')?.inputSchema as {
      properties?: { ads?: { maxItems?: number } };
    };
    expect(schema.properties?.ads?.maxItems).toBe(100);
  });
});

describe('read-only install contract', () => {
  const customerId = '9876543210';
  const credentials = { GOOGLE_ADS_AUTH_MODE: 'service_account', GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE: 'json',
    GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON: JSON.stringify({ type: 'service_account', client_email: 'svc@example.com', private_key: 'test-key' }),
    GOOGLE_ADS_ALLOWED_CUSTOMER_IDS: customerId };
  const args: Record<string, Record<string, unknown>> = {
    pause_campaign: { campaignId: '1' }, enable_campaign: { campaignId: '1' },
    pause_ad_group: { adGroupId: '1' }, enable_ad_group: { adGroupId: '1' },
    pause_ad: { ads: [{ adGroupId: '1', adId: '2' }] },
    enable_ad: { ads: [{ adGroupId: '1', adId: '2' }] },
    pause_keyword: { keywords: [{ adGroupId: '1', criterionId: '2' }] },
    enable_keyword: { keywords: [{ adGroupId: '1', criterionId: '2' }] },
    add_negative_keyword: { campaignId: '1', keywords: [{ text: 'free', matchType: 'PHRASE' }] },
    remove_negative_keyword: { criteria: [{ resourceName: `customers/${customerId}/campaignCriteria/1~2` }] },
    create_paused_ad: { adGroupId: '1', ads: [{ finalUrls: ['https://example.com'],
      headlines: [{ text: 'First' }, { text: 'Second' }, { text: 'Third' }],
      descriptions: [{ text: 'First description' }, { text: 'Second description' }] }] },
    create_paused_keyword: { adGroupId: '1', keywords: [{ text: 'shoes', matchType: 'EXACT' }] },
    dismiss_recommendation: { recommendationResourceNames: [`customers/${customerId}/recommendations/abc`] },
    update_tracking_parameters: { entityType: 'campaign', campaignId: '1', finalUrlSuffix: 'x=1' },
    set_campaign_budget: { budgetId: '1', amountMicros: '1000000' },
  };

  it('lists all 30 fixed descriptors and audits every disabled mutation without Google Ads calls', async () => {
    const mock = new GoogleAdsMock();
    harness = await buildTestServer({ installSettings: credentials, fetchImpl: mock.fetchImpl });
    const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toHaveLength(30);
    expect(harness.deps.registry.mutationsGloballyEnabled).toBe(false);
    let message: string | undefined;
    for (const name of MUTATION_TOOL_NAMES) {
      const result = await callTool(harness.client, name, { customerId, ...args[name] });
      expect(result.structured.error?.code, name).toBe('TOOL_DISABLED');
      message ??= result.structured.error.message;
      expect(result.structured.error.message, name).toBe(message);
    }
    expect(message).toMatch(/disabled by configuration/);
    expect(harness.auditEvents()).toHaveLength(15);
    expect(harness.auditEvents().every((event) => event.result === 'denied' && event.errorCode === 'TOOL_DISABLED')).toBe(true);
    expect(mock.requests).toHaveLength(0);
    const unauthorized = await callTool(harness.client, 'pause_campaign', { customerId: '7654321098', campaignId: '1' });
    expect(unauthorized.structured.error?.code).toBe('UNAUTHORIZED_CUSTOMER');
    expect(mock.requests).toHaveLength(0);
    mock.onSearch(customerId, { results: [] });
    const read = await callTool(harness.client, 'search_google_ads', {
      customerId, query: 'SELECT campaign.id FROM campaign LIMIT 1',
    });
    expect(read.isError).toBe(false);
    expect(mock.requests).toHaveLength(1);
  });

  it('keeps mutation descriptors identical across read-only and mutation installs', async () => {
    harness = await buildTestServer({ installSettings: credentials });
    const readOnly = (await harness.client.listTools()).tools;
    await harness.close();
    harness = await buildTestServer({ installSettings: { ...credentials,
      GOOGLE_ADS_INSTALL_MODE: 'mutations', GOOGLE_ADS_MASTER_BUDGET_MICROS: '500000000' } });
    const mutations = (await harness.client.listTools()).tools;
    expect(mutations.map(({ name, description, inputSchema, outputSchema }) => ({ name, description, inputSchema, outputSchema })))
      .toEqual(readOnly.map(({ name, description, inputSchema, outputSchema }) => ({ name, description, inputSchema, outputSchema })));
  });
});
