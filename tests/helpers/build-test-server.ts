import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PassThrough } from 'node:stream';
import { createAuditLogger, createLogger, type AuditEvent } from '../../src/audit/logger.js';
import { CustomerAllowlist } from '../../src/authorization/customer-allowlist.js';
import { CapabilityRegistry } from '../../src/capabilities/registry.js';
import type { AppConfig } from '../../src/capabilities/schema.js';
import { StaticAccessTokenProvider } from '../../src/google-ads/auth.js';
import { GoogleAdsRestClient } from '../../src/google-ads/client.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { Deps } from '../../src/types/index.js';
import { buildConfig } from './build-config.js';
import { API_VERSION } from './mock-google-ads.js';

export const TEST_CUSTOMER_ID = '1234567890';
export const TEST_LOGIN_CUSTOMER_ID = '9876543210';
export const TEST_DEVELOPER_TOKEN = 'test-developer-token-value';

export interface TestHarness {
  client: Client;
  deps: Deps;
  /** Every structured log line emitted, parsed. */
  logs: Record<string, unknown>[];
  /** Audit events only. */
  auditEvents(): AuditEvent[];
  close(): Promise<void>;
}

export async function buildTestServer(
  options: {
    config?: Partial<AppConfig>;
    mutationsEnabledEnv?: boolean;
    transport?: Partial<Deps['transport']>;
    /** Route HTTP through a GoogleAdsMock. See GoogleAdsMock.fetchImpl. */
    fetchImpl?: typeof fetch;
  } = {},
): Promise<TestHarness> {
  const config = buildConfig(options.config);

  const logs: Record<string, unknown>[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Ignore non-JSON output.
      }
    }
  });

  const logger = createLogger({
    level: 'debug',
    destination: stream,
    secrets: [TEST_DEVELOPER_TOKEN, 'test-client-secret', 'test-refresh-token'],
  });

  const realTransport = new GoogleAdsRestClient({
    apiVersion: API_VERSION,
    developerToken: TEST_DEVELOPER_TOKEN,
    loginCustomerId: TEST_LOGIN_CUSTOMER_ID,
    tokenProvider: new StaticAccessTokenProvider('test-access-token'),
    logger,
    maxPages: config.reads.maxPages,
    ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
  });

  // Overriding individual methods must not lose the client's prototype, so partial
  // overrides are layered onto an object that still inherits from it.
  const transport: Deps['transport'] = options.transport
    ? (Object.assign(
        Object.create(Object.getPrototypeOf(realTransport) as object),
        realTransport,
        options.transport,
      ) as Deps['transport'])
    : realTransport;

  const deps: Deps = {
    config,
    registry: new CapabilityRegistry(config, options.mutationsEnabledEnv ?? true),
    allowlist: new CustomerAllowlist(config.accounts.allowedCustomerIds),
    transport,
    logger,
    audit: createAuditLogger(logger),
  };

  const { server } = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    deps,
    logs,
    auditEvents: () =>
      logs.filter((l) => l.audit === true && l.msg === 'mutation_attempt') as unknown as AuditEvent[],
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Call a tool and return its structured content. */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ structured: Record<string, any>; isError: boolean; text: string }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    structuredContent?: Record<string, unknown>;
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  return {
    structured: (result.structuredContent ?? {}) as Record<string, any>,
    isError: result.isError === true,
    text: result.content?.[0]?.text ?? '',
  };
}
