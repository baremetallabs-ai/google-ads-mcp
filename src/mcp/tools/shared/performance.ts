import type { GoogleAdsRow } from '../../../google-ads/types.js';

/**
 * Common reporting metrics.
 *
 * Google returns int64 fields (*_micros) as JSON strings and doubles (ctr,
 * conversions) as numbers. Micros stay strings all the way to the client so no
 * precision is lost; doubles stay numbers because that is what they are.
 */
export const METRIC_FIELDS = [
  'metrics.impressions',
  'metrics.clicks',
  'metrics.cost_micros',
  'metrics.ctr',
  'metrics.average_cpc',
  'metrics.conversions',
  'metrics.conversions_value',
  'metrics.cost_per_conversion',
  'metrics.all_conversions',
] as const;

export interface Metrics {
  impressions: string;
  clicks: string;
  costMicros: string;
  ctr: number;
  averageCpcMicros: string;
  conversions: number;
  conversionsValue: number;
  costPerConversionMicros: string;
  allConversions: number;
}

const asString = (v: unknown): string => (v === undefined || v === null ? '0' : String(v));
const asNumber = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

export function mapMetrics(row: GoogleAdsRow): Metrics {
  const m = (row.metrics ?? {}) as Record<string, unknown>;
  return {
    impressions: asString(m.impressions),
    clicks: asString(m.clicks),
    costMicros: asString(m.costMicros),
    ctr: asNumber(m.ctr),
    averageCpcMicros: asString(m.averageCpc),
    conversions: asNumber(m.conversions),
    conversionsValue: asNumber(m.conversionsValue),
    costPerConversionMicros: asString(m.costPerConversion),
    allConversions: asNumber(m.allConversions),
  };
}

/** Sum metric rows. Micros are summed as bigint; rates are recomputed, never averaged. */
export function totalMetrics(rows: readonly Metrics[]): Metrics {
  let impressions = 0n;
  let clicks = 0n;
  let costMicros = 0n;
  let conversions = 0;
  let conversionsValue = 0;
  let allConversions = 0;

  for (const r of rows) {
    impressions += BigInt(r.impressions || '0');
    clicks += BigInt(r.clicks || '0');
    costMicros += BigInt(r.costMicros || '0');
    conversions += r.conversions;
    conversionsValue += r.conversionsValue;
    allConversions += r.allConversions;
  }

  const ctr = impressions > 0n ? Number(clicks) / Number(impressions) : 0;
  const averageCpcMicros = clicks > 0n ? (costMicros / clicks).toString() : '0';
  const costPerConversionMicros =
    conversions > 0 ? (costMicros / BigInt(Math.max(1, Math.round(conversions)))).toString() : '0';

  return {
    impressions: impressions.toString(),
    clicks: clicks.toString(),
    costMicros: costMicros.toString(),
    ctr,
    averageCpcMicros,
    conversions,
    conversionsValue,
    costPerConversionMicros,
    allConversions,
  };
}

export const SEGMENT_FIELDS: Record<string, string> = {
  date: 'segments.date',
  week: 'segments.week',
  month: 'segments.month',
  device: 'segments.device',
  network: 'segments.ad_network_type',
};

export function mapSegments(row: GoogleAdsRow, requested: readonly string[]): Record<string, string> {
  const s = (row.segments ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of requested) {
    const wire = key === 'network' ? 'adNetworkType' : key;
    if (s[wire] !== undefined) out[key] = String(s[wire]);
  }
  return out;
}

export const ORDER_BY_FIELDS: Record<string, string> = {
  cost: 'metrics.cost_micros',
  clicks: 'metrics.clicks',
  impressions: 'metrics.impressions',
  conversions: 'metrics.conversions',
  ctr: 'metrics.ctr',
};
