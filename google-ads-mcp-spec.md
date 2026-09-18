Implement a mutable Google Ads MCP server that works with standard, spec-compliant MCP clients.

## Objective

Build an MCP server that allows agents to inspect and manage Google Ads accounts through the Google Ads API.

The server must:

- Expose standard MCP tools through `tools/list` and `tools/call`.
- Work with ordinary MCP clients.
- Leave human-in-the-loop confirmation to the MCP client.
- Not require proof that the client displayed a confirmation.
- Not require custom approval fields, signed approval tokens, proprietary MCP extensions, or a custom client.
- Enforce account scope, enabled capabilities, input validation, current-state checks, and Google Ads API validation on the server.

This is a tool server, not an approval system.

## Explicitly out of scope

Do not create:

- An administrative HTTP API
- An approval web application
- A server-side approval queue
- A proposal database
- An approval service
- Signed approval assertions
- Custom MCP transport extensions
- A proprietary MCP client
- A generic risk-classification engine
- A general-purpose policy expression language

Do not add fields such as:

```text
approved
approvalToken
approvedBy
proposalId
riskLevel
```

to mutation tool inputs.

The server does not need to know whether a human approved a mutation. That is the MCP client’s responsibility.

## Technology

Use:

- TypeScript
- Node.js
- The official MCP TypeScript SDK
- The official Google Ads API or an appropriate maintained Google Ads API client
- Zod or equivalent runtime schema validation
- Structured JSON logging

Include:

- Dockerfile
- Environment-variable configuration
- Typed capability configuration
- Unit tests
- Integration tests using mocked Google Ads API responses
- README
- Example MCP client configuration

## Repository and deployment context

This server is a new, standalone repository. It is sovereign-unaware: it must not import from or depend on any agent-platform codebase, and there is no existing architecture to inspect or follow — this spec is the source of conventions.

The primary deployment target is a stdio MCP server co-located with its MCP client, launched from the client's MCP configuration file, with credentials supplied through environment variables. The Dockerfile exists for development and testing convenience. Remote HTTP hosting is out of scope for the initial version; do not build transport authentication for it.

## Authentication and Google Ads account access

Support access through a Google Ads manager account.

Configuration must support:

```text
GOOGLE_ADS_DEVELOPER_TOKEN
GOOGLE_ADS_CLIENT_ID
GOOGLE_ADS_CLIENT_SECRET
GOOGLE_ADS_REFRESH_TOKEN
GOOGLE_ADS_LOGIN_CUSTOMER_ID
```

Do not implement a service-account authentication path in the initial version.

Normalize customer IDs internally by removing dashes.

Maintain an explicit allowlist of accessible Google Ads customer IDs:

```yaml
accounts:
  allowedCustomerIds:
    - '1234567890'
    - '2345678901'
```

Every tool must authorize the requested customer ID before making a Google Ads API call.

The server must never allow the model to access an arbitrary customer ID merely because it was supplied as a tool argument.

The server runs as a local stdio process; process access is the caller identity. Do not invent a multi-tenant user authorization system.

## MCP behavior

Expose ordinary MCP tools using the standard protocol.

Mutation tools should use appropriate MCP tool annotations where supported, for example:

```ts
{
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true
}
```

These annotations are client-facing hints. They are not authorization mechanisms and must not change server behavior based on whether a client displays a confirmation.

Write clear mutation tool titles and descriptions so a client can present understandable approval UI.

For example, `pause_campaign` should describe the campaign state change.

`set_campaign_budget` must explicitly state that it changes an advertising budget and may affect charges.

## Tool registration model

Divide the implementation into:

1. Read-only tools
2. Enabled mutation tools
3. Disabled or unsupported capabilities

Use a default-deny capability configuration.

Only register mutation tools that are explicitly enabled.

Disabled tools should normally be omitted from `tools/list`, rather than registered and rejected later.

Example:

```yaml
mutations:
  enabled: true
  default: deny

  tools:
    pause_campaign:
      enabled: true
      maxResourcesPerCall: 1

    enable_campaign:
      enabled: true
      maxResourcesPerCall: 1

    pause_ad_group:
      enabled: true
      maxResourcesPerCall: 1

    enable_ad_group:
      enabled: true
      maxResourcesPerCall: 1

    pause_ad:
      enabled: true
      maxResourcesPerCall: 10

    enable_ad:
      enabled: true
      maxResourcesPerCall: 10

    pause_keyword:
      enabled: true
      maxResourcesPerCall: 20

    enable_keyword:
      enabled: true
      maxResourcesPerCall: 20

    add_negative_keyword:
      enabled: true
      maxResourcesPerCall: 20

    remove_negative_keyword:
      enabled: true
      maxResourcesPerCall: 20

    create_paused_ad:
      enabled: true
      maxResourcesPerCall: 10

    create_paused_keyword:
      enabled: true
      maxResourcesPerCall: 20

    dismiss_recommendation:
      enabled: true
      maxResourcesPerCall: 20

    update_tracking_parameters:
      enabled: true
      allowFinalUrlChanges: false

    set_campaign_budget:
      enabled: true
      maxResourcesPerCall: 1

budgets:
  masterBudgetMicros: '500000000'
```

List only implemented tools in the configuration. Enabling an unknown tool name fails startup, so the example configuration must not carry keys for tools that do not exist.

There should be no generic classification such as:

```ts
type RiskLevel = 'low' | 'medium' | 'high' | 'prohibited';
```

The operational decision must come from concrete capability settings and tool-specific constraints.

## Read-only tools

Implement at least:

```text
list_accessible_accounts
get_account_summary
list_campaigns
get_campaign
get_campaign_performance
get_ad_group_performance
get_keyword_performance
get_search_terms
list_negative_keywords
list_recommendations
get_conversion_actions
get_bidding_strategy_status
get_budget_pacing
get_change_history
search_google_ads
```

Reporting tools should support:

- Authorized customer selection
- Date ranges
- Pagination
- Configurable row limits
- Common reporting segments
- Structured results
- Human-readable summaries

`get_budget_pacing` must include the account's current total across distinct budget resources and the configured master budget, so the client can compute headroom without a mutation attempt.

### GAQL search

`search_google_ads` may expose controlled GAQL reporting.

It must:

- Permit only `SELECT` queries
- Reject malformed statements
- Reject multiple statements
- Enforce the authorized customer ID independently of the query
- Enforce a maximum row count
- Enforce pagination limits
- Enforce a timeout
- Avoid logging credentials or authorization headers

Do not expose a generic Google Ads mutate operation.

## Initial mutation tools

Implement narrowly scoped mutation tools rather than raw Google Ads operations.

Initial tools should include:

```text
pause_campaign
enable_campaign
pause_ad_group
enable_ad_group
pause_ad
enable_ad
pause_keyword
enable_keyword
add_negative_keyword
remove_negative_keyword
create_paused_ad
create_paused_keyword
dismiss_recommendation
update_tracking_parameters
set_campaign_budget
```

Additional narrowly scoped mutations may be added if they fit the same design.

Do not expose:

```text
execute_arbitrary_mutation
raw_google_ads_mutate
execute_protobuf_operation
mutate_resource
```

Each mutation tool must represent one understandable business operation.

`create_paused_ad` / `create_paused_keyword` paired with `enable_ad` / `enable_keyword` is a staging and idempotency pattern, not a review gate: a client holding both tools can create and then enable in two calls. Do not present paused creation as an approval mechanism.

## Initially prohibited capabilities

Do not implement or register tools for:

- Shared-budget mutations
- Billing changes
- Payment-method changes
- User-access changes
- Account-access changes
- Manager-account linking
- Customer-account creation
- Campaign creation
- Campaign deletion
- Conversion-action deletion
- Arbitrary raw mutations
- Cross-customer bulk mutations

Campaign creation is the most likely later addition. Do not design for it speculatively, and do not design a generic risk engine in anticipation of any future capability.

## Typed, tool-specific constraints

Each enabled mutation tool must have its own typed configuration schema.

Do not introduce a generic rule language.

Example:

```ts
const PauseCampaignPolicySchema = z.object({
  enabled: z.boolean(),
  maxResourcesPerCall: z.number().int().positive().max(100),
});

const NegativeKeywordPolicySchema = z.object({
  enabled: z.boolean(),
  maxResourcesPerCall: z.number().int().positive().max(1000),
  allowedMatchTypes: z.array(z.enum(['EXACT', 'PHRASE', 'BROAD'])).optional(),
});

const TrackingParameterPolicySchema = z.object({
  enabled: z.boolean(),
  allowFinalUrlChanges: z.boolean(),
});

const SetCampaignBudgetPolicySchema = z.object({
  enabled: z.boolean(),
  maxResourcesPerCall: z.number().int().positive().max(1),
});
```

Tool-specific constraints should be objective and locally enforceable, such as:

- Maximum resources per call
- Allowed keyword match types
- Whether final URLs may change
- Whether destination domains must remain unchanged
- Whether an operation may create only paused resources
- Whether a budget change keeps the account's total daily budget within the configured master budget
- Maximum text or collection sizes
- Allowed campaign types
- Allowed recommendation types

Do not attempt to encode subjective campaign-management decisions such as whether a campaign is performing poorly enough to pause.

## Mutation execution pipeline

Use a consistent mutation pipeline:

```text
MCP tools/call
→ validate input schema
→ normalize customer ID
→ authorize customer ID
→ confirm that the tool is enabled
→ fetch authoritative current resource state
→ apply tool-specific constraints
→ construct the exact Google Ads mutation
→ run validate_only where supported
→ execute the exact mutation
→ return structured before/after state
→ write a structured audit event
```

The client-side confirmation is not part of this server pipeline.

## Current-state checks

Mutation tools must fetch current Google Ads state before execution.

Where useful, accept optional expected-current-state fields:

```text
expectedCurrentStatus
expectedCurrentFinalUrl
expectedCurrentTrackingTemplate
```

Example input:

```ts
{
  customerId: string;
  campaignId: string;
  expectedCurrentStatus?: "ENABLED" | "PAUSED";
}
```

If an expected value is supplied and the current resource no longer matches it, reject the operation with:

```text
STALE_RESOURCE_STATE
```

This provides optimistic concurrency protection without introducing a proposal or approval workflow.

Example:

```ts
if (input.expectedCurrentStatus && campaign.status !== input.expectedCurrentStatus) {
  throw new StaleResourceStateError({
    expected: input.expectedCurrentStatus,
    actual: campaign.status,
  });
}
```

## Idempotent behavior

Make mutation tools naturally idempotent where possible.

Examples:

- Pausing an already paused campaign should return a successful no-op.
- Enabling an already enabled ad group should return a successful no-op.
- Adding an already existing negative keyword should return an existing-resource or no-op result.
- Removing a negative keyword that no longer exists should return a clear no-op or not-found result according to the tool contract.

Return whether the call changed anything:

```json
{
  "success": true,
  "changed": false,
  "message": "Campaign was already paused."
}
```

Do not build a large generic idempotency subsystem.

Use resource-state checks and deterministic operations first.

## Google Ads validation

Use Google Ads `validate_only=true` before executing supported mutations.

Validation must be performed on the same operation that will subsequently be executed.

The sequence should be:

```ts
const operation = buildOperation(currentResource, input);

await googleAds.mutate({
  customerId,
  operations: [operation],
  validateOnly: true,
  partialFailure: false,
});

const response = await googleAds.mutate({
  customerId,
  operations: [operation],
  validateOnly: false,
  partialFailure: false,
});
```

Do not allow model-controlled data to alter the mutation between validation and execution.

Google Ads validation does not replace:

- Customer authorization
- Capability enablement
- Input validation
- Tool-specific constraints
- Current-state checks

## Partial failures and bulk operations

Default mutation requests to:

```ts
partialFailure: false;
```

For operations that are logically interdependent, do not permit partial success.

Bulk tools must have explicit maximum sizes.

Example:

```yaml
add_negative_keyword:
  enabled: true
  maxResourcesPerCall: 20
```

Do not claim that arbitrary multi-service workflows are atomic.

Do not implement automatic rollback unless the API operation and failure behavior make it reliable. A compensating mutation is not equivalent to a transaction.

## Shared resources

Handle shared Google Ads resources explicitly.

For example, multiple campaigns may reference the same campaign-budget resource.

Budget resources are not one-to-one with campaigns. Treat resource names and IDs correctly, count each distinct budget resource once when computing the account total for the master-budget invariant, and reject mutations of explicitly shared budgets.

For other shared resources, reject an operation when its effect cannot be represented safely by the tool contract.

Return a specific structured error rather than guessing.

## Tool-specific behavior

### `pause_campaign`

Input:

```ts
{
  customerId: string;
  campaignId: string;
  expectedCurrentStatus?: "ENABLED" | "PAUSED";
}
```

Behavior:

1. Authorize the customer.
2. Fetch the campaign.
3. Reject stale expected state.
4. Return a no-op if already paused.
5. Validate the pause operation.
6. Execute it.
7. Return before and after state.

### `enable_campaign`

Use the same behavior in reverse.

Do not silently enable removed campaigns or unsupported campaign states.

### `add_negative_keyword`

Input should include:

```ts
{
  customerId: string;
  campaignId?: string;
  adGroupId?: string;
  text: string;
  matchType: "EXACT" | "PHRASE" | "BROAD";
}
```

Require exactly one target scope where appropriate.

Enforce:

- Maximum text length
- Allowed match types
- Maximum operations per call
- Duplicate detection
- Correct campaign or ad-group ownership

### `remove_negative_keyword`

Require a concrete criterion resource ID or resource name when possible.

Do not remove negatives based solely on ambiguous text matching if more than one resource may match.

### `create_paused_ad`

The created resource must be paused.

Do not accept an `enabled` argument.

Validate all required Google Ads fields and return policy or API errors clearly.

### `create_paused_keyword`

The created criterion must be paused.

Do not accept an active status in the input.

### `update_tracking_parameters`

Permit changes only to explicitly supported tracking fields.

If configuration says:

```yaml
allowFinalUrlChanges: false
```

reject any request that would change the effective destination URL.

Do not treat a domain comparison alone as sufficient if path or query changes are also prohibited by the configured tool contract.

### `dismiss_recommendation`

Require a concrete recommendation resource name or ID.

Do not implement “apply recommendation” in the initial version.

### `set_campaign_budget`

Input:

```ts
{
  customerId: string;
  budgetId: string;
  amountMicros: string;
  expectedCurrentAmountMicros?: string;
}
```

Address the budget resource directly, not through a campaign ID, so a shared budget cannot be mutated by accident through one of its campaigns.

Behavior:

1. Authorize the customer.
2. Fetch the budget resource and the campaigns that reference it.
3. Reject explicitly shared budgets with `UNSUPPORTED_RESOURCE_STATE`.
4. Reject stale expected amount.
5. Return a no-op if the amount is unchanged.
6. Compute the prospective account total: the sum of `amount_micros` across all distinct budget resources referenced by non-removed campaigns, with this budget's amount replaced by the requested amount. If the total would exceed `budgets.masterBudgetMicros`, reject with `TOOL_CONSTRAINT_VIOLATION`, including the current total, the prospective total, and the master budget in the structured error details.
7. Validate the mutation.
8. Execute it.
9. Return before and after state, including the account totals.

Increases and decreases are both permitted; the master-budget invariant is the only budget-level constraint. Do not add per-call change-percent limits or increase/decrease switches. Google Ads API validation determines the minimum acceptable amount.

## Tool responses

Return structured output and a concise human-readable message.

Example:

```json
{
  "success": true,
  "changed": true,
  "customerId": "1234567890",
  "resourceType": "campaign",
  "resourceId": "456",
  "before": {
    "status": "ENABLED"
  },
  "after": {
    "status": "PAUSED"
  },
  "googleAdsRequestId": "request-id",
  "message": "Paused campaign \"US Search — Brand\"."
}
```

For a no-op:

```json
{
  "success": true,
  "changed": false,
  "customerId": "1234567890",
  "resourceType": "campaign",
  "resourceId": "456",
  "before": {
    "status": "PAUSED"
  },
  "after": {
    "status": "PAUSED"
  },
  "message": "Campaign was already paused."
}
```

For a constraint failure:

```json
{
  "success": false,
  "error": {
    "code": "TOOL_CONSTRAINT_VIOLATION",
    "message": "Final URL changes are disabled for this tool.",
    "details": {
      "currentFinalUrl": "https://example.com/a",
      "requestedFinalUrl": "https://example.com/b"
    }
  }
}
```

## Error codes

Use stable structured error codes:

```text
UNAUTHORIZED_CUSTOMER
TOOL_DISABLED
INVALID_ARGUMENT
RESOURCE_NOT_FOUND
STALE_RESOURCE_STATE
UNSUPPORTED_RESOURCE_STATE
TOOL_CONSTRAINT_VIOLATION
MAX_OPERATIONS_EXCEEDED
DUPLICATE_RESOURCE
VALIDATION_FAILED
GOOGLE_ADS_API_ERROR
RATE_LIMITED
TEMPORARY_FAILURE
```

Do not return:

- OAuth tokens
- Refresh tokens
- Developer tokens
- Client secrets
- Authorization headers
- Raw stack traces
- Unsanitized internal API responses

Map Google Ads API errors into sanitized, actionable tool errors.

## Audit logging

Write a structured audit event for every mutation attempt, including denied attempts.

The initial implementation may use structured JSON logs. Do not create a separate HTTP audit service.

Example:

```ts
interface AuditEvent {
  timestamp: string;
  customerId?: string;
  toolName: string;
  canonicalArguments: unknown;
  result: 'denied' | 'validation_failed' | 'executed' | 'no_op' | 'failed';
  errorCode?: string;
  googleAdsRequestId?: string;
  beforeState?: unknown;
  afterState?: unknown;
}
```

Redact:

- Developer tokens
- OAuth tokens
- Refresh tokens
- Client secrets
- Authorization headers
- Any credential-bearing configuration

Avoid logging full advertising content when IDs and operation metadata are sufficient.

## Global mutation controls

Support a simple global mutation switch:

```yaml
mutations:
  enabled: true
  default: deny
```

Also support an environment-level emergency kill switch:

```text
GOOGLE_ADS_MUTATIONS_ENABLED=false
```

Both must permit read-only tools to continue working.

If mutations are globally disabled, do not register mutation tools, or reject them consistently if the MCP SDK registration model requires static registration.

Prefer omission from `tools/list`.

## Configuration behavior

Validate all configuration at startup.

Fail closed when:

- The customer allowlist is missing
- Mutation configuration is malformed
- An unknown mutation tool is enabled
- A tool constraint has an invalid value
- `set_campaign_budget` is enabled and `budgets.masterBudgetMicros` is missing or invalid
- Required Google Ads credentials are absent

Do not silently ignore invalid or misspelled configuration keys.

Keep capability configuration typed and versionable.

Suggested structure:

```text
src/
  config/
    env.ts
    schema.ts
    load-config.ts
  mcp/
    server.ts
    register-tools.ts
    tools/
      read/
      mutations/
  google-ads/
    client.ts
    queries/
    mutations/
    validation.ts
    errors.ts
  authorization/
    customer-allowlist.ts
  capabilities/
    schema.ts
    registry.ts
    default-config.yaml
  audit/
    logger.ts
    redaction.ts
  errors/
    tool-errors.ts
  types/
tests/
```

## Budget mutations and the master budget

Budget control is a first-class initial capability, shaped as free allocation under an operator-owned ceiling.

```yaml
budgets:
  masterBudgetMicros: '500000000'
```

`masterBudgetMicros` is operator-owned configuration. No tool may change it, and no tool that changes it may be added.

The single budget invariant: after every budget mutation, the sum of `amount_micros` across all distinct, non-removed campaign budget resources in the account must remain less than or equal to `masterBudgetMicros`. Within that ceiling the client allocates freely — increases, decreases, and concentration of spend are all permitted, with no per-call change-percent limits and no increase/decrease switches.

Sum over distinct budget resources, not campaigns, so a shared budget referenced by several campaigns counts once. Sum regardless of campaign status, so pausing or enabling a campaign never changes the total and `pause_campaign` / `enable_campaign` need no budget logic; the client reclaims headroom from a paused campaign by lowering its budget.

Do not implement `reallocate_campaign_budgets`. Reallocation is two `set_campaign_budget` calls under the same invariant, and an equal-total constraint would forbid deliberately scaling total spend down.

All money values must use integer micros and `bigint` or decimal-safe string handling. Never use JavaScript floating-point numbers for budget arithmetic.

The master budget is a working constraint, not a spend guarantee: Google Ads may deliver up to roughly twice a daily budget on a given day. Do not claim that the sum of campaign budgets is equivalent to a guaranteed account spend cap. The README must state this plainly and instruct the operator to additionally set an account-level spend limit inside Google Ads itself; that Google-side limit is the hard wall, and the server invariant is the constraint the client plans against.

## Tests

Add unit and integration tests for:

### MCP behavior

- Standard `tools/list`
- Standard `tools/call`
- No custom approval arguments
- No admin API dependency
- Disabled tools omitted from discovery
- Mutation annotations included where supported

### Authorization

- Customer ID normalization
- Authorized customer access
- Unauthorized customer rejection before Google Ads calls
- Missing customer allowlist fails startup

### Capability configuration

- Default-deny behavior
- Enabled tools are registered
- Disabled tools are not registered
- Unknown tool configuration fails startup
- Invalid tool constraints fail startup
- `set_campaign_budget` enabled without a master budget fails startup
- Global mutation kill switch

### Mutation behavior

- Pause enabled campaign
- Pause already paused campaign as no-op
- Enable paused campaign
- Stale expected status rejection
- Add negative keyword
- Duplicate negative keyword handling
- Remove negative keyword by concrete resource identity
- Create paused ad
- Create paused keyword
- Reject attempts to create enabled resources through paused-creation tools
- Tracking update with final URL unchanged
- Final URL change rejected when disabled
- Dismiss recommendation
- Set campaign budget within the master budget
- Budget change exceeding the master budget rejected before Google Ads calls
- Shared-budget mutation rejected
- Budget no-op when the amount is unchanged
- Stale expected budget amount rejection
- Shared budget counted once in the account total

### Google Ads integration

- `validate_only` called before execution
- Exact validated operation is executed
- Validation failure prevents execution
- `partialFailure` disabled for interdependent operations
- Rate-limit errors mapped correctly
- API errors sanitized
- Google Ads request ID returned and logged

### Logging

- Mutation success audit event
- No-op audit event
- Denied mutation audit event
- Validation failure audit event
- Credential redaction

### Explicit exclusions

- No reallocate or bulk budget tool
- No raw mutate tool
- No billing tools
- No account-access tools
- No manager-linking tools
- No server-side approval endpoints

## End-to-end scenarios

### Scenario 1: Standard client pause

A standard MCP client discovers `pause_campaign` through `tools/list`.

It invokes the tool through `tools/call` using only the documented input schema.

The server does not require proof that the client showed a confirmation.

The server authorizes the customer, checks current state, validates the Google Ads operation, executes it, and returns before and after state.

### Scenario 2: Confirmation-independent behavior

Two spec-compliant clients call the same mutation tool.

One displays an interactive confirmation and the other does not.

The server receives the same standard tool call and behaves identically.

### Scenario 3: Unauthorized customer

A client calls a mutation tool using a customer ID outside the configured allowlist.

The server rejects the operation before calling Google Ads.

### Scenario 4: Master budget exceeded

A client calls `set_campaign_budget` with an amount that would push the sum across distinct budget resources above `budgets.masterBudgetMicros`.

The server rejects with `TOOL_CONSTRAINT_VIOLATION` before calling Google Ads.

The structured error details include the current total, the prospective total, and the master budget.

### Scenario 5: Stale campaign state

The client requests that a campaign be paused and supplies:

```json
{
  "expectedCurrentStatus": "ENABLED"
}
```

The campaign is already paused when the server fetches it.

The server rejects with `STALE_RESOURCE_STATE`, rather than assuming the client’s previously observed state is still valid.

### Scenario 6: No-op retry

The client retries `pause_campaign` after a timeout.

The campaign is already paused.

The server returns a successful no-op and does not issue an unnecessary mutation.

### Scenario 7: Tracking constraint

The client attempts to update tracking parameters while also changing the final URL.

The configured tool does not permit final URL changes.

The server rejects the call with `TOOL_CONSTRAINT_VIOLATION`.

## Deliverables

Produce:

1. Working Google Ads MCP server.
2. Read-only Google Ads tools.
3. Explicitly enabled mutation tools, including `set_campaign_budget` under the master-budget invariant.
4. Typed capability configuration.
5. Customer allowlist enforcement.
6. Current-state checks.
7. Google Ads `validate_only` integration.
8. Structured mutation results.
9. Structured audit logging.
10. Docker development setup.
11. Unit and integration tests.
12. Example standard MCP client configuration.
13. README covering:
    - Architecture
    - MCP client compatibility
    - Client-side HITL boundary
    - Google Ads authentication
    - Manager-account setup
    - Customer allowlisting
    - Read tool catalog
    - Mutation tool catalog
    - Capability configuration
    - Master budget model, and why it is not a spend guarantee
    - Tool-specific constraints
    - Current-state protection
    - Validation behavior
    - Logging and redaction
    - Local development
    - Testing
    - Production limitations
    - Explicitly unsupported operations

## Implementation process

This is a greenfield standalone repository; there is no existing code to inspect.

Before writing implementation code, report:

1. The repository layout you intend to create.
2. The Google Ads API client library you selected and why.
3. Any assumptions that materially affect authentication or Google Ads API behavior.

Then implement the system.

Run all available:

- Tests
- Type checks
- Linters
- Build commands

At completion, report:

- Files changed
- Tools implemented
- Configuration added
- Tests run and results
- Remaining limitations
- Security-sensitive decisions
- Google Ads API behavior that could not be verified locally

Do not add an approval service, admin API, proposal workflow, or generic risk engine.
