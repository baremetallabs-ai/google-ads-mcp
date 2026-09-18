import { z } from 'zod';

/**
 * Shared input primitives.
 *
 * Google Ads IDs routinely exceed Number.MAX_SAFE_INTEGER, so every ID is a string.
 * Zod v4 cannot represent z.bigint() in JSON Schema and the MCP SDK converts every
 * tool schema for tools/list, so money is a string too.
 */
export const CustomerIdInput = z
  .string()
  .describe('Google Ads customer ID. Dashes are accepted and removed.');

export const NumericIdInput = z
  .string()
  .regex(/^\d{1,19}$/, 'must be a numeric Google Ads ID');

export const MicrosInput = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,18})$/, 'must be a non-negative integer number of micros');

export const DateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date, YYYY-MM-DD');

export const DATE_PRESETS = [
  'TODAY',
  'YESTERDAY',
  'LAST_7_DAYS',
  'LAST_14_DAYS',
  'LAST_30_DAYS',
  'THIS_MONTH',
  'LAST_MONTH',
  'THIS_WEEK_MON_TODAY',
  'LAST_WEEK_MON_SUN',
  'LAST_BUSINESS_WEEK',
] as const;

export const DatePresetInput = z.enum(DATE_PRESETS);

export const MATCH_TYPES = ['EXACT', 'PHRASE', 'BROAD'] as const;
export const MatchTypeInput = z.enum(MATCH_TYPES);

export const CAMPAIGN_STATUSES = ['ENABLED', 'PAUSED', 'REMOVED'] as const;
export const TOGGLEABLE_STATUSES = ['ENABLED', 'PAUSED'] as const;

export const HttpsUrlInput = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'must be an absolute http(s) URL');
