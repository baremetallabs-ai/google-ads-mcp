import { z } from 'zod';
import {
  InvalidArgumentError,
  ResourceNotFoundError,
  StaleResourceStateError,
  ToolConstraintViolationError,
} from '../../../errors/tool-errors.js';
import { rn } from '../../../google-ads/resource-names.js';
import type { MutateOperation } from '../../../google-ads/types.js';
import { gaqlIdList, gaqlStringList } from '../../../util/gaql.js';
import { CustomerIdInput, HttpsUrlInput, NumericIdInput } from '../shared/schemas.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATION_OUTPUT_SHAPE,
  type MutationDefinition,
} from './pipeline.js';

/** Placeholders that expand to the ad's own final URL. */
const LPURL_PLACEHOLDERS = ['{lpurl}', '{unescapedlpurl}', '{escapedlpurl}', '{lpurl+2}', '{lpurl+3}'];

interface TrackingInput {
  customerId: string;
  entityType: 'campaign' | 'ad_group' | 'ad';
  campaignId?: string;
  adGroupId?: string;
  adId?: string;
  trackingUrlTemplate?: string | null;
  finalUrlSuffix?: string | null;
  urlCustomParameters?: { key: string; value: string }[];
  finalUrls?: string[];
  expectedCurrentTrackingTemplate?: string | null;
  expectedCurrentFinalUrl?: string;
}

interface TrackingState {
  resourceName: string;
  entityName: string;
  trackingUrlTemplate: string | null;
  finalUrlSuffix: string | null;
  urlCustomParameters: { key: string; value: string }[];
  finalUrls: string[];
}

export const updateTrackingParameters: MutationDefinition<
  'update_tracking_parameters',
  TrackingInput,
  TrackingState
> = {
  name: 'update_tracking_parameters',
  title: 'Update tracking parameters',
  description:
    'Updates click-tracking configuration on a campaign, ad group or ad: the tracking URL ' +
    'template, the final URL suffix and custom URL parameters. This changes how clicks are ' +
    'tracked and attributed, and a malformed template can break click-throughs. When final ' +
    'URL changes are disabled in configuration, any request that would alter the effective ' +
    'destination is rejected.',
  resourceType: 'campaign',
  annotations: { title: 'Update tracking parameters', ...DESTRUCTIVE_ANNOTATIONS },

  buildInputSchema: () => ({
    customerId: CustomerIdInput,
    entityType: z.enum(['campaign', 'ad_group', 'ad']),
    campaignId: NumericIdInput.optional(),
    adGroupId: NumericIdInput.optional(),
    adId: NumericIdInput.optional(),
    trackingUrlTemplate: z
      .string()
      .max(2048)
      .nullable()
      .optional()
      .describe('Tracking template. Pass null to clear it.'),
    finalUrlSuffix: z
      .string()
      .max(2048)
      .nullable()
      .optional()
      .describe('Query parameters appended to the final URL. Pass null to clear.'),
    urlCustomParameters: z
      .array(z.strictObject({ key: z.string().regex(/^\w{1,16}$/), value: z.string().max(250) }))
      .max(8)
      .optional(),
    finalUrls: z.array(HttpsUrlInput).min(1).max(4).optional(),
    expectedCurrentTrackingTemplate: z.string().nullable().optional(),
    expectedCurrentFinalUrl: z.string().optional(),
  }),

  outputSchema: {
    ...MUTATION_OUTPUT_SHAPE,
    resourceId: z.string(),
    resourceName: z.string(),
    before: z.record(z.string(), z.unknown()),
    after: z.record(z.string(), z.unknown()),
    changedFields: z.array(z.string()),
    finalUrlChanged: z.boolean(),
    googleAdsRequestId: z.string().nullable().optional(),
    validatedOperationHash: z.string().optional(),
  },

  checkInputConstraints(ctx, input): void {
    if (input.urlCustomParameters && input.urlCustomParameters.length > ctx.policy.maxCustomParameters) {
      throw new ToolConstraintViolationError('Too many URL custom parameters for this configuration.');
    }
    if (input.finalUrls !== undefined && !ctx.policy.allowFinalUrlChanges) {
      throw new ToolConstraintViolationError('Final URL changes are disabled for this tool.');
    }
    if (input.finalUrlSuffix !== undefined && !ctx.policy.allowFinalUrlSuffixChanges) {
      throw new ToolConstraintViolationError('Final URL suffix changes are disabled for this tool.');
    }
  },

  async fetchState(ctx, input): Promise<TrackingState> {
    const { entityType } = input;
    if (entityType === 'campaign' && !input.campaignId) {
      throw new InvalidArgumentError('campaignId is required when entityType is "campaign".', {});
    }
    if (entityType === 'ad_group' && !input.adGroupId) {
      throw new InvalidArgumentError('adGroupId is required when entityType is "ad_group".', {});
    }
    if (entityType === 'ad' && (!input.adGroupId || !input.adId)) {
      throw new InvalidArgumentError(
        'adGroupId and adId are both required when entityType is "ad".',
        {},
      );
    }

    if (entityType === 'campaign') {
      const page = await ctx.transport.search(
        {
          customerId: ctx.customerId,
          query: `SELECT campaign.id, campaign.name, campaign.resource_name, campaign.tracking_url_template, campaign.final_url_suffix, campaign.url_custom_parameters FROM campaign WHERE campaign.id = ${gaqlIdList([input.campaignId as string])} LIMIT 1`,
        },
        { label: 'tracking_campaign' },
      );
      const c = page.results[0]?.campaign as Record<string, any> | undefined;
      if (!c) throw new ResourceNotFoundError('campaign', input.campaignId as string);
      return {
        resourceName: String(c.resourceName ?? rn.campaign(ctx.customerId, input.campaignId as string)),
        entityName: String(c.name ?? ''),
        trackingUrlTemplate: c.trackingUrlTemplate ?? null,
        finalUrlSuffix: c.finalUrlSuffix ?? null,
        urlCustomParameters: c.urlCustomParameters ?? [],
        finalUrls: [],
      };
    }

    if (entityType === 'ad_group') {
      const page = await ctx.transport.search(
        {
          customerId: ctx.customerId,
          query: `SELECT ad_group.id, ad_group.name, ad_group.resource_name, ad_group.tracking_url_template, ad_group.final_url_suffix, ad_group.url_custom_parameters FROM ad_group WHERE ad_group.id = ${gaqlIdList([input.adGroupId as string])} LIMIT 1`,
        },
        { label: 'tracking_ad_group' },
      );
      const g = page.results[0]?.adGroup as Record<string, any> | undefined;
      if (!g) throw new ResourceNotFoundError('ad_group', input.adGroupId as string);
      return {
        resourceName: String(g.resourceName ?? rn.adGroup(ctx.customerId, input.adGroupId as string)),
        entityName: String(g.name ?? ''),
        trackingUrlTemplate: g.trackingUrlTemplate ?? null,
        finalUrlSuffix: g.finalUrlSuffix ?? null,
        urlCustomParameters: g.urlCustomParameters ?? [],
        finalUrls: [],
      };
    }

    const adGroupAdName = rn.adGroupAd(ctx.customerId, input.adGroupId as string, input.adId as string);
    const page = await ctx.transport.search(
      {
        customerId: ctx.customerId,
        query: `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.final_urls, ad_group_ad.ad.tracking_url_template, ad_group_ad.ad.final_url_suffix, ad_group_ad.ad.url_custom_parameters, ad_group_ad.status FROM ad_group_ad WHERE ad_group_ad.resource_name IN (${gaqlStringList([adGroupAdName])}) LIMIT 1`,
      },
      { label: 'tracking_ad' },
    );
    const ad = (page.results[0]?.adGroupAd as Record<string, any> | undefined)?.ad as
      | Record<string, any>
      | undefined;
    if (!ad) throw new ResourceNotFoundError('ad_group_ad', adGroupAdName);
    return {
      // Ad URL fields are owned by AdService: ad_group_ad only owns status. Updating
      // them through the adGroupAds resource returns IMMUTABLE_FIELD.
      resourceName: rn.ad(ctx.customerId, input.adId as string),
      entityName: String(ad.name ?? input.adId),
      trackingUrlTemplate: ad.trackingUrlTemplate ?? null,
      finalUrlSuffix: ad.finalUrlSuffix ?? null,
      urlCustomParameters: ad.urlCustomParameters ?? [],
      finalUrls: ad.finalUrls ?? [],
    };
  },

  checkConstraints(ctx, input, state): void {
    const policy = ctx.policy;

    if (
      input.trackingUrlTemplate === undefined &&
      input.finalUrlSuffix === undefined &&
      input.urlCustomParameters === undefined &&
      input.finalUrls === undefined
    ) {
      throw new InvalidArgumentError(
        'Supply at least one of trackingUrlTemplate, finalUrlSuffix, urlCustomParameters or finalUrls.',
        {},
      );
    }

    // Optimistic concurrency.
    if (input.expectedCurrentTrackingTemplate !== undefined) {
      const actual = state.trackingUrlTemplate;
      const expected = input.expectedCurrentTrackingTemplate;
      if ((expected ?? null) !== (actual ?? null)) {
        throw new StaleResourceStateError('trackingUrlTemplate', expected, actual, {
          resourceName: state.resourceName,
        });
      }
    }
    if (input.expectedCurrentFinalUrl !== undefined) {
      const actual = state.finalUrls[0] ?? null;
      if (input.expectedCurrentFinalUrl !== actual) {
        throw new StaleResourceStateError('finalUrl', input.expectedCurrentFinalUrl, actual, {
          resourceName: state.resourceName,
        });
      }
    }

    if (!policy.allowFinalUrlChanges) {
      // Defense in depth: finalUrls is not in the schema in this mode, but a direct
      // handler call would otherwise slip past.
      if (input.finalUrls !== undefined) {
        throw new ToolConstraintViolationError('Final URL changes are disabled for this tool.', {
          currentFinalUrl: state.finalUrls[0] ?? null,
          requestedFinalUrl: input.finalUrls[0] ?? null,
        });
      }

      // A tracking template without an {lpurl} placeholder *is* the destination, so
      // permitting one would let a caller redirect clicks while nominally only
      // touching "tracking". A domain comparison alone would not catch this.
      if (
        policy.requireLpurlPlaceholder &&
        typeof input.trackingUrlTemplate === 'string' &&
        input.trackingUrlTemplate.length > 0 &&
        !LPURL_PLACEHOLDERS.some((p) => input.trackingUrlTemplate?.includes(p))
      ) {
        throw new ToolConstraintViolationError(
          'The tracking template must contain an {lpurl} placeholder, otherwise it replaces the ' +
            'destination rather than tracking it. Final URL changes are disabled for this tool.',
          {
            requestedTrackingTemplate: input.trackingUrlTemplate,
            requiredPlaceholders: LPURL_PLACEHOLDERS,
          },
        );
      }

      if (policy.allowedTrackingHosts && typeof input.trackingUrlTemplate === 'string') {
        const hostMatch = /^https?:\/\/([^/?#]+)/i.exec(input.trackingUrlTemplate);
        const host = hostMatch?.[1];
        if (host && !policy.allowedTrackingHosts.includes(host)) {
          throw new ToolConstraintViolationError(
            `Tracking template host "${host}" is not in the configured allowed hosts.`,
            { host, allowedTrackingHosts: policy.allowedTrackingHosts },
          );
        }
      }

      if (input.finalUrlSuffix !== undefined) {
        if (!policy.allowFinalUrlSuffixChanges) {
          throw new ToolConstraintViolationError(
            'Final URL suffix changes are disabled for this tool.',
            {
              currentFinalUrlSuffix: state.finalUrlSuffix,
              requestedFinalUrlSuffix: input.finalUrlSuffix,
            },
          );
        }
        // A suffix may only append query parameters. Anything that could introduce a
        // path, host or fragment would change the effective destination.
        if (typeof input.finalUrlSuffix === 'string' && input.finalUrlSuffix.length > 0) {
          if (/[?#]|\/\//.test(input.finalUrlSuffix)) {
            throw new ToolConstraintViolationError(
              'finalUrlSuffix may only contain key=value pairs joined by "&". It must not ' +
                'contain "?", "#" or "//".',
              { requestedFinalUrlSuffix: input.finalUrlSuffix },
            );
          }
          for (const pair of input.finalUrlSuffix.split('&')) {
            if (pair.length > 0 && !/^[^=&]+=[^=&]*$/.test(pair)) {
              throw new ToolConstraintViolationError(
                `finalUrlSuffix segment "${pair}" is not a key=value pair.`,
                { requestedFinalUrlSuffix: input.finalUrlSuffix },
              );
            }
          }
        }
      }
    }
  },

  detectNoOp(ctx, input, state): Record<string, unknown> | null {
    const sameTemplate =
      input.trackingUrlTemplate === undefined ||
      (input.trackingUrlTemplate ?? null) === (state.trackingUrlTemplate ?? null);
    const sameSuffix =
      input.finalUrlSuffix === undefined ||
      (input.finalUrlSuffix ?? null) === (state.finalUrlSuffix ?? null);
    const sameParams =
      input.urlCustomParameters === undefined ||
      JSON.stringify(input.urlCustomParameters) === JSON.stringify(state.urlCustomParameters);
    const sameUrls =
      input.finalUrls === undefined ||
      JSON.stringify(input.finalUrls) === JSON.stringify(state.finalUrls);

    if (!(sameTemplate && sameSuffix && sameParams && sameUrls)) return null;

    const snapshot = {
      trackingUrlTemplate: state.trackingUrlTemplate,
      finalUrlSuffix: state.finalUrlSuffix,
      urlCustomParameters: state.urlCustomParameters,
      ...(input.entityType === 'ad' && { finalUrls: state.finalUrls }),
    };
    return {
      success: true,
      changed: false,
      customerId: ctx.customerId,
      resourceType: input.entityType,
      resourceId: input.campaignId ?? input.adId ?? input.adGroupId ?? '',
      resourceName: state.resourceName,
      before: snapshot,
      after: snapshot,
      changedFields: [],
      finalUrlChanged: false,
      googleAdsRequestId: null,
      message: `Tracking parameters on ${input.entityType} "${state.entityName}" already match the requested values.`,
    };
  },

  buildOperations(_ctx, input, state): MutateOperation[] {
    const update: Record<string, unknown> = { resourceName: state.resourceName };
    const mask: string[] = [];

    if (input.trackingUrlTemplate !== undefined) {
      update.trackingUrlTemplate = input.trackingUrlTemplate ?? null;
      mask.push('trackingUrlTemplate');
    }
    if (input.finalUrlSuffix !== undefined) {
      update.finalUrlSuffix = input.finalUrlSuffix ?? null;
      mask.push('finalUrlSuffix');
    }
    if (input.urlCustomParameters !== undefined) {
      update.urlCustomParameters = input.urlCustomParameters;
      mask.push('urlCustomParameters');
    }
    if (input.finalUrls !== undefined) {
      update.finalUrls = input.finalUrls;
      mask.push('finalUrls');
    }

    // updateMask is a comma-separated string in the REST JSON encoding.
    const operation = { update, updateMask: mask.join(',') };

    switch (input.entityType) {
      case 'campaign':
        return [{ campaignOperation: operation }];
      case 'ad_group':
        return [{ adGroupOperation: operation }];
      case 'ad':
        return [{ adOperation: operation }];
    }
  },

  buildResult(ctx, input, state, exec): Record<string, unknown> {
    const changedFields: string[] = [];
    if (input.trackingUrlTemplate !== undefined) changedFields.push('trackingUrlTemplate');
    if (input.finalUrlSuffix !== undefined) changedFields.push('finalUrlSuffix');
    if (input.urlCustomParameters !== undefined) changedFields.push('urlCustomParameters');
    if (input.finalUrls !== undefined) changedFields.push('finalUrls');

    const before = {
      trackingUrlTemplate: state.trackingUrlTemplate,
      finalUrlSuffix: state.finalUrlSuffix,
      urlCustomParameters: state.urlCustomParameters,
      ...(input.entityType === 'ad' && { finalUrls: state.finalUrls }),
    };
    const after = {
      trackingUrlTemplate:
        input.trackingUrlTemplate === undefined ? state.trackingUrlTemplate : (input.trackingUrlTemplate ?? null),
      finalUrlSuffix:
        input.finalUrlSuffix === undefined ? state.finalUrlSuffix : (input.finalUrlSuffix ?? null),
      urlCustomParameters: input.urlCustomParameters ?? state.urlCustomParameters,
      ...(input.entityType === 'ad' && { finalUrls: input.finalUrls ?? state.finalUrls }),
    };

    return {
      success: true,
      changed: true,
      customerId: ctx.customerId,
      resourceType: input.entityType,
      resourceId: input.campaignId ?? input.adId ?? input.adGroupId ?? '',
      resourceName: state.resourceName,
      before,
      after,
      changedFields,
      finalUrlChanged: input.finalUrls !== undefined,
      googleAdsRequestId: exec.requestId ?? null,
      validatedOperationHash: exec.operationHash,
      message: `Updated ${changedFields.join(', ')} on ${input.entityType} "${state.entityName}".`,
    };
  },

  canonicalArguments(input): unknown {
    return {
      entityType: input.entityType,
      campaignId: input.campaignId ?? null,
      adGroupId: input.adGroupId ?? null,
      adId: input.adId ?? null,
      changedFields: [
        ...(input.trackingUrlTemplate !== undefined ? ['trackingUrlTemplate'] : []),
        ...(input.finalUrlSuffix !== undefined ? ['finalUrlSuffix'] : []),
        ...(input.urlCustomParameters !== undefined ? ['urlCustomParameters'] : []),
        ...(input.finalUrls !== undefined ? ['finalUrls'] : []),
      ],
    };
  },
};
