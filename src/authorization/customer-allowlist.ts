import { UnauthorizedCustomerError, InvalidArgumentError } from '../errors/tool-errors.js';

/**
 * Normalize a Google Ads customer ID.
 *
 * Google presents customer IDs as 123-456-7890 but the API wants 1234567890. Every
 * entry point normalizes before comparing against the allowlist, so a dashed ID
 * cannot slip past an exact-string check.
 */
export function normalizeCustomerId(raw: string): string {
  const normalized = raw.replace(/[-\s]/g, '');
  if (!/^\d{10}$/.test(normalized)) {
    throw new InvalidArgumentError(
      'customerId must be a 10-digit Google Ads customer ID (dashes are allowed and removed).',
      { field: 'customerId' },
    );
  }
  return normalized;
}

/**
 * Enforces the configured account allowlist.
 *
 * This is the boundary that stops the model reaching an arbitrary account merely by
 * supplying its ID as a tool argument. It runs before any Google Ads call.
 */
export class CustomerAllowlist {
  private readonly allowed: ReadonlySet<string>;

  constructor(allowedCustomerIds: readonly string[]) {
    this.allowed = new Set(allowedCustomerIds.map((id) => id.replace(/[-\s]/g, '')));
  }

  get size(): number {
    return this.allowed.size;
  }

  has(customerId: string): boolean {
    return this.allowed.has(customerId.replace(/[-\s]/g, ''));
  }

  /** Normalize and authorize in one step. Returns the normalized ID. */
  authorize(rawCustomerId: string): string {
    const customerId = normalizeCustomerId(rawCustomerId);
    if (!this.allowed.has(customerId)) {
      throw new UnauthorizedCustomerError(customerId, this.allowed.size);
    }
    return customerId;
  }

  list(): string[] {
    return [...this.allowed];
  }
}
