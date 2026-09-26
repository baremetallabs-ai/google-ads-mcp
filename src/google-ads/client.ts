import type { Logger } from '../audit/logger.js';
import { TemporaryFailureError, ToolError } from '../errors/tool-errors.js';
import type { AccessTokenProvider } from './auth.js';
import { mapGoogleAdsHttpError } from './errors.js';
import type {
  CallOptions,
  DismissRequest,
  DismissResponseBody,
  DismissResult,
  GoogleAdsResponseMeta,
  GoogleAdsRow,
  GoogleAdsTransport,
  ListAccessibleCustomersResponseBody,
  MutateRequest,
  MutateResponseBody,
  MutateResult,
  SearchAllResult,
  SearchPage,
  SearchRequestBody,
  SearchResponseBody,
} from './types.js';

export interface GoogleAdsRestClientOptions {
  apiVersion: string;
  developerToken?: string;
  loginCustomerId?: string;
  tokenProvider: AccessTokenProvider;
  defaultTimeoutMs?: number;
  maxPages?: number;
  logger: Logger;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://googleads.googleapis.com';
const MAX_ATTEMPTS = 3;

/**
 * Google Ads REST transport.
 *
 * Talks to the REST interface directly rather than through a wrapper library, for
 * three reasons that the tool contract depends on:
 *
 *  - the `request-id` response header is available on every call, including
 *    successes, which the audit log requires;
 *  - per-call deadlines are expressible via AbortSignal;
 *  - a mutation body is plain JSON, so the operation that is validated can be proven
 *    byte-identical to the operation that is executed.
 */
export class GoogleAdsRestClient implements GoogleAdsTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxPages: number;

  constructor(private readonly options: GoogleAdsRestClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.maxPages = options.maxPages ?? 20;
  }

  private get version(): string {
    return this.options.apiVersion;
  }

  private async headers(includeLoginCustomerId: boolean): Promise<Record<string, string>> {
    const token = await this.options.tokenProvider.getAccessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    if (this.options.developerToken) headers['developer-token'] = this.options.developerToken;
    if (includeLoginCustomerId && this.options.loginCustomerId) {
      headers['login-customer-id'] = this.options.loginCustomerId;
    }
    return headers;
  }

  /**
   * Perform one HTTP call with timeout, retry and request-id capture.
   *
   * `retryable` is false for executing mutations: replaying a mutate after a timeout
   * can apply it twice, and no amount of backoff makes that safe. Idempotent tool
   * behaviour is the retry story instead.
   */
  /**
   * T is the caller's expectation of the response body. The Google Ads REST API
   * returns untyped JSON, so this is an assertion at the boundary rather than a
   * checked conversion; every consumer treats the fields as optional.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  private async request<T>(args: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    includeLoginCustomerId?: boolean;
    validateOnly?: boolean;
    retryable: boolean;
    options?: CallOptions;
  }): Promise<{ body: T | undefined; meta: GoogleAdsResponseMeta }> {
    const timeoutMs = args.options?.timeoutMs ?? this.defaultTimeoutMs;
    let lastError: ToolError | undefined;

    for (let attempt = 1; attempt <= (args.retryable ? MAX_ATTEMPTS : 1); attempt++) {
      const started = Date.now();
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = args.options?.signal
        ? AbortSignal.any([timeoutSignal, args.options.signal])
        : timeoutSignal;

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${args.path}`, {
          method: args.method,
          headers: await this.headers(args.includeLoginCustomerId ?? true),
          ...(args.body !== undefined && { body: JSON.stringify(args.body) }),
          signal,
        });
      } catch (err) {
        // An auth failure is raised while building the headers, inside this try. It is
        // specific and actionable ("check your refresh token"), and retrying cannot fix
        // it, so it must not be flattened into a generic network error.
        if (err instanceof ToolError) throw err;
        const name = err instanceof Error ? err.name : '';
        lastError = new TemporaryFailureError(
          name === 'TimeoutError' || name === 'AbortError'
            ? `Google Ads request timed out after ${timeoutMs}ms.`
            : 'Could not reach the Google Ads API.',
          { path: args.path },
        );
        if (args.retryable && attempt < MAX_ATTEMPTS) {
          await delay(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      const meta: GoogleAdsResponseMeta = {
        ...(response.headers.get('request-id') !== null && {
          requestId: response.headers.get('request-id') as string,
        }),
        httpStatus: response.status,
        durationMs: Date.now() - started,
        method: args.method,
        path: args.path,
        attempt,
      };

      const text = await response.text();
      const parsed: unknown = text.length > 0 ? safeJsonParse(text) : undefined;

      if (response.ok) {
        this.options.logger.debug(
          {
            googleAdsRequestId: meta.requestId,
            path: meta.path,
            httpStatus: meta.httpStatus,
            durationMs: meta.durationMs,
            label: args.options?.label,
          },
          'google_ads_call',
        );
        return { body: parsed as T, meta };
      }

      const retryAfter = response.headers.get('retry-after');
      const toolError = mapGoogleAdsHttpError({
        httpStatus: response.status,
        body: parsed,
        ...(meta.requestId !== undefined && { requestId: meta.requestId }),
        validateOnly: args.validateOnly ?? false,
        managerConfigured: !!this.options.loginCustomerId,
        ...(retryAfter !== null && { retryAfterSeconds: Number(retryAfter) || undefined }),
      });

      const transient = response.status === 429 || response.status >= 500;
      if (args.retryable && transient && attempt < MAX_ATTEMPTS) {
        lastError = toolError;
        await delay(retryAfter !== null ? Number(retryAfter) * 1000 || backoffMs(attempt) : backoffMs(attempt));
        continue;
      }
      throw toolError;
    }

    throw lastError ?? new TemporaryFailureError('Google Ads request failed.');
  }

  async listAccessibleCustomers(
    options?: CallOptions,
  ): Promise<{ customerIds: string[]; meta: GoogleAdsResponseMeta }> {
    const { body, meta } = await this.request<ListAccessibleCustomersResponseBody>({
      method: 'GET',
      path: `/${this.version}/customers:listAccessibleCustomers`,
      // This endpoint is account-agnostic; sending login-customer-id narrows it wrongly.
      includeLoginCustomerId: false,
      retryable: true,
      ...(options !== undefined && { options }),
    });
    const customerIds = (body?.resourceNames ?? []).map((rn) => rn.split('/')[1] ?? '').filter(Boolean);
    return { customerIds, meta };
  }

  async search(
    request: { customerId: string; query: string; pageToken?: string; returnTotalResultsCount?: boolean },
    options?: CallOptions,
  ): Promise<SearchPage> {
    const payload: SearchRequestBody = {
      query: request.query,
      ...(request.pageToken !== undefined && { pageToken: request.pageToken }),
      ...(request.returnTotalResultsCount === true && {
        searchSettings: { returnTotalResultsCount: true },
      }),
    };
    const { body, meta } = await this.request<SearchResponseBody>({
      method: 'POST',
      path: `/${this.version}/customers/${request.customerId}/googleAds:search`,
      body: payload,
      retryable: true,
      ...(options !== undefined && { options }),
    });
    return {
      results: body?.results ?? [],
      ...(body?.nextPageToken !== undefined && { nextPageToken: body.nextPageToken }),
      ...(body?.totalResultsCount !== undefined && { totalResultsCount: body.totalResultsCount }),
      ...(body?.fieldMask !== undefined && { fieldMask: body.fieldMask }),
      meta,
    };
  }

  async searchPaginated(
    request: { customerId: string; query: string; maxRows: number; maxPages?: number },
    options?: CallOptions,
  ): Promise<SearchAllResult> {
    const maxPages = request.maxPages ?? this.maxPages;
    const rows: GoogleAdsRow[] = [];
    const metas: GoogleAdsResponseMeta[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    let truncated = false;

    do {
      const page = await this.search(
        {
          customerId: request.customerId,
          query: request.query,
          ...(pageToken !== undefined && { pageToken }),
        },
        options,
      );
      pages += 1;
      metas.push(page.meta);
      for (const row of page.results) {
        if (rows.length >= request.maxRows) {
          truncated = true;
          break;
        }
        rows.push(row);
      }
      pageToken = page.nextPageToken;
      if (rows.length >= request.maxRows) {
        if (pageToken !== undefined) truncated = true;
        break;
      }
      if (pages >= maxPages && pageToken !== undefined) {
        truncated = true;
        break;
      }
    } while (pageToken !== undefined);

    return { rows, pages, truncated, metas };
  }

  async mutate(request: MutateRequest, options?: CallOptions): Promise<MutateResult> {
    const { body, meta } = await this.request<MutateResponseBody>({
      method: 'POST',
      path: `/${this.version}/customers/${request.customerId}/googleAds:mutate`,
      body: {
        mutateOperations: request.mutateOperations,
        validateOnly: request.validateOnly,
        partialFailure: request.partialFailure,
        ...(request.responseContentType !== undefined && {
          responseContentType: request.responseContentType,
        }),
      },
      validateOnly: request.validateOnly,
      // Never replay an executing mutate. A retry after a timeout can double-apply it.
      retryable: request.validateOnly,
      ...(options !== undefined && { options }),
    });
    return { mutateOperationResponses: body?.mutateOperationResponses ?? [], meta };
  }

  async dismissRecommendation(
    request: DismissRequest,
    options?: CallOptions,
  ): Promise<DismissResult> {
    const { body, meta } = await this.request<DismissResponseBody>({
      method: 'POST',
      path: `/${this.version}/customers/${request.customerId}/recommendations:dismiss`,
      body: { operations: request.operations, partialFailure: request.partialFailure },
      retryable: false,
      ...(options !== undefined && { options }),
    });
    return { results: body?.results ?? [], meta };
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: 'Google Ads returned a non-JSON response.' } };
  }
}

function backoffMs(attempt: number): number {
  const base = 250 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 100);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
