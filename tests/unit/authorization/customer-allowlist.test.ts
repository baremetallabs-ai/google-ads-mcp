import { describe, it, expect } from 'vitest';
import {
  CustomerAllowlist,
  normalizeCustomerId,
} from '../../../src/authorization/customer-allowlist.js';
import {
  InvalidArgumentError,
  UnauthorizedCustomerError,
} from '../../../src/errors/tool-errors.js';

describe('customer ID normalization', () => {
  it('strips the dashes Google shows in its UI', () => {
    expect(normalizeCustomerId('123-456-7890')).toBe('1234567890');
    expect(normalizeCustomerId('1234567890')).toBe('1234567890');
    expect(normalizeCustomerId(' 123 456 7890 ')).toBe('1234567890');
  });

  it('rejects anything that is not ten digits', () => {
    expect(() => normalizeCustomerId('123')).toThrow(InvalidArgumentError);
    expect(() => normalizeCustomerId('12345678901')).toThrow(InvalidArgumentError);
    expect(() => normalizeCustomerId('abcdefghij')).toThrow(InvalidArgumentError);
  });
});

describe('CustomerAllowlist', () => {
  const allowlist = new CustomerAllowlist(['1234567890', '234-567-8901']);

  it('authorizes an allowlisted account in either notation', () => {
    expect(allowlist.authorize('1234567890')).toBe('1234567890');
    expect(allowlist.authorize('123-456-7890')).toBe('1234567890');
    // The allowlist entry itself was written with dashes.
    expect(allowlist.authorize('2345678901')).toBe('2345678901');
  });

  it('rejects an account outside the allowlist', () => {
    expect(() => allowlist.authorize('9999999999')).toThrow(UnauthorizedCustomerError);
  });

  it('never discloses the allowlist contents in the error', () => {
    try {
      allowlist.authorize('9999999999');
      expect.unreachable('should have thrown');
    } catch (err) {
      const details = (err as UnauthorizedCustomerError).details;
      expect(details).toEqual({ customerId: '9999999999', allowlistSize: 2 });
      expect(JSON.stringify(details)).not.toContain('1234567890');
    }
  });
});
