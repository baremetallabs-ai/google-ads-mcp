/**
 * Wire types for the Google Ads REST API.
 *
 * REST responses are lowerCamelCase; GAQL queries are snake_case. int64 fields
 * (IDs, *_micros) arrive as JSON strings and must never be coerced to Number.
 */

/** A GAQL result row. Shape depends on the SELECT clause, so it is loosely typed. */
export type GoogleAdsRow = Record<string, any>;

export interface SearchRequestBody {
  query: string;
  pageToken?: string;
  searchSettings?: {
    returnTotalResultsCount?: boolean;
    returnSummaryRow?: boolean;
    omitResults?: boolean;
  };
}

export interface SearchResponseBody {
  results?: GoogleAdsRow[];
  nextPageToken?: string;
  totalResultsCount?: string;
  fieldMask?: string;
}

/**
 * One entry in a googleAds:mutate request.
 *
 * Exactly one of the *Operation keys is set. Values are plain JSON built by the
 * mutation modules and frozen before validation.
 */
export interface MutateOperation {
  readonly campaignOperation?: Readonly<Record<string, unknown>>;
  readonly campaignBudgetOperation?: Readonly<Record<string, unknown>>;
  readonly campaignCriterionOperation?: Readonly<Record<string, unknown>>;
  readonly adGroupOperation?: Readonly<Record<string, unknown>>;
  readonly adGroupAdOperation?: Readonly<Record<string, unknown>>;
  readonly adGroupCriterionOperation?: Readonly<Record<string, unknown>>;
  readonly adOperation?: Readonly<Record<string, unknown>>;
}

export interface MutateOperationResponse {
  campaignResult?: { resourceName?: string };
  campaignBudgetResult?: { resourceName?: string };
  campaignCriterionResult?: { resourceName?: string; campaignCriterion?: GoogleAdsRow };
  adGroupResult?: { resourceName?: string };
  adGroupAdResult?: { resourceName?: string; adGroupAd?: GoogleAdsRow };
  adGroupCriterionResult?: { resourceName?: string; adGroupCriterion?: GoogleAdsRow };
  adResult?: { resourceName?: string };
}

export interface MutateResponseBody {
  mutateOperationResponses?: MutateOperationResponse[];
  partialFailureError?: unknown;
}

export interface ListAccessibleCustomersResponseBody {
  resourceNames?: string[];
}

export interface DismissResponseBody {
  results?: { recommendation?: string }[];
  partialFailureError?: unknown;
}

/** Metadata captured from every HTTP call, including the Google Ads request ID. */
export interface GoogleAdsResponseMeta {
  requestId?: string;
  httpStatus: number;
  durationMs: number;
  method: 'GET' | 'POST';
  /** Path only - never carries credentials. */
  path: string;
  attempt: number;
}

export interface SearchPage {
  results: GoogleAdsRow[];
  nextPageToken?: string;
  totalResultsCount?: string;
  fieldMask?: string;
  meta: GoogleAdsResponseMeta;
}

export interface SearchAllResult {
  rows: GoogleAdsRow[];
  pages: number;
  truncated: boolean;
  metas: GoogleAdsResponseMeta[];
}

export interface MutateRequest {
  customerId: string;
  mutateOperations: readonly MutateOperation[];
  validateOnly: boolean;
  /**
   * Literal `false`. Interdependent operations must not partially succeed, so the
   * type system forbids ever passing true.
   */
  partialFailure: false;
  responseContentType?: 'RESOURCE_NAME_ONLY' | 'MUTABLE_RESOURCE';
}

export interface MutateResult {
  mutateOperationResponses: MutateOperationResponse[];
  meta: GoogleAdsResponseMeta;
}

export interface DismissRequest {
  customerId: string;
  operations: readonly { resourceName: string }[];
  partialFailure: false;
}

export interface DismissResult {
  results: { recommendation?: string }[];
  meta: GoogleAdsResponseMeta;
}

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  label?: string;
}

export interface GoogleAdsTransport {
  listAccessibleCustomers(
    options?: CallOptions,
  ): Promise<{ customerIds: string[]; meta: GoogleAdsResponseMeta }>;

  search(
    request: { customerId: string; query: string; pageToken?: string; returnTotalResultsCount?: boolean },
    options?: CallOptions,
  ): Promise<SearchPage>;

  searchPaginated(
    request: { customerId: string; query: string; maxRows: number; maxPages?: number },
    options?: CallOptions,
  ): Promise<SearchAllResult>;

  mutate(request: MutateRequest, options?: CallOptions): Promise<MutateResult>;

  dismissRecommendation(request: DismissRequest, options?: CallOptions): Promise<DismissResult>;
}
