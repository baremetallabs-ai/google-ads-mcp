import { z } from 'zod';
import { gaqlIdList, escapeGaqlLike } from '../../../util/gaql.js';
import { formatMicros } from '../../../util/micros.js';
import { dateRangeShape, resolveDateRange } from '../shared/date-range.js';
import { METRIC_FIELDS, mapMetrics, totalMetrics } from '../shared/performance.js';
import { CustomerIdInput, NumericIdInput } from '../shared/schemas.js';
import type { Deps, ReadToolDefinition } from '../../../types/index.js';

export const getKeywordPerformance: ReadToolDefinition = {
  name: 'get_keyword_performance',
  title: 'Get keyword performance',
  description:
    'Performance for bidding keywords over a date range. Returns each criterion resource ' +
    'name so pause_keyword or enable_keyword can be called without a further lookup. ' +
    'Negative keywords are not included; use list_negative_keywords for those.',
  inputSchema: {
    customerId: CustomerIdInput,
    ...dateRangeShape,
    campaignIds: z.array(NumericIdInput).max(200).optional(),
    adGroupIds: z.array(NumericIdInput).max(200).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    pageToken: z.string().min(1).optional(),
  },
  outputSchema: {
    customerId: z.string(),
    dateRange: z.record(z.string(), z.unknown()),
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

    const filters = [range.clause];
    const campaignIds = input.campaignIds as string[] | undefined;
    if (campaignIds?.length) filters.push(`campaign.id IN (${gaqlIdList(campaignIds)})`);
    const adGroupIds = input.adGroupIds as string[] | undefined;
    if (adGroupIds?.length) filters.push(`ad_group.id IN (${gaqlIdList(adGroupIds)})`);

    // keyword_view excludes negative criteria by construction.
    const query = `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.system_serving_status, ad_group_criterion.quality_info.quality_score, ad_group_criterion.effective_cpc_bid_micros, ${METRIC_FIELDS.join(', ')} FROM keyword_view WHERE ${filters.join(' AND ')} ORDER BY metrics.cost_micros DESC LIMIT ${limit}`;

    const page = await deps.transport.search(
      { customerId, query, ...(typeof input.pageToken === 'string' && { pageToken: input.pageToken }) },
      { label: 'keyword_performance' },
    );

    const rows = page.results.map((row) => {
      const crit = (row.adGroupCriterion ?? {}) as Record<string, any>;
      const g = (row.adGroup ?? {}) as Record<string, unknown>;
      const c = (row.campaign ?? {}) as Record<string, unknown>;
      return {
        criterionId: String(crit.criterionId ?? ''),
        resourceName: crit.resourceName ?? null,
        text: crit.keyword?.text ?? null,
        matchType: crit.keyword?.matchType ?? null,
        status: crit.status ?? null,
        systemServingStatus: crit.systemServingStatus ?? null,
        qualityScore: crit.qualityInfo?.qualityScore ?? null,
        effectiveCpcBidMicros:
          crit.effectiveCpcBidMicros === undefined ? null : String(crit.effectiveCpcBidMicros),
        adGroupId: String(g.id ?? ''),
        adGroupName: g.name ?? null,
        campaignId: String(c.id ?? ''),
        campaignName: c.name ?? null,
        metrics: mapMetrics(row),
      };
    });
    const totals = totalMetrics(rows.map((r) => r.metrics));

    return {
      customerId,
      dateRange: { preset: range.preset ?? null, startDate: range.startDate ?? null, endDate: range.endDate ?? null },
      rows,
      totals,
      rowCount: rows.length,
      ...(page.nextPageToken !== undefined && { nextPageToken: page.nextPageToken }),
      message: `${rows.length} keyword(s); ${totals.clicks} clicks and ${formatMicros(BigInt(totals.costMicros))} spend.`,
    };
  },
};

export const getSearchTerms: ReadToolDefinition = {
  name: 'get_search_terms',
  title: 'Get search terms',
  description:
    'The queries people actually typed that triggered ads, with their metrics and whether ' +
    'each is already added or excluded. This is the input for add_negative_keyword decisions.',
  inputSchema: {
    customerId: CustomerIdInput,
    ...dateRangeShape,
    campaignIds: z.array(NumericIdInput).max(200).optional(),
    adGroupIds: z.array(NumericIdInput).max(200).optional(),
    textContains: z.string().max(80).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    pageToken: z.string().min(1).optional(),
  },
  outputSchema: {
    customerId: z.string(),
    dateRange: z.record(z.string(), z.unknown()),
    rows: z.array(z.record(z.string(), z.unknown())),
    totals: z.record(z.string(), z.unknown()),
    rowCount: z.number(),
    nextPageToken: z.string().optional(),
    message: z.string(),
  },
  async handler(deps: Deps, input): Promise<Record<string, unknown>> {
    const customerId = input.customerId as string;
    // search_term_view always requires a date range; resolveDateRange guarantees one.
    const range = resolveDateRange(input);
    const limit = (input.limit as number | undefined) ?? deps.config.reads.defaultRowLimit;

    const filters = [range.clause];
    const campaignIds = input.campaignIds as string[] | undefined;
    if (campaignIds?.length) filters.push(`campaign.id IN (${gaqlIdList(campaignIds)})`);
    const adGroupIds = input.adGroupIds as string[] | undefined;
    if (adGroupIds?.length) filters.push(`ad_group.id IN (${gaqlIdList(adGroupIds)})`);
    if (typeof input.textContains === 'string' && input.textContains.length > 0) {
      filters.push(`search_term_view.search_term LIKE '%${escapeGaqlLike(input.textContains)}%'`);
    }

    const query = `SELECT search_term_view.search_term, search_term_view.status, segments.search_term_match_type, campaign.id, campaign.name, ad_group.id, ad_group.name, ${METRIC_FIELDS.join(', ')} FROM search_term_view WHERE ${filters.join(' AND ')} ORDER BY metrics.impressions DESC LIMIT ${limit}`;

    const page = await deps.transport.search(
      { customerId, query, ...(typeof input.pageToken === 'string' && { pageToken: input.pageToken }) },
      { label: 'search_terms' },
    );

    const rows = page.results.map((row) => {
      const v = (row.searchTermView ?? {}) as Record<string, unknown>;
      const s = (row.segments ?? {}) as Record<string, unknown>;
      const g = (row.adGroup ?? {}) as Record<string, unknown>;
      const c = (row.campaign ?? {}) as Record<string, unknown>;
      return {
        searchTerm: v.searchTerm ?? null,
        status: v.status ?? null,
        matchType: s.searchTermMatchType ?? null,
        campaignId: String(c.id ?? ''),
        campaignName: c.name ?? null,
        adGroupId: String(g.id ?? ''),
        adGroupName: g.name ?? null,
        metrics: mapMetrics(row),
      };
    });
    const totals = totalMetrics(rows.map((r) => r.metrics));

    return {
      customerId,
      dateRange: { preset: range.preset ?? null, startDate: range.startDate ?? null, endDate: range.endDate ?? null },
      rows,
      totals,
      rowCount: rows.length,
      ...(page.nextPageToken !== undefined && { nextPageToken: page.nextPageToken }),
      message: `${rows.length} search term(s); ${totals.clicks} clicks and ${formatMicros(BigInt(totals.costMicros))} spend.`,
    };
  },
};

export const listNegativeKeywords: ReadToolDefinition = {
  name: 'list_negative_keywords',
  title: 'List negative keywords',
  description:
    'Lists campaign-level and ad-group-level negative keywords with their criterion resource ' +
    'names, which remove_negative_keyword requires. Shared negative lists are reported for ' +
    'visibility but this server cannot modify them.',
  inputSchema: {
    customerId: CustomerIdInput,
    scope: z.enum(['campaign', 'ad_group', 'both']).default('both'),
    campaignId: NumericIdInput.optional(),
    adGroupId: NumericIdInput.optional(),
    textContains: z.string().max(80).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  },
  outputSchema: {
    customerId: z.string(),
    campaignNegatives: z.array(z.record(z.string(), z.unknown())),
    adGroupNegatives: z.array(z.record(z.string(), z.unknown())),
    sharedNegativeLists: z.array(z.record(z.string(), z.unknown())),
    sharedListNotice: z.string(),
    totalCount: z.number(),
    message: z.string(),
  },
  async handler(deps: Deps, input): Promise<Record<string, unknown>> {
    const customerId = input.customerId as string;
    const scope = (input.scope as string | undefined) ?? 'both';
    const limit = (input.limit as number | undefined) ?? deps.config.reads.maxRowLimit;
    const textFilter =
      typeof input.textContains === 'string' && input.textContains.length > 0
        ? escapeGaqlLike(input.textContains)
        : undefined;

    const campaignNegatives: Record<string, unknown>[] = [];
    const adGroupNegatives: Record<string, unknown>[] = [];

    if (scope === 'campaign' || scope === 'both') {
      const filters = [
        'campaign_criterion.negative = TRUE',
        "campaign_criterion.type = 'KEYWORD'",
        "campaign.status != 'REMOVED'",
      ];
      if (typeof input.campaignId === 'string') {
        filters.push(`campaign.id = ${gaqlIdList([input.campaignId])}`);
      }
      if (textFilter) filters.push(`campaign_criterion.keyword.text LIKE '%${textFilter}%'`);
      const res = await deps.transport.searchPaginated(
        {
          customerId,
          query: `SELECT campaign.id, campaign.name, campaign_criterion.criterion_id, campaign_criterion.resource_name, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE ${filters.join(' AND ')}`,
          maxRows: limit,
        },
        { label: 'campaign_negatives' },
      );
      for (const row of res.rows) {
        const cc = (row.campaignCriterion ?? {}) as Record<string, any>;
        const c = (row.campaign ?? {}) as Record<string, unknown>;
        campaignNegatives.push({
          scope: 'campaign',
          campaignId: String(c.id ?? ''),
          campaignName: c.name ?? null,
          criterionId: String(cc.criterionId ?? ''),
          resourceName: cc.resourceName ?? null,
          text: cc.keyword?.text ?? null,
          matchType: cc.keyword?.matchType ?? null,
        });
      }
    }

    if (scope === 'ad_group' || scope === 'both') {
      const filters = [
        'ad_group_criterion.negative = TRUE',
        "ad_group_criterion.type = 'KEYWORD'",
        "ad_group.status != 'REMOVED'",
      ];
      if (typeof input.adGroupId === 'string') {
        filters.push(`ad_group.id = ${gaqlIdList([input.adGroupId])}`);
      }
      if (typeof input.campaignId === 'string') {
        filters.push(`campaign.id = ${gaqlIdList([input.campaignId])}`);
      }
      if (textFilter) filters.push(`ad_group_criterion.keyword.text LIKE '%${textFilter}%'`);
      const res = await deps.transport.searchPaginated(
        {
          customerId,
          query: `SELECT campaign.id, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.resource_name, ad_group_criterion.type, ad_group_criterion.negative, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ${filters.join(' AND ')}`,
          maxRows: limit,
        },
        { label: 'ad_group_negatives' },
      );
      for (const row of res.rows) {
        const cc = (row.adGroupCriterion ?? {}) as Record<string, any>;
        const g = (row.adGroup ?? {}) as Record<string, unknown>;
        const c = (row.campaign ?? {}) as Record<string, unknown>;
        adGroupNegatives.push({
          scope: 'ad_group',
          adGroupId: String(g.id ?? ''),
          adGroupName: g.name ?? null,
          campaignId: String(c.id ?? ''),
          criterionId: String(cc.criterionId ?? ''),
          resourceName: cc.resourceName ?? null,
          text: cc.keyword?.text ?? null,
          matchType: cc.keyword?.matchType ?? null,
        });
      }
    }

    // Shared negative lists are a shared resource this server deliberately does not
    // mutate; reporting them stops a client believing the list above is exhaustive.
    const sharedNegativeLists: Record<string, unknown>[] = [];
    try {
      const shared = await deps.transport.searchPaginated(
        {
          customerId,
          query:
            "SELECT campaign.id, campaign_shared_set.shared_set, campaign_shared_set.status, shared_set.id, shared_set.name, shared_set.type FROM campaign_shared_set WHERE shared_set.type = 'NEGATIVE_KEYWORDS'",
          maxRows: limit,
        },
        { label: 'shared_negative_lists' },
      );
      const grouped = new Map<string, Record<string, unknown>>();
      for (const row of shared.rows) {
        const ss = (row.sharedSet ?? {}) as Record<string, unknown>;
        const c = (row.campaign ?? {}) as Record<string, unknown>;
        const id = String(ss.id ?? '');
        const existing = grouped.get(id);
        if (existing) {
          (existing.campaignIds as string[]).push(String(c.id ?? ''));
        } else {
          grouped.set(id, {
            sharedSetId: id,
            name: ss.name ?? null,
            type: ss.type ?? null,
            campaignIds: [String(c.id ?? '')],
          });
        }
      }
      sharedNegativeLists.push(...grouped.values());
    } catch {
      // Shared-set visibility is best effort; its absence must not fail the tool.
    }

    const totalCount = campaignNegatives.length + adGroupNegatives.length;
    return {
      customerId,
      campaignNegatives,
      adGroupNegatives,
      sharedNegativeLists,
      sharedListNotice:
        'Negatives held in shared negative keyword lists are read-only for this server. ' +
        'add_negative_keyword and remove_negative_keyword operate only on campaign and ad group criteria.',
      totalCount,
      message: `${campaignNegatives.length} campaign-level and ${adGroupNegatives.length} ad-group-level negative keyword(s); ${sharedNegativeLists.length} shared list(s) attached.`,
    };
  },
};
