import { z } from 'zod';
import { ResourceNotFoundError } from '../../../errors/tool-errors.js';
import { escapeGaqlLike, gaqlIdList, gaqlStringList } from '../../../util/gaql.js';
import { formatMicros } from '../../../util/micros.js';
import { dateRangeShape, resolveDateRange } from '../shared/date-range.js';
import {
  METRIC_FIELDS,
  ORDER_BY_FIELDS,
  SEGMENT_FIELDS,
  mapMetrics,
  mapSegments,
  totalMetrics,
} from '../shared/performance.js';
import { CustomerIdInput, NumericIdInput } from '../shared/schemas.js';
import type { Deps, ReadToolDefinition } from '../../../types/index.js';

const CHANNEL_TYPES = [
  'SEARCH',
  'DISPLAY',
  'SHOPPING',
  'VIDEO',
  'PERFORMANCE_MAX',
  'MULTI_CHANNEL',
  'LOCAL',
  'SMART',
  'DISCOVERY',
  'DEMAND_GEN',
] as const;

export const listCampaigns: ReadToolDefinition = {
  name: 'list_campaigns',
  title: 'List campaigns',
  description:
    'Lists campaigns with status, channel type, bidding strategy and the budget resource ' +
    'each one references. Budget IDs returned here are what set_campaign_budget addresses.',
  inputSchema: {
    customerId: CustomerIdInput,
    statuses: z.array(z.enum(['ENABLED', 'PAUSED', 'REMOVED'])).optional(),
    channelTypes: z.array(z.enum(CHANNEL_TYPES)).optional(),
    nameContains: z.string().max(80).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    pageToken: z.string().min(1).optional(),
  },
  outputSchema: {
    customerId: z.string(),
    campaigns: z.array(z.record(z.string(), z.unknown())),
    rowCount: z.number(),
    nextPageToken: z.string().optional(),
    message: z.string(),
  },
  async handler(deps: Deps, input): Promise<Record<string, unknown>> {
    const customerId = input.customerId as string;
    const limit = (input.limit as number | undefined) ?? deps.config.reads.defaultRowLimit;

    const filters: string[] = [];
    const statuses = input.statuses as string[] | undefined;
    filters.push(
      statuses && statuses.length > 0
        ? `campaign.status IN (${gaqlStringList(statuses)})`
        : "campaign.status != 'REMOVED'",
    );
    const channelTypes = input.channelTypes as string[] | undefined;
    if (channelTypes && channelTypes.length > 0) {
      filters.push(`campaign.advertising_channel_type IN (${gaqlStringList(channelTypes)})`);
    }
    if (typeof input.nameContains === 'string' && input.nameContains.length > 0) {
      filters.push(`campaign.name LIKE '%${escapeGaqlLike(input.nameContains)}%'`);
    }

    const query = `
SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status,
       campaign.advertising_channel_type, campaign.advertising_channel_sub_type,
       campaign.bidding_strategy_type, campaign.start_date_time, campaign.end_date_time,
       campaign.campaign_budget, campaign_budget.id, campaign_budget.amount_micros,
       campaign_budget.explicitly_shared
FROM campaign
WHERE ${filters.join(' AND ')}
ORDER BY campaign.name
LIMIT ${limit}`.trim();

    const page = await deps.transport.search(
      {
        customerId,
        query,
        ...(typeof input.pageToken === 'string' && { pageToken: input.pageToken }),
      },
      { label: 'list_campaigns' },
    );

    const campaigns = page.results.map((row) => {
      const c = (row.campaign ?? {}) as Record<string, unknown>;
      const b = (row.campaignBudget ?? {}) as Record<string, unknown>;
      return {
        campaignId: String(c.id ?? ''),
        resourceName: c.resourceName ?? null,
        name: c.name ?? null,
        status: c.status ?? null,
        primaryStatus: c.primaryStatus ?? null,
        channelType: c.advertisingChannelType ?? null,
        channelSubType: c.advertisingChannelSubType ?? null,
        biddingStrategyType: c.biddingStrategyType ?? null,
        startDate: c.startDateTime ?? null,
        endDate: c.endDateTime ?? null,
        budget: {
          budgetId: b.id === undefined ? null : String(b.id),
          resourceName: c.campaignBudget ?? null,
          amountMicros: b.amountMicros === undefined ? null : String(b.amountMicros),
          explicitlyShared: b.explicitlyShared === true,
        },
      };
    });

    return {
      customerId,
      campaigns,
      rowCount: campaigns.length,
      ...(page.nextPageToken !== undefined && { nextPageToken: page.nextPageToken }),
      message: `${campaigns.length} campaign(s) returned.`,
    };
  },
};

export const getCampaign: ReadToolDefinition = {
  name: 'get_campaign',
  title: 'Get one campaign',
  description:
    'Returns full detail for a single campaign, including its budget resource, bidding ' +
    'strategy, network settings and tracking configuration.',
  inputSchema: { customerId: CustomerIdInput, campaignId: NumericIdInput },
  outputSchema: {
    customerId: z.string(),
    campaign: z.record(z.string(), z.unknown()),
    budget: z.record(z.string(), z.unknown()).nullable(),
    adGroupCount: z.number(),
    message: z.string(),
  },
  async handler(deps: Deps, input): Promise<Record<string, unknown>> {
    const customerId = input.customerId as string;
    const campaignId = input.campaignId as string;

    const page = await deps.transport.search(
      {
        customerId,
        query: `
SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status,
       campaign.primary_status, campaign.primary_status_reasons,
       campaign.advertising_channel_type, campaign.advertising_channel_sub_type,
       campaign.start_date_time, campaign.end_date_time, campaign.bidding_strategy_type,
       campaign.bidding_strategy, campaign.bidding_strategy_system_status,
       campaign.optimization_score, campaign.tracking_url_template,
       campaign.final_url_suffix, campaign.url_custom_parameters,
       campaign.network_settings.target_google_search,
       campaign.network_settings.target_search_network,
       campaign.network_settings.target_content_network,
       campaign.campaign_budget, campaign_budget.id, campaign_budget.name,
       campaign_budget.amount_micros, campaign_budget.explicitly_shared,
       campaign_budget.reference_count, campaign_budget.delivery_method,
       campaign_budget.period, campaign_budget.status
FROM campaign
WHERE campaign.id = ${gaqlIdList([campaignId])}
LIMIT 1`.trim(),
      },
      { label: 'get_campaign' },
    );

    const row = page.results[0];
    if (!row) throw new ResourceNotFoundError('campaign', campaignId);
    const c = (row.campaign ?? {}) as Record<string, unknown>;
    const b = row.campaignBudget as Record<string, unknown> | undefined;

    const adGroups = await deps.transport.searchPaginated(
      {
        customerId,
        query: `SELECT ad_group.id FROM ad_group WHERE campaign.id = ${gaqlIdList([campaignId])} AND ad_group.status != 'REMOVED'`,
        maxRows: deps.config.reads.maxRowLimit,
      },
      { label: 'ad_group_count' },
    );

    return {
      customerId,
      campaign: c,
      budget: b
        ? {
            budgetId: String(b.id ?? ''),
            resourceName: c.campaignBudget ?? null,
            name: b.name ?? null,
            amountMicros: b.amountMicros === undefined ? null : String(b.amountMicros),
            explicitlyShared: b.explicitlyShared === true,
            referenceCount: Number(b.referenceCount ?? 1),
            period: b.period ?? null,
            deliveryMethod: b.deliveryMethod ?? null,
            status: b.status ?? null,
            mutableByThisServer: b.explicitlyShared !== true,
          }
        : null,
      adGroupCount: adGroups.rows.length,
      message: `Campaign "${String(c.name ?? campaignId)}" is ${String(c.status ?? 'UNKNOWN')} with ${adGroups.rows.length} ad group(s)${b ? ` on a ${formatMicros(BigInt(String(b.amountMicros ?? '0')))}/day budget` : ''}.`,
    };
  },
};

/** Shared factory for the campaign/ad-group performance report tools. */
function performanceTool(config: {
  name: string;
  title: string;
  description: string;
  resource: string;
  identityFields: string[];
  extraFilters?: { key: string; field: string }[];
  mapRow: (row: Record<string, any>) => Record<string, unknown>;
}): ReadToolDefinition {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: {
      customerId: CustomerIdInput,
      ...dateRangeShape,
      campaignIds: z.array(NumericIdInput).max(200).optional(),
      ...(config.resource === 'ad_group'
        ? { adGroupIds: z.array(NumericIdInput).max(200).optional() }
        : {}),
      segments: z.array(z.enum(['date', 'week', 'month', 'device', 'network'])).max(2).optional(),
      orderBy: z.enum(['cost', 'clicks', 'impressions', 'conversions', 'ctr']).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      pageToken: z.string().min(1).optional(),
    },
    outputSchema: {
      customerId: z.string(),
      dateRange: z.record(z.string(), z.unknown()),
      segments: z.array(z.string()),
      rows: z.array(z.record(z.string(), z.unknown())),
      totals: z.record(z.string(), z.unknown()),
      rowCount: z.number(),
      nextPageToken: z.string().optional(),
      message: z.string(),
    },
    async handler(deps: Deps, input): Promise<Record<string, unknown>> {
      const customerId = input.customerId as string;
      const range = resolveDateRange(input);
      const limit = (input.limit as number | undefined) ?? deps.config.reads.defaultRowLimit;
      const segments = (input.segments as string[] | undefined) ?? [];
      const orderBy = (input.orderBy as string | undefined) ?? 'cost';

      const filters = [range.clause, `${config.resource}.status != 'REMOVED'`];
      const campaignIds = input.campaignIds as string[] | undefined;
      if (campaignIds && campaignIds.length > 0) {
        filters.push(`campaign.id IN (${gaqlIdList(campaignIds)})`);
      }
      const adGroupIds = input.adGroupIds as string[] | undefined;
      if (adGroupIds && adGroupIds.length > 0) {
        filters.push(`ad_group.id IN (${gaqlIdList(adGroupIds)})`);
      }

      const segmentFields = segments.map((s) => SEGMENT_FIELDS[s]).filter(Boolean) as string[];
      const select = [...config.identityFields, ...segmentFields, ...METRIC_FIELDS].join(', ');

      const query = `SELECT ${select} FROM ${config.resource} WHERE ${filters.join(' AND ')} ORDER BY ${ORDER_BY_FIELDS[orderBy] ?? 'metrics.cost_micros'} DESC LIMIT ${limit}`;

      const page = await deps.transport.search(
        {
          customerId,
          query,
          ...(typeof input.pageToken === 'string' && { pageToken: input.pageToken }),
        },
        { label: config.name },
      );

      const rows = page.results.map((row) => ({
        ...config.mapRow(row),
        ...(segments.length > 0 && { segments: mapSegments(row, segments) }),
        metrics: mapMetrics(row),
      }));
      const totals = totalMetrics(rows.map((r) => r.metrics));

      return {
        customerId,
        dateRange: { preset: range.preset ?? null, startDate: range.startDate ?? null, endDate: range.endDate ?? null },
        segments,
        rows,
        totals,
        rowCount: rows.length,
        ...(page.nextPageToken !== undefined && { nextPageToken: page.nextPageToken }),
        message: `${rows.length} row(s); ${totals.clicks} clicks and ${formatMicros(BigInt(totals.costMicros))} total spend.`,
      };
    },
  };
}

export const getCampaignPerformance = performanceTool({
  name: 'get_campaign_performance',
  title: 'Get campaign performance',
  description:
    'Campaign-level performance metrics over a date range, with optional segmentation by ' +
    'date, device or network. Cost values are integer micros.',
  resource: 'campaign',
  identityFields: ['campaign.id', 'campaign.name', 'campaign.status'],
  mapRow: (row) => {
    const c = (row.campaign ?? {}) as Record<string, unknown>;
    return { campaignId: String(c.id ?? ''), campaignName: c.name ?? null, status: c.status ?? null };
  },
});

export const getAdGroupPerformance = performanceTool({
  name: 'get_ad_group_performance',
  title: 'Get ad group performance',
  description:
    'Ad-group-level performance metrics over a date range, with optional segmentation. ' +
    'Cost values are integer micros.',
  resource: 'ad_group',
  identityFields: [
    'ad_group.id',
    'ad_group.name',
    'ad_group.status',
    'ad_group.type',
    'campaign.id',
    'campaign.name',
  ],
  mapRow: (row) => {
    const g = (row.adGroup ?? {}) as Record<string, unknown>;
    const c = (row.campaign ?? {}) as Record<string, unknown>;
    return {
      adGroupId: String(g.id ?? ''),
      adGroupName: g.name ?? null,
      status: g.status ?? null,
      type: g.type ?? null,
      campaignId: String(c.id ?? ''),
      campaignName: c.name ?? null,
    };
  },
});
