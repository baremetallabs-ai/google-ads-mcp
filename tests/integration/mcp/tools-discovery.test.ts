import { describe, it, expect, afterEach } from 'vitest';
import {
  MUTATION_TOOL_NAMES,
  PROHIBITED_TOOL_NAMES,
  READ_TOOL_NAMES,
} from '../../../src/capabilities/tool-names.js';
import { buildTestServer, type TestHarness } from '../../helpers/build-test-server.js';

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
  it('omits a disabled tool entirely', async () => {
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
    expect(names).not.toContain('set_campaign_budget');
    expect(names).not.toContain('enable_campaign');
    expect(names).toHaveLength(16); // 15 reads + 1 mutation
  });

  it('the environment kill switch removes every mutation but keeps reads', async () => {
    harness = await buildTestServer({ mutationsEnabledEnv: false });
    const names = (await harness.client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(15);
    for (const name of MUTATION_TOOL_NAMES) expect(names).not.toContain(name);
    for (const name of READ_TOOL_NAMES) expect(names).toContain(name);
  });

  it('the global mutations switch removes every mutation but keeps reads', async () => {
    harness = await buildTestServer({
      config: { mutations: { enabled: false, default: 'deny', tools: {} } as never, budgets: undefined },
    });
    const names = (await harness.client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(15);
    for (const name of READ_TOOL_NAMES) expect(names).toContain(name);
  });

  it('publishes the configured batch limit in the tool schema', async () => {
    harness = await buildTestServer();
    const { tools } = await harness.client.listTools();
    const schema = tools.find((t) => t.name === 'pause_ad')?.inputSchema as {
      properties?: { ads?: { maxItems?: number } };
    };
    // Advertised limit must match the enforced policy value.
    expect(schema.properties?.ads?.maxItems).toBe(10);
  });
});
