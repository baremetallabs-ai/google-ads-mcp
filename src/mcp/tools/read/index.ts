import { listAccessibleAccounts, getAccountSummary } from './accounts.js';
import {
  listCampaigns,
  getCampaign,
  getCampaignPerformance,
  getAdGroupPerformance,
} from './campaigns.js';
import { getKeywordPerformance, getSearchTerms, listNegativeKeywords } from './keywords.js';
import {
  listRecommendations,
  getConversionActions,
  getBiddingStrategyStatus,
} from './insights.js';
import { getBudgetPacing } from './budget-pacing.js';
import { getChangeHistory, searchGoogleAds } from './search.js';
import type { ReadToolDefinition } from '../../../types/index.js';

/** All read tools, always registered. */
export const READ_TOOLS: readonly ReadToolDefinition[] = [
  listAccessibleAccounts,
  getAccountSummary,
  listCampaigns,
  getCampaign,
  getCampaignPerformance,
  getAdGroupPerformance,
  getKeywordPerformance,
  getSearchTerms,
  listNegativeKeywords,
  listRecommendations,
  getConversionActions,
  getBiddingStrategyStatus,
  getBudgetPacing,
  getChangeHistory,
  searchGoogleAds,
];
