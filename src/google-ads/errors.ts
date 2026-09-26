import {
  GoogleAdsApiError,
  RateLimitedError,
  TemporaryFailureError,
  ValidationFailedError,
  ToolError,
  InvalidArgumentError,
} from '../errors/tool-errors.js';

/**
 * A Google Ads API error, reduced to the fields that help a caller fix the problem.
 *
 * Nothing else from the raw response body is retained: upstream payloads can echo
 * request content and are not safe to hand back unfiltered.
 */
export interface SanitizedGoogleAdsError {
  errorCode: string;
  message: string;
  fieldPath?: string;
  operationIndex?: number;
  trigger?: string | number | boolean;
}

interface RawGoogleAdsError {
  errorCode?: Record<string, unknown>;
  message?: string;
  trigger?: { stringValue?: string; int64Value?: string; booleanValue?: boolean };
  location?: { fieldPathElements?: { fieldName?: string; index?: number }[] };
}

interface RawErrorBody {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: {
      '@type'?: string;
      errors?: RawGoogleAdsError[];
      requestId?: string;
    }[];
  };
}

/**
 * Flatten Google's one-key errorCode object.
 *
 * `{ "criterionError": "CRITERION_ALREADY_EXISTS" }` becomes
 * `"criterionError.CRITERION_ALREADY_EXISTS"`.
 */
function flattenErrorCode(errorCode: Record<string, unknown> | undefined): string {
  if (!errorCode) return 'UNKNOWN';
  const entry = Object.entries(errorCode)[0];
  if (!entry) return 'UNKNOWN';
  const [key, value] = entry;
  return typeof value === 'string' ? `${key}.${value}` : key;
}

function buildFieldPath(location: RawGoogleAdsError['location']): string | undefined {
  const elements = location?.fieldPathElements;
  if (!elements || elements.length === 0) return undefined;
  return elements
    .map((el) => (el.index === undefined ? (el.fieldName ?? '?') : `${el.fieldName ?? '?'}[${el.index}]`))
    .join('.');
}

function extractOperationIndex(location: RawGoogleAdsError['location']): number | undefined {
  const first = location?.fieldPathElements?.[0];
  if (first?.fieldName === 'operations' || first?.fieldName === 'mutate_operations') {
    return first.index;
  }
  return undefined;
}

export function sanitizeGoogleAdsErrors(body: unknown): SanitizedGoogleAdsError[] {
  const parsed = body as RawErrorBody | undefined;
  const details = parsed?.error?.details ?? [];
  const out: SanitizedGoogleAdsError[] = [];
  for (const detail of details) {
    for (const raw of detail.errors ?? []) {
      const trigger =
        raw.trigger?.stringValue ??
        raw.trigger?.int64Value ??
        raw.trigger?.booleanValue;
      out.push({
        errorCode: flattenErrorCode(raw.errorCode),
        message: raw.message ?? 'Google Ads returned an error without a message.',
        ...(buildFieldPath(raw.location) !== undefined && { fieldPath: buildFieldPath(raw.location) }),
        ...(extractOperationIndex(raw.location) !== undefined && {
          operationIndex: extractOperationIndex(raw.location),
        }),
        ...(trigger !== undefined && { trigger }),
      });
    }
  }
  return out;
}

/** Request ID from the GoogleAdsFailure detail, used when the header is missing. */
export function extractRequestIdFromBody(body: unknown): string | undefined {
  const parsed = body as RawErrorBody | undefined;
  for (const detail of parsed?.error?.details ?? []) {
    if (typeof detail.requestId === 'string') return detail.requestId;
  }
  return undefined;
}

function summarize(errors: SanitizedGoogleAdsError[], fallback: string): string {
  if (errors.length === 0) return fallback;
  const first = errors[0];
  if (!first) return fallback;
  const extra = errors.length > 1 ? ` (and ${errors.length - 1} more)` : '';
  return `${first.message}${extra}`;
}

export interface MapErrorInput {
  httpStatus: number;
  body: unknown;
  requestId?: string;
  validateOnly: boolean;
  retryAfterSeconds?: number;
  managerConfigured?: boolean;
}

/**
 * Map an HTTP error response into a sanitized tool error.
 *
 * A failure during the validate_only pass is a VALIDATION_FAILED, not a
 * GOOGLE_ADS_API_ERROR: it means the operation was rejected before anything changed.
 */
export function mapGoogleAdsHttpError(input: MapErrorInput): ToolError {
  const { httpStatus, body, validateOnly } = input;
  const errors = sanitizeGoogleAdsErrors(body);
  const requestId = input.requestId ?? extractRequestIdFromBody(body);
  const base: Record<string, unknown> = {
    ...(requestId !== undefined && { googleAdsRequestId: requestId }),
    httpStatus,
    ...(errors.length > 0 && { errors }),
  };

  if (httpStatus === 429) {
    return new RateLimitedError(
      summarize(errors, 'Google Ads rate limit or quota exceeded. Retry after a delay.'),
      { ...base, ...(input.retryAfterSeconds !== undefined && { retryAfterSeconds: input.retryAfterSeconds }) },
    );
  }

  // Quota errors can also surface as 400 with a RESOURCE_EXHAUSTED status.
  const status = (body as RawErrorBody | undefined)?.error?.status;
  if (status === 'RESOURCE_EXHAUSTED') {
    return new RateLimitedError(summarize(errors, 'Google Ads quota exhausted.'), base);
  }

  if (httpStatus >= 500 || status === 'UNAVAILABLE' || status === 'DEADLINE_EXCEEDED') {
    return new TemporaryFailureError(
      summarize(errors, `Google Ads returned a transient error (HTTP ${httpStatus}).`),
      base,
    );
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return new GoogleAdsApiError(
      'Google Ads API rejected account access. Check the service account or user access on the target account, ' +
        'its Read only versus Standard role for this operation.' +
        (input.managerConfigured ? ' Check the manager account link and access.' : ''),
      { ...(requestId !== undefined && { googleAdsRequestId: requestId }), httpStatus },
    );
  }

  if (validateOnly) {
    return new ValidationFailedError(
      summarize(errors, 'Google Ads rejected the operation during validation.'),
      base,
    );
  }

  return new GoogleAdsApiError(
    summarize(errors, `Google Ads returned an error (HTTP ${httpStatus}).`),
    base,
  );
}

/** Normalize any thrown value into a ToolError, never leaking internals. */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof Error && err.name === 'ZodError') {
    return new InvalidArgumentError('Input failed schema validation.', {});
  }
  return new TemporaryFailureError('An unexpected internal error occurred.');
}
