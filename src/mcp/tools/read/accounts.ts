import { z } from 'zod';
import { ResourceNotFoundError } from '../../../errors/tool-errors.js';
import { formatMicros } from '../../../util/micros.js';
import { resolveDateRange, dateRangeShape } from '../shared/date-range.js';
import { mapMetrics } from '../shared/performance.js';
import { CustomerIdInput } from '../shared/schemas.js';
import type { Deps, ReadToolDefinition } from '../../../types/index.js';

export const listAccessibleAccounts: ReadToolDefinition = {
  name: 'list_accessible_accounts',
  title: 'List accessible Google Ads accounts',
  description:
    'Lists the Google Ads accounts this server is allowed to work with. The configured ' +
    'allowlist is authoritative: an account absent from it cannot be reached by any tool, ' +
    'even if the credentials could otherwise access it.',
  inputSchema: {
    includeDetails: z
      .boolean()
      .default(true)
      .describe('Fetch name, currency and timezone for each allowlisted account.'),
  },
  outputSchema: {
    loginCustomerId: z.string(),
    accounts: z.array(z.record(z.string(), z.unknown())),
    allowlistedCount: z.number(),
    directlyAccessibleCount: z.number(),
    queryableCount: z.number(),
    message: z.string(),
  },
  async handler(deps: Deps, input): Promise<Record<string, unknown>> {
    const includeDetails = input.includeDetails !== false;

    // listAccessibleCustomers returns only accounts directly accessible to the OAuth
    // user; a manager's children usually are not in it. It is informational only.
    let directlyAccessible: string[] = [];
    try {
      const result = await deps.transport.listAccessibleCustomers({ label: 'list_accessible' });
      directlyAccessible = result.customerIds;
    } catch {
      // Informational only - the allowlist is authoritative, so this must not fail the tool.
    }

    const accounts: Record<string, unknown>[] = [];
    for (const customerId of deps.allowlist.list()) {
      const entry: Record<string, unknown> = {
        customerId,
        resourceName: `customers/${customerId}`,
        directlyAccessible: directlyAccessible.includes(customerId),
        queryable: true,
      };
      if (includeDetails) {
        try {
          const page = await deps.transport.search(
            {
              customerId,
              query:
                'SELECT customer.id, customer.descriptive_name, customer.currency_code, ' +
                'customer.time_zone, customer.manager, customer.test_account, customer.status, ' +
                'customer.auto_tagging_enabled FROM customer LIMIT 1',
            },
            { label: 'account_details' },
          );
          const c = (page.results[0]?.customer ?? {}) as Record<string, unknown>;
          Object.assign(entry, {
            descriptiveName: c.descriptiveName ?? null,
            currencyCode: c.currencyCode ?? null,
            timeZone: c.timeZone ?? null,
            manager: c.manager === true,
            testAccount: c.testAccount === true,
            status: c.status ?? null,
            autoTaggingEnabled: c.autoTaggingEnabled === true,
          });
        } catch (err) {
          entry.queryable = false;
          entry.unavailableReason =
            err instanceof Error ? err.message : 'Account could not be queried.';
        }
      }
      accounts.push(entry);
    }

    const directCount = accounts.filter((a) => a.directlyAccessible === true).length;
    const queryable = accounts.filter((a) => a.queryable === true).length;

    // A manager's children are reachable without appearing in listAccessibleCustomers,
    // so a zero there is normal. Nothing queryable is not: that means the credentials
    // or the developer token are not working, and the summary has to say so rather
    // than reporting a cheerful count of accounts nobody can reach.
    const message = !includeDetails
      ? `${accounts.length} allowlisted account(s); ${directCount} directly accessible to these credentials.`
      : queryable === 0
        ? `${accounts.length} allowlisted account(s), but NONE could be queried. Check the ` +
          'developer token, the OAuth credentials, and that the login customer ID manages these accounts.'
        : `${accounts.length} allowlisted account(s); ${queryable} queryable, ${directCount} directly accessible to these credentials.`;

    return {
      loginCustomerId: deps.config.accounts.allowedCustomerIds[0] ?? '',
      accounts,
      allowlistedCount: accounts.length,
      directlyAccessibleCount: directCount,
      queryableCount: queryable,
      message,
    };
  },
};

export const getAccountSummary: ReadToolDefinition = {
  name: 'get_account_summary',
  title: 'Get Google Ads account summary',
  description:
    'Returns account identity, campaign counts by status, and headline performance totals ' +
    'for a date range.',
  inputSchema: {
    customerId: CustomerIdInput,
    ...dateRangeShape,
  },
  outputSchema: {
    customerId: z.string(),
    descriptiveName: z.string().nullable(),
    currencyCode: z.string().nullable(),
    timeZone: z.string().nullable(),
    status: z.string().nullable(),
    manager: z.boolean(),
    testAccount: z.boolean(),
    optimizationScore: z.number().nullable(),
    dateRange: z.record(z.string(), z.unknown()),
    totals: z.record(z.string(), z.unknown()),
    campaignCounts: z.record(z.string(), z.number()),
    message: z.string(),
  },
  async handler(deps: Deps, input): Promise<Record<string, unknown>> {
    const customerId = input.customerId as string;
    const range = resolveDateRange(input);

    const identity = await deps.transport.search(
      {
        customerId,
        query:
          'SELECT customer.id, customer.descriptive_name, customer.currency_code, ' +
          'customer.time_zone, customer.status, customer.manager, customer.test_account, ' +
          'customer.optimization_score, customer.auto_tagging_enabled FROM customer LIMIT 1',
      },
      { label: 'account_identity' },
    );
    const c = identity.results[0]?.customer as Record<string, unknown> | undefined;
    if (!c) throw new ResourceNotFoundError('customer', customerId);

    const perf = await deps.transport.search(
      {
        customerId,
        query:
          'SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.ctr, ' +
          'metrics.average_cpc, metrics.conversions, metrics.conversions_value, ' +
          'metrics.cost_per_conversion, metrics.all_conversions ' +
          `FROM customer WHERE ${range.clause}`,
      },
      { label: 'account_totals' },
    );
    const totals = mapMetrics(perf.results[0] ?? {});

    // GAQL has no COUNT or GROUP BY, so counts are aggregated here.
    const campaigns = await deps.transport.searchPaginated(
      {
        customerId,
        query: "SELECT campaign.id, campaign.status FROM campaign WHERE campaign.status != 'REMOVED'",
        maxRows: deps.config.reads.maxRowLimit,
      },
      { label: 'campaign_counts' },
    );
    let enabled = 0;
    let paused = 0;
    for (const row of campaigns.rows) {
      const status = (row.campaign as Record<string, unknown> | undefined)?.status;
      if (status === 'ENABLED') enabled += 1;
      else if (status === 'PAUSED') paused += 1;
    }

    const currency = typeof c.currencyCode === 'string' ? c.currencyCode : undefined;
    return {
      customerId,
      descriptiveName: (c.descriptiveName as string) ?? null,
      currencyCode: currency ?? null,
      timeZone: (c.timeZone as string) ?? null,
      status: (c.status as string) ?? null,
      manager: c.manager === true,
      testAccount: c.testAccount === true,
      optimizationScore: typeof c.optimizationScore === 'number' ? c.optimizationScore : null,
      dateRange: { ...range, clause: undefined },
      totals,
      campaignCounts: { enabled, paused, total: enabled + paused },
      message:
        `${String(c.descriptiveName ?? customerId)}: ${enabled} enabled and ${paused} paused ` +
        `campaigns; ${totals.clicks} clicks and ${formatMicros(BigInt(totals.costMicros), currency)} ` +
        `spend over the selected range.`,
    };
  },
};
