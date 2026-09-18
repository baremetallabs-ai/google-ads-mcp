import { MockAgent, setGlobalDispatcher, fetch as undiciFetch } from 'undici';
import type { MockInterceptor } from 'undici/types/mock-interceptor.js';

export const GOOGLE_ADS_ORIGIN = 'https://googleads.googleapis.com';
export const API_VERSION = 'v25';

export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  /** Raw body text, so tests can compare two requests byte for byte. */
  rawBody: string;
}

/**
 * HTTP-level mock for the Google Ads REST API.
 *
 * Intercepting at the HTTP layer rather than stubbing a client object is what lets
 * tests assert on the exact JSON body sent to Google - including proving the
 * validate_only request and the execute request are byte-identical apart from the
 * validateOnly flag.
 */
export class GoogleAdsMock {
  readonly requests: CapturedRequest[] = [];
  private readonly agent: MockAgent;
  private readonly pool: ReturnType<MockAgent['get']>;

  constructor() {
    this.agent = new MockAgent();
    this.agent.disableNetConnect();
    setGlobalDispatcher(this.agent);
    this.pool = this.agent.get(GOOGLE_ADS_ORIGIN);
  }

  /**
   * The fetch implementation to hand the client under test.
   *
   * Node's built-in `fetch` is backed by its own bundled copy of undici, which the
   * npm package's `setGlobalDispatcher` does not reach. Injecting undici's own
   * `fetch` is what actually routes requests through this mock; without it the tests
   * would silently hit the real Google Ads API.
   */
  get fetchImpl(): typeof fetch {
    return undiciFetch as unknown as typeof fetch;
  }

  private capture(method: string, path: string, opts: { headers?: unknown; body?: unknown }): void {
    const rawBody = typeof opts.body === 'string' ? opts.body : '';
    this.requests.push({
      method,
      path,
      headers: (opts.headers ?? {}) as Record<string, string>,
      body: rawBody.length > 0 ? JSON.parse(rawBody) : undefined,
      rawBody,
    });
  }

  /** Queue one googleAds:search response. */
  onSearch(
    customerId: string,
    response: { results?: unknown[]; nextPageToken?: string; totalResultsCount?: string; fieldMask?: string },
    options: { times?: number; requestId?: string } = {},
  ): this {
    const path = `/${API_VERSION}/customers/${customerId}/googleAds:search`;
    this.pool
      .intercept({ path, method: 'POST' })
      .reply(
        200,
        (opts: MockInterceptor.MockResponseCallbackOptions) => {
          this.capture('POST', path, opts);
          return response;
        },
        { headers: { 'request-id': options.requestId ?? 'req-search' } },
      )
      .times(options.times ?? 1);
    return this;
  }

  /** Queue a googleAds:search failure. */
  onSearchError(
    customerId: string,
    status: number,
    body: unknown,
    options: { times?: number; requestId?: string } = {},
  ): this {
    const path = `/${API_VERSION}/customers/${customerId}/googleAds:search`;
    this.pool
      .intercept({ path, method: 'POST' })
      .reply(
        status,
        (opts: MockInterceptor.MockResponseCallbackOptions) => {
          this.capture('POST', path, opts);
          return body;
        },
        { headers: { 'request-id': options.requestId ?? 'req-search-err' } },
      )
      .times(options.times ?? 1);
    return this;
  }

  /** Queue one googleAds:mutate response. */
  onMutate(
    customerId: string,
    response: { mutateOperationResponses?: unknown[] } = { mutateOperationResponses: [] },
    options: { times?: number; requestId?: string } = {},
  ): this {
    const path = `/${API_VERSION}/customers/${customerId}/googleAds:mutate`;
    this.pool
      .intercept({ path, method: 'POST' })
      .reply(
        200,
        (opts: MockInterceptor.MockResponseCallbackOptions) => {
          this.capture('POST', path, opts);
          return response;
        },
        { headers: { 'request-id': options.requestId ?? 'req-mutate' } },
      )
      .times(options.times ?? 1);
    return this;
  }

  /** Queue a googleAds:mutate failure. */
  onMutateError(
    customerId: string,
    status: number,
    body: unknown,
    options: { times?: number; requestId?: string; headers?: Record<string, string> } = {},
  ): this {
    const path = `/${API_VERSION}/customers/${customerId}/googleAds:mutate`;
    this.pool
      .intercept({ path, method: 'POST' })
      .reply(
        status,
        (opts: MockInterceptor.MockResponseCallbackOptions) => {
          this.capture('POST', path, opts);
          return body;
        },
        { headers: { 'request-id': options.requestId ?? 'req-err', ...options.headers } },
      )
      .times(options.times ?? 1);
    return this;
  }

  onDismiss(
    customerId: string,
    response: unknown = { results: [] },
    options: { times?: number; requestId?: string } = {},
  ): this {
    const path = `/${API_VERSION}/customers/${customerId}/recommendations:dismiss`;
    this.pool
      .intercept({ path, method: 'POST' })
      .reply(
        200,
        (opts: MockInterceptor.MockResponseCallbackOptions) => {
          this.capture('POST', path, opts);
          return response;
        },
        { headers: { 'request-id': options.requestId ?? 'req-dismiss' } },
      )
      .times(options.times ?? 1);
    return this;
  }

  onListAccessibleCustomers(resourceNames: string[], options: { times?: number } = {}): this {
    const path = `/${API_VERSION}/customers:listAccessibleCustomers`;
    this.pool
      .intercept({ path, method: 'GET' })
      .reply(
        200,
        (opts: MockInterceptor.MockResponseCallbackOptions) => {
          this.capture('GET', path, opts);
          return { resourceNames };
        },
        { headers: { 'request-id': 'req-list' } },
      )
      .times(options.times ?? 1);
    return this;
  }

  /** Every mutate request captured, in order. */
  mutateRequests(): CapturedRequest[] {
    return this.requests.filter((r) => r.path.endsWith(':mutate'));
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}

/** A GAQL search response row set. */
export function searchResponse(results: unknown[], extra: Record<string, unknown> = {}) {
  return { results, ...extra };
}
