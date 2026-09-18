import { z } from 'zod';
import { dateRangeShape, resolveDateRange } from '../shared/date-range.js';
import { CustomerIdInput } from '../shared/schemas.js';
import type { Deps, ReadToolDefinition } from '../../../types/index.js';

export const listRecommendations: ReadToolDefinition = {
  name: 'list_recommendations',
  title: 'List Google Ads recommendations',
  description:
    'Lists open Google Ads recommendations with their resource names and projected impact. ' +
    'Resource names returned here are what dismiss_recommendation requires. This server ' +
    'cannot apply recommendations, only dismiss them.',
  inputSchema: {
    customerId: CustomerIdInput,
    includeDismissed: z.boolean().default(false),
    types: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(50).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  },
  outputSchema: {
    customerId: z.string(),
    recommendations: z.array(z.record(z.string(), z.unknown())),
    typeCounts: z.record(z.string(), z.number()),
    rowCount: z.number(),
    message: z.string(),
  },
  async handler(deps: Deps, input): Promise<Record<string, unknown>> {
    const customerId = input.customerId as string;
    const limit = (input.limit as number | undefined) ?? deps.config.reads.defaultRowLimit;
    const filters: string[] = [];
    if (input.includeDismissed !== true) filters.push('recommendation.dismissed = FALSE');
    const types = input.types as string[] | undefined;
    if (types?.length) filters.push(`recommendation.type IN (${types.map((t) => `'${t}'`).join(', ')})`);

    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    const res = await deps.transport.searchPaginated(
      {
        customerId,
        // recommendation.impact is selectable only as a whole; its nested metric paths
        // are not individually selectable.
        query: `SELECT recommendation.resource_name, recommendation.type, recommendation.dismissed, recommendation.campaign, recommendation.ad_group, recommendation.impact FROM recommendation${where}`,
        maxRows: limit,
      },
      { label: 'list_recommendations' },
    );

    const typeCounts: Record<string, number> = {};
    const recommendations = res.rows.map((row) => {
      const r = (row.recommendation ?? {}) as Record<string, any>;
      const type = String(r.type ?? 'UNKNOWN');
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      const resourceName = String(r.resourceName ?? '');
      return {
        resourceName,
        // Recommendation IDs are opaque strings, never numeric.
        recommendationId: resourceName.split('/').pop() ?? null,
        type,
        dismissed: r.dismissed === true,
        campaignResourceName: r.campaign ?? null,
        campaignId: typeof r.campaign === 'string' ? (r.campaign.split('/').pop() ?? null) : null,
        adGroupResourceName: r.adGroup ?? null,
        impact: {
          base: r.impact?.baseMetrics ?? null,
          potential: r.impact?.potentialMetrics ?? null,
        },
      };
    });

    return {
      customerId,
      recommendations,
      typeCounts,
      rowCount: recommendations.length,
      message: `${recommendations.length} recommendation(s) across ${Object.keys(typeCounts).length} type(s).`,
    };
  },
};

export const getConversionActions: ReadToolDefinition = {
  name: 'get_conversion_actions',
  title: 'Get conversion actions',
  description:
    'Lists conversion actions with their status, category, counting type, attribution and ' +
    'lookback settings. Read-only: this server cannot create, modify or delete conversion actions.',
  inputSchema: {
    customerId: CustomerIdInput,
    includeMetrics: z.boolean().default(false),
    ...dateRangeShape,
    includeRemoved: z.boolean().default(false),
  },
  outputSchema: {
    customerId: z.string(),
    conversionActions: z.array(z.record(z.string(), z.unknown())),
    primaryForGoalCount: z.number(),
    rowCount: z.number(),
    message: z.string(),
  },
  async handler(deps: Deps, input): Promise<Record<string, unknown>> {
    const customerId = input.customerId as string;
    const where = input.includeRemoved === true ? '' : " WHERE conversion_action.status != 'REMOVED'";

    const res = await deps.transport.searchPaginated(
      {
        customerId,
        query: `SELECT conversion_action.id, conversion_action.resource_name, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.origin, conversion_action.primary_for_goal, conversion_action.counting_type, conversion_action.click_through_lookback_window_days, conversion_action.view_through_lookback_window_days, conversion_action.attribution_model_settings.attribution_model, conversion_action.value_settings.default_value, conversion_action.value_settings.default_currency_code, conversion_action.value_settings.always_use_default_value FROM conversion_action${where} ORDER BY conversion_action.name`,
        maxRows: deps.config.reads.maxRowLimit,
      },
      { label: 'conversion_actions' },
    );

    const metricsById = new Map<string, { allConversions: number; allConversionsValue: number }>();
    if (input.includeMetrics === true) {
      const range = resolveDateRange(input);
      try {
        const m = await deps.transport.searchPaginated(
          {
            customerId,
            query: `SELECT conversion_action.id, metrics.all_conversions, metrics.all_conversions_value FROM conversion_action WHERE ${range.clause}`,
            maxRows: deps.config.reads.maxRowLimit,
          },
          { label: 'conversion_action_metrics' },
        );
        for (const row of m.rows) {
          const id = String((row.conversionAction as Record<string, unknown> | undefined)?.id ?? '');
          const met = (row.metrics ?? {}) as Record<string, unknown>;
          metricsById.set(id, {
            allConversions: Number(met.allConversions ?? 0),
            allConversionsValue: Number(met.allConversionsValue ?? 0),
          });
        }
      } catch {
        // Metrics are supplementary; their absence must not fail the tool.
      }
    }

    let primaryForGoalCount = 0;
    const conversionActions = res.rows.map((row) => {
      const a = (row.conversionAction ?? {}) as Record<string, any>;
      if (a.primaryForGoal === true) primaryForGoalCount += 1;
      const id = String(a.id ?? '');
      const metrics = metricsById.get(id);
      return {
        conversionActionId: id,
        resourceName: a.resourceName ?? null,
        name: a.name ?? null,
        status: a.status ?? null,
        type: a.type ?? null,
        category: a.category ?? null,
        origin: a.origin ?? null,
        primaryForGoal: a.primaryForGoal === true,
        countingType: a.countingType ?? null,
        clickLookbackDays: a.clickThroughLookbackWindowDays ?? null,
        viewLookbackDays: a.viewThroughLookbackWindowDays ?? null,
        attributionModel: a.attributionModelSettings?.attributionModel ?? null,
        defaultValue: a.valueSettings?.defaultValue ?? null,
        defaultCurrencyCode: a.valueSettings?.defaultCurrencyCode ?? null,
        alwaysUseDefaultValue: a.valueSettings?.alwaysUseDefaultValue === true,
        ...(metrics && { allConversions: metrics.allConversions, allConversionsValue: metrics.allConversionsValue }),
      };
    });

    return {
      customerId,
      conversionActions,
      primaryForGoalCount,
      rowCount: conversionActions.length,
      message: `${conversionActions.length} conversion action(s); ${primaryForGoalCount} marked primary for goal.`,
    };
  },
};

export const getBiddingStrategyStatus: ReadToolDefinition = {
  name: 'get_bidding_strategy_status',
  title: 'Get bidding strategy status',
  description:
    'Reports each campaign bidding strategy, its system status and targets, plus any ' +
    'portfolio (shared) bidding strategies. Read-only: this server does not change bidding ' +
    'strategies, and a portfolio strategy is a shared resource it will not mutate.',
  inputSchema: { customerId: CustomerIdInput },
  outputSchema: {
    customerId: z.string(),
    campaigns: z.array(z.record(z.string(), z.unknown())),
    portfolioStrategies: z.array(z.record(z.string(), z.unknown())),
    sharedStrategyNotice: z.string(),
    message: z.string(),
  },
  async handler(deps: Deps, input): Promise<Record<string, unknown>> {
    const customerId = input.customerId as string;

    const campaignRes = await deps.transport.searchPaginated(
      {
        customerId,
        query:
          "SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.bidding_strategy_system_status, campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas, campaign.target_spend.cpc_bid_ceiling_micros, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas, campaign.manual_cpc.enhanced_cpc_enabled, campaign.target_impression_share.location, campaign.target_impression_share.location_fraction_micros, campaign.target_impression_share.cpc_bid_ceiling_micros FROM campaign WHERE campaign.status != 'REMOVED'",
        maxRows: deps.config.reads.maxRowLimit,
      },
      { label: 'campaign_bidding' },
    );

    const campaigns = campaignRes.rows.map((row) => {
      const c = (row.campaign ?? {}) as Record<string, any>;
      return {
        campaignId: String(c.id ?? ''),
        name: c.name ?? null,
        status: c.status ?? null,
        biddingStrategyType: c.biddingStrategyType ?? null,
        systemStatus: c.biddingStrategySystemStatus ?? null,
        portfolioStrategyResourceName: c.biddingStrategy ?? null,
        targets: {
          targetCpaMicros:
            c.targetCpa?.targetCpaMicros ?? c.maximizeConversions?.targetCpaMicros ?? null,
          targetRoas: c.targetRoas?.targetRoas ?? c.maximizeConversionValue?.targetRoas ?? null,
          cpcBidCeilingMicros:
            c.targetSpend?.cpcBidCeilingMicros ?? c.targetImpressionShare?.cpcBidCeilingMicros ?? null,
          enhancedCpcEnabled: c.manualCpc?.enhancedCpcEnabled ?? null,
          targetImpressionShare: c.targetImpressionShare
            ? {
                location: c.targetImpressionShare.location ?? null,
                locationFractionMicros: c.targetImpressionShare.locationFractionMicros ?? null,
                cpcBidCeilingMicros: c.targetImpressionShare.cpcBidCeilingMicros ?? null,
              }
            : null,
        },
      };
    });

    let portfolioStrategies: Record<string, unknown>[] = [];
    try {
      const res = await deps.transport.searchPaginated(
        {
          customerId,
          query:
            "SELECT bidding_strategy.id, bidding_strategy.name, bidding_strategy.type, bidding_strategy.status, bidding_strategy.campaign_count, bidding_strategy.non_removed_campaign_count, bidding_strategy.effective_currency_code, bidding_strategy.target_cpa.target_cpa_micros, bidding_strategy.target_roas.target_roas FROM bidding_strategy WHERE bidding_strategy.status != 'REMOVED'",
          maxRows: deps.config.reads.maxRowLimit,
        },
        { label: 'portfolio_bidding' },
      );
      portfolioStrategies = res.rows.map((row) => {
        const b = (row.biddingStrategy ?? {}) as Record<string, any>;
        return {
          biddingStrategyId: String(b.id ?? ''),
          name: b.name ?? null,
          type: b.type ?? null,
          status: b.status ?? null,
          campaignCount: b.campaignCount ?? null,
          nonRemovedCampaignCount: b.nonRemovedCampaignCount ?? null,
          effectiveCurrencyCode: b.effectiveCurrencyCode ?? null,
          targets: {
            targetCpaMicros: b.targetCpa?.targetCpaMicros ?? null,
            targetRoas: b.targetRoas?.targetRoas ?? null,
          },
        };
      });
    } catch {
      // Portfolio strategies are supplementary; their absence must not fail the tool.
    }

    return {
      customerId,
      campaigns,
      portfolioStrategies,
      sharedStrategyNotice:
        'Portfolio bidding strategies are shared across campaigns and are read-only for this server.',
      message: `${campaigns.length} campaign bidding configuration(s); ${portfolioStrategies.length} portfolio strategy(ies).`,
    };
  },
};
