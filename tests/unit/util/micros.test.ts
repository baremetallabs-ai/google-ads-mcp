import { describe, it, expect } from 'vitest';
import { toBigIntMicros, formatMicros, sumMicros, MAX_MICROS } from '../../../src/util/micros.js';
import { InvalidArgumentError } from '../../../src/errors/tool-errors.js';

describe('micros arithmetic', () => {
  it('parses the REST string encoding of int64', () => {
    expect(toBigIntMicros('500000000')).toBe(500_000_000n);
    expect(toBigIntMicros('0')).toBe(0n);
  });

  it('preserves precision beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = '9007199254740993'; // 2^53 + 1
    expect(toBigIntMicros(huge)).toBe(BigInt(huge));
    // The point of bigint: a round trip through Number silently loses the last digit.
    expect(String(Number(huge))).toBe('9007199254740992');
    expect(toBigIntMicros(huge).toString()).toBe(huge);
  });

  it('accepts int64 max but rejects beyond it', () => {
    expect(toBigIntMicros(MAX_MICROS.toString())).toBe(MAX_MICROS);
    expect(() => toBigIntMicros('9223372036854775808')).toThrow(InvalidArgumentError);
  });

  it('rejects negatives, decimals and junk', () => {
    expect(() => toBigIntMicros('-1')).toThrow(InvalidArgumentError);
    expect(() => toBigIntMicros('1.5')).toThrow(InvalidArgumentError);
    expect(() => toBigIntMicros('1e6')).toThrow(InvalidArgumentError);
    expect(() => toBigIntMicros('')).toThrow(InvalidArgumentError);
    expect(() => toBigIntMicros(undefined)).toThrow(InvalidArgumentError);
  });

  it('rejects a number that has already lost precision', () => {
    // Deliberately unsafe literal: this is exactly the value a caller must not send
    // as a JS number, and the parser has to refuse it.
    // eslint-disable-next-line no-loss-of-precision
    expect(() => toBigIntMicros(9_007_199_254_740_993)).toThrow(InvalidArgumentError);
  });

  it('rejects a non-string, non-number value instead of stringifying it', () => {
    // String({}) would be "[object Object]" and fail with a confusing message.
    expect(() => toBigIntMicros({})).toThrow(InvalidArgumentError);
    expect(() => toBigIntMicros([])).toThrow(InvalidArgumentError);
  });

  it('formats without floating point', () => {
    expect(formatMicros(500_000_000n, 'USD')).toBe('$500.00');
    expect(formatMicros(1_234_567n, 'USD')).toBe('$1.23');
    expect(formatMicros(0n, 'USD')).toBe('$0.00');
    expect(formatMicros(-50_000_000n, 'USD')).toBe('-$50.00');
  });

  it('renders a symbol for known currencies and the code for the rest', () => {
    expect(formatMicros(30_000_000n, 'EUR')).toBe('\u20ac30.00');
    expect(formatMicros(30_000_000n, 'GBP')).toBe('\u00a330.00');
    // An unrecognised code is prefixed rather than guessed at.
    expect(formatMicros(30_000_000n, 'SEK')).toBe('SEK 30.00');
  });

  it('omits the currency entirely when the account currency is unknown', () => {
    // Rendering an amount as dollars when the account bills in another currency is
    // worse than omitting the symbol.
    expect(formatMicros(500_000_000n)).toBe('500.00');
    expect(formatMicros(-50_000_000n)).toBe('-50.00');
  });

  it('truncates rather than rounds the fractional part', () => {
    // 0.999999 must not become 1.00 in a budget message.
    expect(formatMicros(999_999n, 'USD')).toBe('$0.99');
  });

  it('sums without overflow', () => {
    expect(sumMicros([1n, 2n, 3n])).toBe(6n);
    expect(sumMicros([])).toBe(0n);
  });
});
