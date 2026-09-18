import { z } from 'zod';
import { InvalidArgumentError } from '../../../errors/tool-errors.js';
import { assertReadOnlyGaql } from '../../../google-ads/validation.js';
import { gaqlIdList } from '../../../util/gaql.js';
import { CustomerIdInput, DateInput, NumericIdInput } from '../shared/schemas.js';
import type { Deps, ReadToolDefinition } from '../../../types/index.js';

const MS_PER_DAY = 86_400_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const getChangeHistory: ReadToolDefinition = {
  name: 'get_change_history',
  title: 'Get account change history',
  description:
    'Lists recent changes to campaigns, ad groups, ads and criteria, including who made them ' +
    'and which fields changed. Google only retains 30 days of change history and requires a ' +
    'window no longer than 30 days within that period.',
  inputSchema: {
    customerId: CustomerIdInput,
    startDate: DateInput.optional(),
    endDate: DateInput.optional(),
    campaignIds: z.array(NumericIdInput).max(200).optional(),
    resourceTypes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(20).optional(),
    limit: z.number().int().min(1).max(10000).default(200),
    includeResourcePayloads: z
      .boolean()
      .default(false)
      .describe('Include old/new resource bodies. These can contain full ad copy.'),
  },
  outputSchema: {
    customerId: z.string(),
    window: z.record(z.string(), z.unknown()),
    changes: z.array(z.record(z.string(), z.unknown())),
    rowCount: z.number(),
    truncated: z.boolean(),
    message: z.string(),
  },
  async handler(deps: Deps, input): Promise<Record<string, unknown>> {
    const customerId = input.customerId as string;
    const limit = (input.limit as number | undefined) ?? 200;

    const now = new Date();
    const earliest = new Date(now.getTime() - 29 * MS_PER_DAY);
    const endDate = (input.endDate as string | undefined) ?? isoDate(now);
    const startDate = (input.startDate as string | undefined) ?? isoDate(earliest);

    // Pre-validate rather than surfacing a raw ChangeEventError from the API.
    if (startDate > endDate) {
      throw new InvalidArgumentError('startDate must not be after endDate.', { field: 'startDate' });
    }
    if (startDate < isoDate(earliest)) {
      throw new InvalidArgumentError(
        `Google Ads retains only 30 days of change history. The earliest supported startDate is ${isoDate(earliest)}.`,
        { field: 'startDate', earliestSupported: isoDate(earliest) },
      );
    }
    const spanDays = (Date.parse(endDate) - Date.parse(startDate)) / MS_PER_DAY;
    if (spanDays > 30) {
      throw new InvalidArgumentError('The change history window must not exceed 30 days.', {
        field: 'startDate',
        requestedDays: Math.round(spanDays),
      });
    }

    const filters = [
      `change_event.change_date_time >= '${startDate} 00:00:00'`,
      `change_event.change_date_time <= '${endDate} 23:59:59'`,
    ];
    const campaignIds = input.campaignIds as string[] | undefined;
    if (campaignIds?.length) filters.push(`campaign.id IN (${gaqlIdList(campaignIds)})`);
    const resourceTypes = input.resourceTypes as string[] | undefined;
    if (resourceTypes?.length) {
      filters.push(
        `change_event.change_resource_type IN (${resourceTypes.map((t) => `'${t}'`).join(', ')})`,
      );
    }

    const payloadFields =
      input.includeResourcePayloads === true
        ? ', change_event.old_resource, change_event.new_resource'
        : '';

    // change_event mandates an explicit LIMIT.
    const query = `SELECT change_event.change_date_time, change_event.change_resource_type, change_event.change_resource_name, change_event.resource_change_operation, change_event.changed_fields, change_event.client_type, change_event.user_email, change_event.campaign, change_event.ad_group${payloadFields} FROM change_event WHERE ${filters.join(' AND ')} ORDER BY change_event.change_date_time DESC LIMIT ${limit}`;

    const page = await deps.transport.search({ customerId, query }, { label: 'change_history' });

    const changes = page.results.map((row) => {
      const e = (row.changeEvent ?? {}) as Record<string, any>;
      const changedFields = e.changedFields;
      return {
        changedAt: e.changeDateTime ?? null,
        resourceType: e.changeResourceType ?? null,
        resourceName: e.changeResourceName ?? null,
        operation: e.resourceChangeOperation ?? null,
        changedFields:
          typeof changedFields === 'string'
            ? changedFields.split(',').filter(Boolean)
            : (changedFields?.paths ?? []),
        clientType: e.clientType ?? null,
        userEmail: e.userEmail ?? null,
        campaignId: typeof e.campaign === 'string' ? (e.campaign.split('/').pop() ?? null) : null,
        adGroupId: typeof e.adGroup === 'string' ? (e.adGroup.split('/').pop() ?? null) : null,
        ...(input.includeResourcePayloads === true && {
          oldResource: e.oldResource ?? null,
          newResource: e.newResource ?? null,
        }),
      };
    });

    return {
      customerId,
      window: { startDate, endDate },
      changes,
      rowCount: changes.length,
      truncated: changes.length >= limit,
      message: `${changes.length} change(s) between ${startDate} and ${endDate}.`,
    };
  },
};

export const searchGoogleAds: ReadToolDefinition = {
  name: 'search_google_ads',
  title: 'Run a read-only GAQL query',
  description:
    'Runs a single read-only Google Ads Query Language SELECT statement against an ' +
    'authorized account and returns the raw rows. Only SELECT is permitted; multiple ' +
    'statements, comments and non-reporting resources such as billing and user access are ' +
    'rejected. The account is fixed by the customerId argument and cannot be changed by the ' +
    'query text. A row limit and a request timeout are enforced.',
  inputSchema: {
    customerId: CustomerIdInput,
    query: z.string().min(10).max(8000).describe('A single GAQL SELECT statement.'),
    limit: z.number().int().min(1).max(10000).optional(),
    pageToken: z.string().min(1).optional(),
  },
  outputSchema: {
    customerId: z.string(),
    appliedQuery: z.string(),
    resource: z.string(),
    rows: z.array(z.record(z.string(), z.unknown())),
    fieldMask: z.string().nullable(),
    rowCount: z.number(),
    nextPageToken: z.string().optional(),
    totalResultsCount: z.string().nullable(),
    googleAdsRequestId: z.string().nullable(),
    message: z.string(),
  },
  async handler(deps: Deps, input): Promise<Record<string, unknown>> {
    const settings = deps.config.reads.searchGoogleAds;
    if (!settings.enabled) {
      throw new InvalidArgumentError('search_google_ads is disabled on this server.', {});
    }
    const customerId = input.customerId as string;
    const requestedLimit = input.limit as number | undefined;
    const maxRowLimit =
      requestedLimit === undefined
        ? settings.maxRowLimit
        : Math.min(requestedLimit, settings.maxRowLimit);

    const guard = assertReadOnlyGaql(input.query as string, {
      maxRowLimit,
      blockedResources: settings.blockedResources,
    });

    const page = await deps.transport.search(
      {
        customerId,
        query: guard.query,
        returnTotalResultsCount: true,
        ...(typeof input.pageToken === 'string' && { pageToken: input.pageToken }),
      },
      { label: 'search_google_ads', timeoutMs: deps.config.reads.requestTimeoutMs },
    );

    return {
      customerId,
      appliedQuery: guard.query,
      resource: guard.resource,
      rows: page.results,
      fieldMask: page.fieldMask ?? null,
      rowCount: page.results.length,
      ...(page.nextPageToken !== undefined && { nextPageToken: page.nextPageToken }),
      totalResultsCount: page.totalResultsCount ?? null,
      googleAdsRequestId: page.meta.requestId ?? null,
      message: `${page.results.length} row(s) from ${guard.resource} (limit ${guard.appliedLimit}).`,
    };
  },
};
