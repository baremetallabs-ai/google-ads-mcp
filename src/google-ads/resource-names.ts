import { UnauthorizedCustomerError, InvalidArgumentError } from '../errors/tool-errors.js';

/**
 * Google Ads resource name construction and parsing.
 *
 * Composite IDs use a tilde: an ad group criterion is
 * `customers/{cid}/adGroupCriteria/{adGroupId}~{criterionId}`.
 */
export const rn = {
  customer: (cid: string) => `customers/${cid}`,
  campaign: (cid: string, id: string) => `customers/${cid}/campaigns/${id}`,
  campaignBudget: (cid: string, id: string) => `customers/${cid}/campaignBudgets/${id}`,
  campaignCriterion: (cid: string, campaignId: string, criterionId: string) =>
    `customers/${cid}/campaignCriteria/${campaignId}~${criterionId}`,
  adGroup: (cid: string, id: string) => `customers/${cid}/adGroups/${id}`,
  adGroupAd: (cid: string, adGroupId: string, adId: string) =>
    `customers/${cid}/adGroupAds/${adGroupId}~${adId}`,
  adGroupCriterion: (cid: string, adGroupId: string, criterionId: string) =>
    `customers/${cid}/adGroupCriteria/${adGroupId}~${criterionId}`,
  /** Ad URL fields are mutated through AdService, not AdGroupAdService. */
  ad: (cid: string, adId: string) => `customers/${cid}/ads/${adId}`,
  recommendation: (cid: string, id: string) => `customers/${cid}/recommendations/${id}`,
} as const;

const CUSTOMER_SEGMENT = /^customers\/(\d{10})\//;

/**
 * Verify that a caller-supplied resource name belongs to the authorized customer.
 *
 * A resource name is model-controlled input that embeds a customer ID. Without this
 * check, a well-formed name pointing at another account would be passed straight
 * through to the API, bypassing the allowlist entirely.
 */
export function assertResourceNameCustomer(
  resourceName: string,
  authorizedCustomerId: string,
  allowlistSize: number,
): void {
  const match = CUSTOMER_SEGMENT.exec(resourceName);
  if (!match) {
    throw new InvalidArgumentError(
      `Resource name "${resourceName}" is not a valid Google Ads resource name.`,
      { resourceName },
    );
  }
  const embedded = match[1] as string;
  if (embedded !== authorizedCustomerId) {
    throw new UnauthorizedCustomerError(embedded, allowlistSize);
  }
}

/** Extract the trailing ID segment. Returns the composite string for `a~b` names. */
export function resourceNameId(resourceName: string): string {
  const parts = resourceName.split('/');
  return parts[parts.length - 1] ?? '';
}

/** Split a composite `{parentId}~{childId}` tail. */
export function splitCompositeId(resourceName: string): { parentId: string; childId: string } {
  const tail = resourceNameId(resourceName);
  const [parentId, childId] = tail.split('~');
  if (!parentId || !childId) {
    throw new InvalidArgumentError(
      `Resource name "${resourceName}" does not carry a composite {parent}~{child} id.`,
      { resourceName },
    );
  }
  return { parentId, childId };
}
