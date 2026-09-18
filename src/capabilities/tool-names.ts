/**
 * The closed sets of tool names this server implements.
 *
 * These unions are what make the capability configuration fail closed: enabling a
 * name that is not here is a startup error, not a silently ignored key.
 */
export const READ_TOOL_NAMES = [
  'list_accessible_accounts',
  'get_account_summary',
  'list_campaigns',
  'get_campaign',
  'get_campaign_performance',
  'get_ad_group_performance',
  'get_keyword_performance',
  'get_search_terms',
  'list_negative_keywords',
  'list_recommendations',
  'get_conversion_actions',
  'get_bidding_strategy_status',
  'get_budget_pacing',
  'get_change_history',
  'search_google_ads',
] as const;

export const MUTATION_TOOL_NAMES = [
  'pause_campaign',
  'enable_campaign',
  'pause_ad_group',
  'enable_ad_group',
  'pause_ad',
  'enable_ad',
  'pause_keyword',
  'enable_keyword',
  'add_negative_keyword',
  'remove_negative_keyword',
  'create_paused_ad',
  'create_paused_keyword',
  'dismiss_recommendation',
  'update_tracking_parameters',
  'set_campaign_budget',
] as const;

export type ReadToolName = (typeof READ_TOOL_NAMES)[number];
export type MutationToolName = (typeof MUTATION_TOOL_NAMES)[number];

/**
 * Operations this server will never implement.
 *
 * Kept as data so a test can assert none of them ever appear in tools/list, and so a
 * future contributor sees the exclusion list next to the inclusion list.
 */
export const PROHIBITED_TOOL_NAMES = [
  'execute_arbitrary_mutation',
  'raw_google_ads_mutate',
  'execute_protobuf_operation',
  'mutate_resource',
  'reallocate_campaign_budgets',
  'create_campaign',
  'delete_campaign',
  'remove_campaign',
  'delete_conversion_action',
  'apply_recommendation',
  'update_billing',
  'set_payment_method',
  'add_account_user',
  'update_account_access',
  'link_manager_account',
  'create_customer_account',
  'mutate_shared_budget',
] as const;
