import { InvalidArgumentError } from '../errors/tool-errors.js';

/**
 * Money handling for Google Ads.
 *
 * Every monetary value in this server is an integer number of micros (millionths of
 * the account currency) carried as a decimal string across tool boundaries and as a
 * `bigint` in arithmetic. JavaScript numbers never touch this path: a daily budget of
 * $500 is 500_000_000 micros, and account totals across many budgets can exceed
 * Number.MAX_SAFE_INTEGER once accumulated over large accounts.
 */

/** int64 max - the largest value Google Ads will accept in a micros field. */
export const MAX_MICROS = 9_223_372_036_854_775_807n;

const MICROS_PATTERN = /^(?:0|[1-9]\d{0,18})$/;

/**
 * Parse a micros value into a bigint.
 *
 * Accepts a string (the REST wire format for int64) or a number (defensive: some
 * fields come back as JSON numbers). Rejects negatives, decimals, and anything
 * above int64 max.
 */
export function toBigIntMicros(value: unknown, field = 'amountMicros'): bigint {
  if (typeof value === 'bigint') {
    assertInRange(value, field);
    return value;
  }
  if (value === null || value === undefined) {
    throw new InvalidArgumentError(`Missing ${field}.`, { field });
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new InvalidArgumentError(`${field} must be a non-negative integer.`, { field });
    }
    if (!Number.isSafeInteger(value)) {
      throw new InvalidArgumentError(
        `${field} exceeds safe integer precision; it must be supplied as a string.`,
        { field },
      );
    }
    return BigInt(value);
  }
  if (typeof value !== 'string') {
    throw new InvalidArgumentError(
      `${field} must be a decimal string or an integer number of micros.`,
      { field },
    );
  }
  const text = value.trim();
  if (!MICROS_PATTERN.test(text)) {
    throw new InvalidArgumentError(
      `${field} must be a non-negative integer number of micros expressed as a decimal string.`,
      { field },
    );
  }
  const parsed = BigInt(text);
  assertInRange(parsed, field);
  return parsed;
}

function assertInRange(value: bigint, field: string): void {
  if (value < 0n) {
    throw new InvalidArgumentError(`${field} must not be negative.`, { field });
  }
  if (value > MAX_MICROS) {
    throw new InvalidArgumentError(`${field} exceeds the maximum supported value.`, { field });
  }
}

/**
 * Format micros as a currency-agnostic decimal string for human-readable messages.
 *
 * Uses integer division throughout - no floating point - and truncates to two
 * fractional digits, which is what a reader expects of a budget figure.
 */
export function formatMicros(micros: bigint, currencyCode?: string): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / 1_000_000n;
  const fraction = String(abs % 1_000_000n).padStart(6, '0').slice(0, 2);
  // No currency is assumed when the account's code is unknown: rendering an amount
  // as dollars when the account bills in another currency is worse than omitting the
  // symbol. Known codes render as a symbol where there is an unambiguous one.
  const symbol =
    currencyCode === undefined ? '' : (CURRENCY_SYMBOLS[currencyCode] ?? `${currencyCode} `);
  return `${negative ? '-' : ''}${symbol}${whole.toString()}.${fraction}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '\u20ac',
  GBP: '\u00a3',
  JPY: '\u00a5',
};

/** Sum a list of micros values. */
export function sumMicros(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}
