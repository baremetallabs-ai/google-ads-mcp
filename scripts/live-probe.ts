/**
 * Live read-only verification harness.
 *
 * Spawns the built server over real stdio, runs read tools against a live account,
 * and prints a summary. Read-only: it never calls a mutation tool.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';

const env: Record<string, string> = {};
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2];
}

const customerId = process.argv[2];
if (!customerId) {
  console.error(
    'Usage: npm run verify-live -- <customerId>\n\n' +
      'The customer ID must be present in your capability configuration allowlist.',
  );
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...(process.env as Record<string, string>), ...env },
  stderr: 'pipe',
});
const client = new Client({ name: 'live-probe', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`\ntools/list -> ${String(tools.length)} tools (mutations disabled for this probe)\n`);

async function run(name: string, args: Record<string, unknown>): Promise<void> {
  try {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, any>;
      content?: { text?: string }[];
    };
    const text = r.content?.[0]?.text ?? '';
    if (r.isError) {
      console.log(`  ✗ ${name}\n      ${text.slice(0, 200)}`);
    } else {
      console.log(`  ✓ ${name}\n      ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.log(`  ✗ ${name} threw: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
  }
}

console.log('--- read tools against', customerId, '---');
await run('list_accessible_accounts', {});
await run('get_account_summary', { customerId, datePreset: 'LAST_30_DAYS' });
await run('list_campaigns', { customerId });
await run('get_campaign_performance', { customerId, datePreset: 'LAST_30_DAYS' });
await run('get_ad_group_performance', { customerId, datePreset: 'LAST_30_DAYS' });
await run('get_keyword_performance', { customerId, datePreset: 'LAST_30_DAYS', limit: 10 });
await run('get_search_terms', { customerId, datePreset: 'LAST_30_DAYS', limit: 10 });
await run('list_negative_keywords', { customerId });
await run('list_recommendations', { customerId });
await run('get_conversion_actions', { customerId });
await run('get_bidding_strategy_status', { customerId });
await run('get_budget_pacing', { customerId });
await run('get_change_history', { customerId, limit: 10 });
await run('search_google_ads', { customerId, query: 'SELECT campaign.id, campaign.name FROM campaign', limit: 5 });

console.log('\n--- negative controls ---');
await run('get_account_summary', { customerId: '1234567890' });
await run('search_google_ads', { customerId, query: 'SELECT billing_setup.id FROM billing_setup' });
await run('search_google_ads', { customerId, query: 'SELECT campaign.id FROM campaign; DROP TABLE x' });

await client.close();
