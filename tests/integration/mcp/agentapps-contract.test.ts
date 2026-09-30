import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ServerManifestSchema, matchesDeclaredTools } from '../../helpers/agentapps-contract.js';

const manifest = JSON.parse(readFileSync('server.json', 'utf8')) as Record<string, unknown>;
const profile = (manifest._meta as Record<string, unknown>)['ai.baremetal/agentapps'] as { tools: unknown[] };
const catalog = (manifest._meta as Record<string, unknown>)['ai.baremetal/agentapps'] as {
  environmentVariables: { name: string }[]; egress: string[];
};
const denoAvailable = !spawnSync('deno', ['--version'], { encoding: 'utf8' }).error;
const customerId = '9876543210';
const serviceKey = JSON.stringify({ type: 'service_account', client_email: 'svc@example.iam.gserviceaccount.com',
  private_key: 'FAKE-PRIVATE-KEY-FOR-LOOPBACK-TEST' });
const base = { GOOGLE_ADS_ALLOWED_CUSTOMER_IDS: customerId, GOOGLE_ADS_AUTH_MODE: 'service_account',
  GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE: 'json', GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON: serviceKey };
const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => { resolve(); }))));
});

async function listen(handler: RequestListener): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port');
  return { server, port: address.port };
}

async function unusedPort(): Promise<number> {
  const { server, port } = await listen((_req, res) => res.end());
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  servers.splice(servers.indexOf(server), 1);
  return port;
}

async function start(settings: Record<string, string>): Promise<{ child: ChildProcess; url: URL; stderr: () => string }> {
  const port = await unusedPort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GOOGLE_ADS_')));
  const allowedEnv = [...catalog.environmentVariables.map(({ name }) => name), 'NODE_ENV', 'GOOGLE_ADS_MCP_TEST_TOKEN_ENDPOINT'];
  const tokenPort = settings.GOOGLE_ADS_MCP_TEST_TOKEN_ENDPOINT
    ? new URL(settings.GOOGLE_ADS_MCP_TEST_TOKEN_ENDPOINT).port : undefined;
  const allowedNet = [`127.0.0.1:${port}`, ...catalog.egress, ...(tokenPort ? [`127.0.0.1:${tokenPort}`] : [])];
  const child = spawn('deno', ['serve', '--no-prompt', `--allow-read=${process.cwd()}`,
    `--allow-env=${allowedEnv.join(',')}`, `--allow-net=${allowedNet.join(',')}`,
    '--host', '127.0.0.1', '--port', String(port), 'agentapps/main.mjs'],
    { env: { ...env, ...settings }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`AgentApps process exited before readiness: ${errors}`);
    try {
      const response = await fetch(new URL('/not-found', url));
      if (response.status === 404) return { child, url, stderr: () => errors };
    } catch { /* keep polling while Deno starts */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`AgentApps process did not become ready: ${errors}`);
}

describe('private AgentApps configured-start contract', () => {
  it('bundles no request-time proxy env reads that restricted Deno would deny', () => {
    // The loopback token test below bypasses gaxios, so guard the real token path statically.
    const bundle = readFileSync('agentapps/main.mjs', 'utf8');
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
      expect(bundle).not.toMatch(new RegExp(`process\\??\\.env\\??\\.${name}\\b`));
    }
  });
  it('validates the self-contained pinned module manifest and all 30 declarations', () => {
    expect(() => ServerManifestSchema.parse(manifest)).not.toThrow();
    expect(profile.tools).toHaveLength(30);
  });

  describe.skipIf(!denoAvailable)('Deno configured starts', () => {
    it.each([
      ['read-only service account without developer token', { ...base }],
      ['mutation service account with developer token', { ...base, GOOGLE_ADS_INSTALL_MODE: 'mutations',
        GOOGLE_ADS_MASTER_BUDGET_MICROS: '500000000', GOOGLE_ADS_DEVELOPER_TOKEN: 'test-token' }],
      ['read-only OAuth with developer token', { GOOGLE_ADS_ALLOWED_CUSTOMER_IDS: customerId,
        GOOGLE_ADS_AUTH_MODE: 'user', GOOGLE_ADS_CLIENT_ID: 'client-id', GOOGLE_ADS_CLIENT_SECRET: 'test-secret',
        GOOGLE_ADS_REFRESH_TOKEN: 'test-refresh', GOOGLE_ADS_LOGIN_CUSTOMER_ID: customerId,
        GOOGLE_ADS_DEVELOPER_TOKEN: 'test-token' }],
      ['mutation OAuth without developer token', { GOOGLE_ADS_ALLOWED_CUSTOMER_IDS: customerId,
        GOOGLE_ADS_INSTALL_MODE: 'mutations', GOOGLE_ADS_MASTER_BUDGET_MICROS: '500000000',
        GOOGLE_ADS_AUTH_MODE: 'user', GOOGLE_ADS_CLIENT_ID: 'client-id', GOOGLE_ADS_CLIENT_SECRET: 'test-secret',
        GOOGLE_ADS_REFRESH_TOKEN: 'test-refresh', GOOGLE_ADS_LOGIN_CUSTOMER_ID: customerId }],
    ])('%s discovers the exact contract after simulated token exchange', async (_name, settings) => {
      let tokenRequests = 0;
      const token = await listen((_req, res) => {
        tokenRequests++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: 'loopback-test-token' }));
      });
      const processServer = await start({ ...settings, NODE_ENV: 'test',
        GOOGLE_ADS_MCP_TEST_TOKEN_ENDPOINT: `http://127.0.0.1:${token.port}/token` });
      const client = new Client({ name: 'agentapps-qualification', version: '1.0.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(processServer.url));
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(30);
        expect(matchesDeclaredTools(profile.tools, tools)).toBe(true);
        expect(tokenRequests).toBeGreaterThan(0);
        expect(processServer.stderr()).not.toContain('FAKE-PRIVATE-KEY');
      } finally {
        await client.close();
      }
    });

    it('fails closed on placeholder settings before serving tools', async () => {
      const secret = 'PLACEHOLDER-PRIVATE-SECRET';
      const invalid = { ...base, GOOGLE_ADS_ALLOWED_CUSTOMER_IDS: '1234567890',
        GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON: serviceKey.replace('FAKE-PRIVATE-KEY-FOR-LOOPBACK-TEST', secret) };
      try {
        await start(invalid);
        throw new Error('Placeholder settings unexpectedly started');
      } catch (error) {
        expect((error as Error).message).toContain('GOOGLE_ADS_ALLOWED_CUSTOMER_IDS');
        expect((error as Error).message).not.toContain(secret);
      }
    });
  });
});
