/**
 * Stable, structured tool error codes.
 *
 * These strings are part of the tool contract: clients may branch on them, so they
 * must not change. Every error returned to an MCP client maps onto exactly one.
 */
export const TOOL_ERROR_CODES = [
  'UNAUTHORIZED_CUSTOMER',
  'TOOL_DISABLED',
  'INVALID_ARGUMENT',
  'RESOURCE_NOT_FOUND',
  'STALE_RESOURCE_STATE',
  'UNSUPPORTED_RESOURCE_STATE',
  'TOOL_CONSTRAINT_VIOLATION',
  'MAX_OPERATIONS_EXCEEDED',
  'DUPLICATE_RESOURCE',
  'VALIDATION_FAILED',
  'GOOGLE_ADS_API_ERROR',
  'RATE_LIMITED',
  'TEMPORARY_FAILURE',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolErrorEnvelope {
  code: ToolErrorCode;
  message: string;
  details: Readonly<Record<string, unknown>>;
}

/**
 * Base class for every error that can reach an MCP client.
 *
 * `toEnvelope()` deliberately omits the stack and any raw upstream payload: the spec
 * forbids returning stack traces or unsanitized API responses to the model.
 */
export abstract class ToolError extends Error {
  abstract readonly code: ToolErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean = false;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = Object.freeze({ ...details });
  }

  toEnvelope(): ToolErrorEnvelope {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export class UnauthorizedCustomerError extends ToolError {
  readonly code = 'UNAUTHORIZED_CUSTOMER' as const;
  constructor(customerId: string, allowlistSize: number) {
    // The allowlist itself is never disclosed - only its size, so the model cannot
    // enumerate other accounts by probing.
    super(
      `Customer ID ${customerId} is not in this server's configured account allowlist.`,
      { customerId, allowlistSize },
    );
  }
}

export type ToolDisabledReason = 'not_enabled' | 'mutations_disabled' | 'kill_switch' | 'configuration_disabled';

export class ToolDisabledError extends ToolError {
  readonly code = 'TOOL_DISABLED' as const;
  constructor(toolName: string, reason: ToolDisabledReason) {
    super(reason === 'configuration_disabled'
      ? 'Mutation actions are disabled by configuration for this install.'
      : `Tool "${toolName}" is not enabled on this server.`,
    reason === 'configuration_disabled' ? { reason } : { toolName, reason });
  }
}

export class InvalidArgumentError extends ToolError {
  readonly code = 'INVALID_ARGUMENT' as const;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, details);
  }
}

export class ResourceNotFoundError extends ToolError {
  readonly code = 'RESOURCE_NOT_FOUND' as const;
  constructor(resourceType: string, identifier: string, extra: Record<string, unknown> = {}) {
    super(`${resourceType} "${identifier}" was not found in this account.`, {
      resourceType,
      identifier,
      ...extra,
    });
  }
}

export class StaleResourceStateError extends ToolError {
  readonly code = 'STALE_RESOURCE_STATE' as const;
  constructor(field: string, expected: unknown, actual: unknown, extra: Record<string, unknown> = {}) {
    super(
      `Resource state has changed: expected ${field} to be "${String(expected)}" but it is "${String(actual)}".`,
      { field, expected, actual, ...extra },
    );
  }
}

export class UnsupportedResourceStateError extends ToolError {
  readonly code = 'UNSUPPORTED_RESOURCE_STATE' as const;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, details);
  }
}

export class ToolConstraintViolationError extends ToolError {
  readonly code = 'TOOL_CONSTRAINT_VIOLATION' as const;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, details);
  }
}

export class MaxOperationsExceededError extends ToolError {
  readonly code = 'MAX_OPERATIONS_EXCEEDED' as const;
  constructor(toolName: string, requested: number, maximum: number) {
    super(
      `Tool "${toolName}" accepts at most ${maximum} resources per call; ${requested} were requested.`,
      { toolName, requested, maximum },
    );
  }
}

export class DuplicateResourceError extends ToolError {
  readonly code = 'DUPLICATE_RESOURCE' as const;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, details);
  }
}

export class ValidationFailedError extends ToolError {
  readonly code = 'VALIDATION_FAILED' as const;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, details);
  }
}

export class GoogleAdsApiError extends ToolError {
  readonly code = 'GOOGLE_ADS_API_ERROR' as const;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, details);
  }
}

export class RateLimitedError extends ToolError {
  readonly code = 'RATE_LIMITED' as const;
  override readonly retryable = true;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, details);
  }
}

export class TemporaryFailureError extends ToolError {
  readonly code = 'TEMPORARY_FAILURE' as const;
  override readonly retryable = true;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, details);
  }
}

export function isToolError(err: unknown): err is ToolError {
  return err instanceof ToolError;
}

/** Audit `result` value implied by an error code. */
export function auditResultFor(
  code: ToolErrorCode,
): 'denied' | 'validation_failed' | 'failed' {
  switch (code) {
    case 'VALIDATION_FAILED':
      return 'validation_failed';
    case 'GOOGLE_ADS_API_ERROR':
    case 'RATE_LIMITED':
    case 'TEMPORARY_FAILURE':
      return 'failed';
    default:
      return 'denied';
  }
}
