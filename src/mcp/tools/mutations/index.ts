import type { MutationToolName } from '../../../capabilities/tool-names.js';
import {
  pauseCampaign,
  enableCampaign,
  pauseAdGroup,
  enableAdGroup,
  pauseAd,
  enableAd,
  pauseKeyword,
  enableKeyword,
} from './status-toggles.js';
import { addNegativeKeyword, removeNegativeKeyword } from './negative-keywords.js';
import { createPausedAd, createPausedKeyword } from './create-paused.js';
import { updateTrackingParameters } from './tracking.js';
import { dismissRecommendation } from './dismiss-recommendation.js';
import { setCampaignBudget } from './set-campaign-budget.js';

/**
 * Every mutation tool, keyed by name.
 *
 * The definitions are heterogeneous in their input and state types, so the map is
 * loosely typed here; each definition is individually type-safe at its own module.
 */
export const MUTATION_TOOLS: Record<MutationToolName, any> = {
  pause_campaign: pauseCampaign,
  enable_campaign: enableCampaign,
  pause_ad_group: pauseAdGroup,
  enable_ad_group: enableAdGroup,
  pause_ad: pauseAd,
  enable_ad: enableAd,
  pause_keyword: pauseKeyword,
  enable_keyword: enableKeyword,
  add_negative_keyword: addNegativeKeyword,
  remove_negative_keyword: removeNegativeKeyword,
  create_paused_ad: createPausedAd,
  create_paused_keyword: createPausedKeyword,
  dismiss_recommendation: dismissRecommendation,
  update_tracking_parameters: updateTrackingParameters,
  set_campaign_budget: setCampaignBudget,
};
