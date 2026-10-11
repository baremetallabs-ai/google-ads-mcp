import { Client, InMemoryTransport, type ClientOptions } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { PassThrough } from 'node:stream';
import { createAuditLogger, createLogger, type AuditEvent } from '../../src/audit/logger.js';
import { CustomerAllowlist } from '../../src/authorization/customer-allowlist.js';
import { CapabilityRegistry } from '../../src/capabilities/registry.js';
import type { AppConfig } from '../../src/capabilities/schema.js';
import { loadEnv } from '../../src/config/env.js';
import { loadInstallConfig } from '../../src/config/load-config.js';
import { StaticAccessTokenProvider, type AccessTokenProvider } from '../../src/google-ads/auth.js';
import { GoogleAdsRestClient } from '../../src/google-ads/client.js';
import { buildToolSet, type ToolSet } from '../../src/mcp/register-tools.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { Deps } from '../../src/types/index.js';
import { buildConfig } from './build-config.js';
import { API_VERSION } from './mock-google-ads.js';

export const TEST_CUSTOMER_ID = '1234567890';
export const TEST_LOGIN_CUSTOMER_ID = '9876543210';
export const TEST_DEVELOPER_TOKEN = 'test-developer-token-value';

/** The protocol revision the AgentApps cell pins; test clients negotiate it the same way. */
export const MODERN_PROTOCOL_REVISION = '2026-07-28';

export type ProtocolEraChoice = 'modern' | 'legacy';

/** A 2.x client in the requested era: modern pins 2026-07-28 with no fallback, as the cell does. */
export function createTestClient(name = 'test-client', era: ProtocolEraChoice = 'modern'): Client {
  const options: ClientOptions = era === 'modern'
    ? { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_REVISION } } }
    : {};
  return new Client({ name, version: '1.0.0' }, options);
}

/**
 * Connect a client to servers built from the shared tool set, over an in-memory pair.
 * The server side goes through serveStdio, which owns era selection exactly as the
 * stdio entry does, so a modern client gets server/discover and a legacy one initialize.
 */
export async function connectInMemory(
  deps: Deps,
  tools: ToolSet,
  client: Client,
): Promise<{ close(): Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const connection = serveStdio(() => createMcpServer(deps, tools).server, { transport: serverTransport });
  await client.connect(clientTransport);
  return {
    close: async () => {
      await client.close();
      await connection.close();
    },
  };
}

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
    installSettings?: NodeJS.ProcessEnv;
    mutationsEnabledEnv?: boolean;
    transport?: Partial<Deps['transport']>;
    /** Route HTTP through a GoogleAdsMock. See GoogleAdsMock.fetchImpl. */
    fetchImpl?: typeof fetch;
    developerToken?: string | null;
    loginCustomerId?: string | null;
    tokenProvider?: AccessTokenProvider;
    /** Protocol era the harness client negotiates. Defaults to modern, as the AgentApps cell. */
    era?: ProtocolEraChoice;
  } = {},
): Promise<TestHarness> {
  const installEnv = options.installSettings ? loadEnv(options.installSettings) : undefined;
  const config = installEnv ? loadInstallConfig(installEnv) : buildConfig(options.config);

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
    ...(options.developerToken !== null && { developerToken: options.developerToken ?? TEST_DEVELOPER_TOKEN }),
    ...(options.loginCustomerId !== null && { loginCustomerId: options.loginCustomerId ?? TEST_LOGIN_CUSTOMER_ID }),
    tokenProvider: options.tokenProvider ?? new StaticAccessTokenProvider('test-access-token'),
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
    registry: new CapabilityRegistry(config, options.mutationsEnabledEnv ?? true,
      installEnv?.GOOGLE_ADS_INSTALL_MODE === 'read_only'),
    allowlist: new CustomerAllowlist(config.accounts.allowedCustomerIds),
    transport,
    logger,
    audit: createAuditLogger(logger),
  };

  const client = createTestClient('test-client', options.era);
  const connection = await connectInMemory(deps, buildToolSet(deps), client);

  return {
    client,
    deps,
    logs,
    auditEvents: () =>
      logs.filter((l) => l.audit === true && l.msg === 'mutation_attempt') as unknown as AuditEvent[],
    close: () => connection.close(),
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
