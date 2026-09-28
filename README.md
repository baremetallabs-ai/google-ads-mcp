# google-ads-mcp

A Model Context Protocol server that lets an agent inspect **and change** a Google Ads
account through narrowly scoped tools, with every safety property enforced on the
server: an account allowlist, default-deny capability configuration, authoritative
current-state checks, Google Ads `validate_only` pre-flight, a master-budget ceiling,
and a structured audit event for every mutation attempt.

It is a tool server, not an approval system. Human-in-the-loop confirmation belongs to
the MCP client.

---

## Contents

- [Private AgentApps installation](#private-agentapps-installation)
- [Architecture](#architecture)
- [MCP client compatibility](#mcp-client-compatibility)
- [The client-side HITL boundary](#the-client-side-hitl-boundary)
- [Google Ads authentication](#google-ads-authentication)
- [Manager account setup](#manager-account-setup)
- [Customer allowlisting](#customer-allowlisting)
- [Read tool catalog](#read-tool-catalog)
- [Mutation tool catalog](#mutation-tool-catalog)
- [Capability configuration](#capability-configuration)
- [The master budget model](#the-master-budget-model)
- [Tool-specific constraints](#tool-specific-constraints)
- [Current-state protection](#current-state-protection)
- [Validation behavior](#validation-behavior)
- [Logging and redaction](#logging-and-redaction)
- [Local development](#local-development)
- [Testing](#testing)
- [Production limitations](#production-limitations)

## Private AgentApps installation

Publish the reviewed source revision with its committed `server.json` and
`agentapps/main.mjs` as one **private** AgentApps entry. The catalog declares the same
15 read and 15 mutation actions for both install modes. Owner review with placeholder
settings may show **Needs real settings**. An installation remains **Activating** and
exposes no tools until its first start with real settings validates credentials and
confirms all 30 declared action descriptors. Every later start repeats setting and
credential validation. Live publication, installation, and account verification are
operator activities after this code delivery.

Set these environment variables on a read-only installation (replace every example
value with a real one). Omit `GOOGLE_ADS_INSTALL_MODE` to use its `read_only` default:

```dotenv
GOOGLE_ADS_ALLOWED_CUSTOMER_IDS=9876543210
GOOGLE_ADS_AUTH_MODE=service_account
GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE=json
GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON={"type":"service_account","client_email":"your-service-account@example.iam.gserviceaccount.com","private_key":"YOUR_PRIVATE_KEY"}
```

For a mutation installation, add an explicit mode and positive daily ceiling in
micros to the same settings:

```dotenv
GOOGLE_ADS_INSTALL_MODE=mutations
GOOGLE_ADS_MASTER_BUDGET_MICROS=500000000
```

`GOOGLE_ADS_ALLOWED_CUSTOMER_IDS` accepts comma-separated, unique ten-digit customer
IDs. It rejects missing, malformed, duplicate, and shipped example IDs. The mutation
ceiling is the maximum **sum of configured daily budgets** for the target account, not
a spend cap. Read `get_budget_pacing` first and choose a ceiling at or above the
account's current total; a lower ceiling blocks even budget decreases. For multiple
allowlisted accounts, the same ceiling applies to each account separately. Read-only
installs need no ceiling.

The default mutation policy enables only the 15 named mutation actions. Campaign and
ad-group toggles and budget changes allow one resource per call; ad toggles and paused
ad creation allow 10; keyword toggles, negative keyword changes, paused keyword
creation, and recommendation dismissal allow 20. Tracking changes forbid final URL
changes. The optional `GOOGLE_ADS_CAPABILITIES_INLINE` setting accepts YAML or JSON
with the same schema as the legacy capability file. It may disable actions, narrow
customers to a nonempty subset, lower limits or the master ceiling, and add stricter
constraints. It cannot expand any of them. The legacy `GOOGLE_ADS_MCP_CONFIG` file
path remains available outside AgentApps; do not set both settings. Setting
`GOOGLE_ADS_MUTATIONS_ENABLED=false` is an additional kill switch.

All mutation actions remain discoverable in read-only mode. A syntactically valid
mutation call is denied with `TOOL_DISABLED`, a configuration-disabled message, and
an audit event before any Google Ads request. Tool input and output schemas stay fixed
across modes; the effective limits are enforced inside the handlers.

Inline service-account JSON is the primary AgentApps credential route. Grant that
service account direct access to the advertiser account. The recommended Google Ads
role is **Read only** for a read-only install and **Standard** for a mutation install.
`GOOGLE_ADS_LOGIN_CUSTOMER_ID` is optional for direct service-account access and may
route through a linked manager. Environment OAuth remains compatible: select
`GOOGLE_ADS_AUTH_MODE=user` and set `GOOGLE_ADS_CLIENT_ID`,
`GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, and the required manager
`GOOGLE_ADS_LOGIN_CUSTOMER_ID`. `GOOGLE_ADS_DEVELOPER_TOKEN` is optional in both routes.
Insufficient Google Ads write permission returns the existing sanitized authorization
error. The consuming eve agent owns human approval before every mutation.

After the installation activates, an operator may make a harmless live call to
`list_accessible_accounts` or `get_account_summary` to confirm account access.
- [Explicitly unsupported operations](#explicitly-unsupported-operations)

---

## Architecture

A single stdio process. The MCP client launches it, speaks JSON-RPC over stdin/stdout,
and the server talks to the Google Ads REST API over HTTPS.

```
MCP client  ──stdio JSON-RPC──▶  google-ads-mcp  ──HTTPS──▶  Google Ads REST API
                                       │
                                       └── structured JSON audit log ──▶ stderr
```

Every mutation runs through one pipeline, implemented once in
`src/mcp/tools/mutations/pipeline.ts`:

```
tools/call
  → validate input schema
  → normalize customer ID
  → authorize customer ID against the allowlist
  → confirm the tool is enabled
  → fetch authoritative current state from Google Ads
  → apply tool-specific constraints
  → construct the exact Google Ads mutation, then freeze it
  → run validate_only on that operation
  → execute that same operation
  → return structured before/after state
  → write a structured audit event
```

Layout:

```
src/
  config/        env + YAML loading, validated at startup, fails closed
  capabilities/  typed per-tool policy schemas, default-deny registry, default config
  authorization/ customer ID normalization and allowlist enforcement
  google-ads/    REST transport, OAuth, GAQL guard, validate-then-execute, error mapping
  mcp/           server construction, tool registration, the 30 tools
  audit/         pino logger (stderr only) and credential redaction
  errors/        the stable error-code hierarchy
  util/          bigint micros, canonical JSON hashing, GAQL escaping
```

### Why a hand-rolled REST client

The server talks to the Google Ads REST API directly rather than through a wrapper
library. Four requirements drove that:

- **Request IDs.** Google returns `request-id` as an HTTP *response header*. The audit
  log records it for every call, including successful ones. Wrapper libraries that go
  through gRPC discard response metadata, leaving the ID recoverable only on failures.
- **Timeouts.** `search_google_ads` must enforce a deadline; `AbortSignal.timeout()` on
  `fetch` does that directly.
- **Provable validation.** A mutation is a plain frozen JSON object, POSTed twice. The
  test suite asserts the validate and execute request bodies are byte-identical apart
  from the `validateOnly` flag — a property that is hard to demonstrate through a
  builder DSL.
- **Honest tests.** `undici`'s `MockAgent` intercepts at the HTTP layer, so integration
  tests assert on the exact JSON sent to Google.

The cost is that the handful of enums and resource-name formats we use are maintained
here rather than generated. The API version is pinned by `GOOGLE_ADS_API_VERSION`
(default `v25`), so moving versions is one environment variable.

---

## MCP client compatibility

Any spec-compliant MCP client works. The server uses only `tools/list` and
`tools/call`, with standard tool annotations. There is no custom transport, no
proprietary extension, and no bespoke client.

Copy `examples/mcp-client-config.json` into your client's MCP configuration, or
`examples/read-only-config.json` for a reporting-only deployment.

---

## The client-side HITL boundary

**The server does not know, and does not ask, whether a human approved a mutation.**

Mutation tools carry MCP annotations so a client can decide what to put in front of a
person:

```jsonc
{ "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": true }
```

These are hints for the client. They never change server behavior. Two spec-compliant
clients calling the same tool with the same arguments — one showing a confirmation
dialog, one not — get identical results. That is asserted by a test.

Mutation tool titles and descriptions are written to be read by a person in an approval
prompt. `set_campaign_budget`, for instance, states plainly that it changes an
advertising budget and may affect charges.

There is deliberately **no** `approved`, `approvalToken`, `approvedBy`, `proposalId`, or
`riskLevel` field on any tool. Every input schema publishes
`additionalProperties: false`, so an extra argument is rejected — a test walks every
tool schema to confirm none of those names appear.

What the server *does* enforce, regardless of what any client did: account
authorization, capability enablement, input validation, tool-specific constraints,
current-state checks, and Google Ads validation.

---

## Google Ads authentication

The server supports user OAuth credentials and direct service-account credentials. Both
modes request only the Google Ads scope (https://www.googleapis.com/auth/adwords).
Access tokens are cached before expiry, and concurrent refreshes share one request.
Startup obtains a token before the stdio server connects. Developer tokens are
deprecated and optional in both modes. A supplied token is sent for compatibility;
otherwise the developer-token header is omitted.

A complete existing user setup with GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
GOOGLE_ADS_REFRESH_TOKEN, and GOOGLE_ADS_LOGIN_CUSTOMER_ID selects user mode without
GOOGLE_ADS_AUTH_MODE. You may set GOOGLE_ADS_AUTH_MODE=user explicitly. User mode
always requires all three OAuth settings and a manager customer ID. A partial or
mixed mode-free setup requires explicit mode selection. Explicit modes reject
settings from the other mode.

For direct service-account access, set GOOGLE_ADS_AUTH_MODE=service_account and
select exactly one credential source with GOOGLE_ADS_SERVICE_ACCOUNT_SOURCE:

| Source | Required setting | Meaning |
|---|---|---|
| file | GOOGLE_ADS_SERVICE_ACCOUNT_KEY_FILE | Readable service-account JSON key path |
| json | GOOGLE_ADS_SERVICE_ACCOUNT_KEY_JSON | Inline service-account JSON key |
| adc | Application default credentials | Attached or impersonated service account |

For ADC, GOOGLE_APPLICATION_CREDENTIALS may name an explicit ADC file. Ambient ADC
files or metadata are considered only when adc is selected. Individual-user ADC
and federation without a service-account impersonation target are rejected.
Do not supply both key forms or credentials for an unselected source. Keep keys and
inline JSON out of logs and committed files.

Add the service account as a Google Ads user on the target advertiser account.
It can access that account directly without Google Ads user delegation or a manager
ID. GOOGLE_ADS_LOGIN_CUSTOMER_ID is optional for service accounts; set it to a
linked manager account when manager routing is needed. User mode always routes
through its configured manager. The service account's Google Ads role governs
access: Read only permits reads, while Standard is needed for writes. On an
authorization failure, check target-account membership and role, and the manager
link if configured. The account allowlist still applies in either mode.

### Minting a refresh token for user mode

~~~bash
npm run get-refresh-token -- --client-secret ~/client_secret.json
~~~

This one-time installed-app OAuth flow requests only the Ads scope and prints the
user mode client ID, client secret, and refresh token. The server itself never
performs an interactive flow.

### Quota project

User-mode Google Ads API access uses the Cloud project that owns its OAuth client.
Service-account access uses the service account's owning project. Billing is
optional; no separate quota or billing project setting is required.

---

## Manager account setup

Use GOOGLE_ADS_LOGIN_CUSTOMER_ID for manager routing. It is required for user mode
and optional for service-account mode. Without it, a service account accesses an
advertiser account directly. The listAccessibleCustomers endpoint omits the manager
header because it lists directly accessible accounts. Manager children may not
appear there; the configured allowlist remains authoritative. Customer IDs are
normalized before allowlist checks, so dashed and undashed forms compare equally.

---

## Customer allowlisting

```yaml
accounts:
  allowedCustomerIds:
    - '1234567890'
    - '2345678901'
```

The configuration shipped in `src/capabilities/default-config.yaml` carries
**placeholder** IDs, so a fresh checkout refuses every account until you configure it —
the intended fail-closed behaviour. Create the gitignored config/capabilities.local.yaml from the tracked example,
then replace the placeholder IDs and point the server at it:

```bash
cp config/capabilities.example.yaml config/capabilities.local.yaml
$EDITOR config/capabilities.local.yaml          # your real customer IDs
export GOOGLE_ADS_MCP_CONFIG=$PWD/config/capabilities.local.yaml
```

The new file needs this starting structure. Copy constraints for any enabled
mutation tools from the tracked example and enable only the tools you intend to use:

~~~yaml
version: 1
accounts:
  allowedCustomerIds: ['1234567890'] # replace with operator ten-digit IDs
reads:
  defaultRowLimit: 100
  maxRowLimit: 1000
  requestTimeoutMs: 30000
  maxPages: 20
mutations:
  enabled: true
  default: deny
  tools:
    pause_campaign:
      enabled: true
      maxResourcesPerCall: 1
~~~


`config/*.local.yaml` is gitignored, so your account IDs never enter version control.

Every tool authorizes the requested customer ID before making any Google Ads call. A
customer ID supplied as a tool argument is never sufficient on its own — this is the
boundary that stops a model reaching an arbitrary account by guessing an ID.

The rejection error reports only the requested ID and the allowlist *size*, never its
contents, so the allowlist cannot be enumerated by probing.

Tools that accept a Google Ads **resource name** (`remove_negative_keyword`,
`dismiss_recommendation`) re-check the customer ID embedded in that name against the
authorized account. A well-formed resource name pointing at another account is the
sneakiest way past an allowlist, and it is refused with `UNAUTHORIZED_CUSTOMER`.

The server runs as a local stdio process; process access is the caller identity. There
is no multi-tenant user authorization system.

---

## Read tool catalog

All fifteen are always registered. Money is always integer **micros** carried as
decimal strings.

| Tool | Returns |
|---|---|
| `list_accessible_accounts` | Allowlisted accounts with name, currency, timezone |
| `get_account_summary` | Identity, campaign counts by status, headline totals |
| `list_campaigns` | Campaigns with status, channel, and the **budget ID** each references |
| `get_campaign` | Full detail for one campaign including its budget and tracking config |
| `get_campaign_performance` | Campaign metrics, optionally segmented by date/device/network |
| `get_ad_group_performance` | Ad group metrics, same segmentation |
| `get_keyword_performance` | Keyword metrics plus criterion resource names |
| `get_search_terms` | Actual queries that triggered ads, with added/excluded status |
| `list_negative_keywords` | Campaign and ad group negatives, plus shared lists (read-only) |
| `list_recommendations` | Open recommendations with resource names and projected impact |
| `get_conversion_actions` | Conversion actions with counting, attribution, lookback |
| `get_bidding_strategy_status` | Per-campaign bidding config and portfolio strategies |
| `get_budget_pacing` | **Distinct** budget total, master budget, headroom, per-budget spend |
| `get_change_history` | Recent changes, who made them, which fields |
| `search_google_ads` | Controlled read-only GAQL |

Reporting tools share a common shape: authorized customer selection, a date range
(named preset *or* explicit start/end), pagination via `pageToken`, a configurable
`limit`, common segments, structured rows, and a human-readable `message`.

`get_budget_pacing` is the planning tool for budget changes: it reports the account's
current total across **distinct** budget resources, the configured master budget, and
the resulting headroom, plus a `mutableByThisServer` flag per budget. A client can
therefore work out what will fit — and which budgets are shared and will be refused —
without attempting a mutation and being rejected.

### `search_google_ads`

Controlled GAQL reporting. It:

- permits only `SELECT`, and only a single statement
- rejects comments (which could conceal a second statement) and unterminated literals
- rejects billing, payments, and user-access resources, which are prohibited
  capabilities that a generic reader would otherwise reach
- enforces a maximum row count, inserting a `LIMIT` when the caller omits one —
  correctly placed *before* any `PARAMETERS` clause
- enforces pagination limits and a request timeout
- never logs credentials or authorization headers

The account is fixed by the `customerId` argument. GAQL has no customer clause — the
account lives in the URL path — so no query text can redirect a call to another account.

There is no generic Google Ads mutate operation.

---

## Mutation tool catalog

All fifteen are registered in every mode. Each represents one understandable
business operation; disabled calls return `TOOL_DISABLED` with an audit event.

| Tool | Effect |
|---|---|
| `pause_campaign` / `enable_campaign` | Campaign stops / resumes serving and spending |
| `pause_ad_group` / `enable_ad_group` | Ad group stops / resumes serving |
| `pause_ad` / `enable_ad` | Batch; ads stop / resume serving |
| `pause_keyword` / `enable_keyword` | Batch; keywords stop / resume triggering ads |
| `add_negative_keyword` | Batch; blocks searches at one campaign or ad group |
| `remove_negative_keyword` | Batch; unblocks searches, can increase reach and spend |
| `create_paused_ad` | Creates responsive search ads, always PAUSED |
| `create_paused_keyword` | Adds keywords, always PAUSED |
| `dismiss_recommendation` | Hides a suggestion; changes no campaign setting |
| `update_tracking_parameters` | Changes click tracking on a campaign, ad group, or ad |
| `set_campaign_budget` | Changes a daily budget amount; affects charges |

### Paused creation is staging, not review

`create_paused_ad` / `create_paused_keyword` paired with `enable_ad` / `enable_keyword`
is a **staging and idempotency pattern, not an approval gate**. A client holding both
tools can create and then enable in two calls. Paused creation is useful because it
makes creation safe to retry and lets a client stage work — it is not a review step, and
must not be presented as one.

---

## Capability configuration

A typed YAML file, validated at startup. Default-deny: a tool absent from `tools` is
denied, and so is one with `enabled: false`.

```yaml
version: 1

accounts:
  allowedCustomerIds:
    - '1234567890'

mutations:
  enabled: true
  default: deny
  tools:
    pause_campaign:
      enabled: true
      maxResourcesPerCall: 1
    add_negative_keyword:
      enabled: true
      maxResourcesPerCall: 20
      allowedMatchTypes: [PHRASE, BROAD]
    update_tracking_parameters:
      enabled: true
      allowFinalUrlChanges: false
    set_campaign_budget:
      enabled: true
      maxResourcesPerCall: 1

budgets:
  masterBudgetMicros: '150000000'   # $150.00/day
```

Each tool has its own typed schema — there is no generic rule language and no
`RiskLevel` enum. Configuration **fails closed** when:

- the customer allowlist is missing or empty
- the mutations block is malformed
- an unknown mutation tool name is enabled
- a tool constraint has an invalid value (`maxResourcesPerCall: 0`, or above its cap)
- `set_campaign_budget` is enabled without `budgets.masterBudgetMicros`
- required Google Ads credentials are absent
- **any key is misspelled** — every object is strict, so a typo is an error rather than
  a silently ignored setting that leaves you believing a constraint is in force

### Global controls

Two independent switches, both of which leave read-only tools working:

```yaml
mutations:
  enabled: true    # config-level
```

```bash
GOOGLE_ADS_MUTATIONS_ENABLED=false   # environment kill switch
```

When either is off, mutation tools remain listed and valid calls receive an audited
`TOOL_DISABLED` response before any Google Ads request.

---

## The master budget model

One invariant:

> After every budget mutation, the sum of `amount_micros` across all distinct,
> non-removed campaign budget resources must remain **less than or equal to**
> `budgets.masterBudgetMicros`.

Within that ceiling the client allocates freely. Increases, decreases, and concentrating
spend on one campaign are all permitted. There are no per-call change-percent limits and
no increase/decrease switches; Google Ads validation determines the minimum acceptable
amount.

Two details that matter:

- **Distinct budget resources, not campaigns.** A budget shared by five campaigns counts
  once. Counting per campaign would inflate the total fivefold and reject legitimate
  changes.
- **Status-independent.** Paused and enabled campaigns both count, so pausing a campaign
  never changes the total and `pause_campaign` needs no budget logic. To reclaim
  headroom from a paused campaign, lower its budget.

`set_campaign_budget` addresses the **budget resource** by ID, never a campaign ID, so a
shared budget cannot be changed by accident through one of its campaigns. Explicitly
shared budgets are refused outright with `UNSUPPORTED_RESOURCE_STATE`.

All money arithmetic uses `bigint` over decimal strings. JavaScript floating-point
numbers never touch a budget calculation. Human-readable messages render a currency
symbol only when the account's currency code is known; no currency is assumed.

There is no `reallocate_campaign_budgets`. Reallocation is two `set_campaign_budget`
calls under the same invariant, and an equal-total constraint would forbid deliberately
scaling total spend down.

### This is not a spend guarantee

**The master budget is a planning constraint, not a cap on what Google will charge
you.** Google Ads may deliver up to roughly **twice** a campaign's daily budget on any
given day, balancing over the month. The sum of campaign budgets is therefore *not*
equivalent to a guaranteed account spend limit.

**Set an account-level spend limit inside Google Ads itself.** That Google-side limit is
the hard wall. This server's invariant is the constraint your client plans against.

---

## Tool-specific constraints

Objective and locally checkable. Never subjective judgments about whether a campaign is
performing badly enough to pause — that is the client's call.

| Constraint | Where |
|---|---|
| Maximum resources per call | Every batch tool |
| Allowed keyword match types | `add_negative_keyword`, `create_paused_keyword` |
| Maximum keyword text length | `add_negative_keyword` |
| Whether final URLs may change | `update_tracking_parameters` |
| Allowed tracking hosts | `update_tracking_parameters` |
| Allowed final URL hosts, HTTPS required | `create_paused_ad` |
| Allowed recommendation types | `dismiss_recommendation` |
| Created resources must be paused | `create_paused_ad`, `create_paused_keyword` |
| Account total stays within the master budget | `set_campaign_budget` |

### Destination integrity in `update_tracking_parameters`

With `allowFinalUrlChanges: false`, a domain comparison alone is **not** treated as
sufficient. The tool:

- keeps `finalUrls` in the fixed schema but rejects it in the handler before reading
  current state or sending a mutation
- requires an `{lpurl}`-family placeholder in any tracking template — a template without
  one *is* the destination, so permitting it would let a caller redirect clicks while
  nominally only touching "tracking"
- validates `finalUrlSuffix` structurally as `key=value` pairs only, rejecting anything
  containing `?`, `#`, or `//` that could introduce a path, host, or fragment
- optionally restricts the tracking template's own host

---

## Current-state protection

Mutation tools fetch authoritative state from Google Ads before acting. They never
trust a client's view of the world.

Optional expected-state fields give optimistic concurrency without any proposal or
approval workflow:

```jsonc
{ "customerId": "1234567890", "campaignId": "456", "expectedCurrentStatus": "ENABLED" }
```

If the resource no longer matches, the call is rejected with `STALE_RESOURCE_STATE` and
the expected and actual values. Supported on `pause_campaign`, `enable_campaign`, the
ad group and batch toggles (`expectedCurrentStatus`), `update_tracking_parameters`
(`expectedCurrentTrackingTemplate`, `expectedCurrentFinalUrl`), and
`set_campaign_budget` (`expectedCurrentAmountMicros`).

### Idempotency

Mutations are naturally idempotent where the operation allows:

```json
{ "success": true, "changed": false, "message": "Campaign was already paused." }
```

Pausing an already-paused campaign, enabling an already-enabled ad group, adding an
existing negative keyword, and setting a budget to its current amount all return a
successful no-op **without issuing a Google Ads mutation**. Removing a negative keyword
that no longer exists reports `not_found` per item rather than failing the call.

This is why a client retrying after a timeout is safe, and why executing mutations are
never retried automatically — a replayed mutate could apply twice.

---

## Validation behavior

Every supported mutation is validated before execution, on the *same operation*:

```ts
const operation = buildOperation(currentResource, input);   // then deep-frozen

await mutate({ mutateOperations: [operation], validateOnly: true,  partialFailure: false });
await mutate({ mutateOperations: [operation], validateOnly: false, partialFailure: false });
```

The operation is hashed before validation and re-checked before execution, so
model-controlled data cannot alter it in between. A validation failure prevents
execution entirely — the test suite asserts exactly one HTTP call is made in that case.

`partialFailure` is always `false`; the transport types it as the literal `false`, so
`true` is a compile error. Interdependent operations must not partially succeed, and
bulk tools have explicit maximum sizes.

**One exception:** Google's `recommendations:dismiss` endpoint has no `validateOnly`
field, so `dismiss_recommendation` cannot pre-validate. Its tool description and its
result (`validateOnlySupported: false`) both say so.

Google Ads validation does not replace customer authorization, capability enablement,
input validation, tool-specific constraints, or current-state checks. All of those run
first.

### Error codes

Stable and machine-readable:

```
UNAUTHORIZED_CUSTOMER   TOOL_DISABLED             INVALID_ARGUMENT
RESOURCE_NOT_FOUND      STALE_RESOURCE_STATE      UNSUPPORTED_RESOURCE_STATE
TOOL_CONSTRAINT_VIOLATION                         MAX_OPERATIONS_EXCEEDED
DUPLICATE_RESOURCE      VALIDATION_FAILED         GOOGLE_ADS_API_ERROR
RATE_LIMITED            TEMPORARY_FAILURE
```

Google Ads errors are mapped into sanitized, actionable form — error code, message,
field path, operation index — and never returned as raw upstream payloads. Tool errors
never contain OAuth tokens, refresh tokens, developer tokens, client secrets,
authorization headers, or stack traces.

---

## Logging and redaction

Structured JSON via `pino`, written to **stderr only**. stdout carries the MCP JSON-RPC
stream; a single log line written there would corrupt the protocol, so the lint config
bans `console.*` outside the entrypoint.

A structured audit event is written for **every mutation attempt**, including denied
ones:

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
  operationHash?: string;
  operationCount?: number;
  durationMs?: number;
}
```

Redaction runs in two layers, because either alone is insufficient: path-based redaction
for known credential fields, plus a literal-value scrubber that replaces any known
secret wherever it appears — including inside a free-text upstream error message, which
path redaction cannot see.

`canonicalArguments` records IDs, counts, and match types. It deliberately does **not**
record full advertising content: `create_paused_ad` logs headline and description
*counts* and final-URL *hosts*, not the copy itself.

Read tools are logged at `debug` and do not emit audit events.

Disabled mutation tools remain in `tools/list`. Syntactically valid calls reach the
handler, which writes a denied audit event before any Google Ads request. The startup
`tool_registration_complete` record also lists suppressed actions and their reasons.

---

## Local development

Requires Node 22+.

```bash
npm install
npm run build
npm run check        # typecheck + lint + test + build
```

| Script | Purpose |
|---|---|
| `npm run dev` | Watch mode via tsx |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Full suite |
| `npm run test:unit` / `test:integration` | One tier |
| `npm run coverage` | Coverage report |
| `npm run get-refresh-token` | One-time OAuth helper |
| `npm run verify-live` | Read-only probe of every read tool against a live account |

### Verifying against a real account

Once `.env` is populated:

```bash
npm run build
npm run verify-live -- 1234567890     # an allowlisted customer ID
```

This spawns the built server over real stdio with mutations disabled, calls all fifteen
read tools, and prints a one-line summary of each, followed by negative controls
(unauthorized account, blocked GAQL resource, multi-statement GAQL). It never calls a
mutation tool.

Do this before enabling mutations. It checks configured credentials and account access, the allowlist, and every GAQL query the server issues — GAQL field names
are the one class of bug that mocked tests cannot catch, because a mock returns whatever
it is told to.

### Docker

For development and testing convenience only; the deployment target is a stdio process
launched from a client config.

```bash
docker build -t google-ads-mcp .
docker run -i --rm --env-file .env google-ads-mcp
```

`-i` matters: the container's stdin/stdout are the MCP channel.

---

## Testing

```bash
npm test
```

Two tiers. **Unit** covers config fail-closed behavior, customer normalization and
allowlist rejection, the GAQL guard, bigint budget arithmetic, error mapping, and
redaction. **Integration** runs a real `McpServer` over an in-memory transport against
an HTTP-level `undici` mock, so no network is touched and tests can assert on the exact
JSON sent to Google.

Notable properties under test:

- standard `tools/list` and `tools/call`; disabled mutations remain discoverable
- no approval-shaped argument exists on any tool, and extras are refused
- `validate_only` precedes execution with a **byte-identical body**
- a validation failure prevents execution (exactly one HTTP call)
- unauthorized customers rejected **before** any Google Ads request
- a shared budget counted once in the account total
- a budget change over the ceiling rejected before any Google Ads call
- a resource name pointing at another customer rejected
- audit events for executed, no-op, denied, and validation-failed paths
- credentials never appear in any log line
- prohibited tool names are absent from `tools/list`

> **A note on running tests against a real API.** npm's `undici` package cannot
> intercept Node's built-in `fetch` — they are separate copies of undici. The test
> harness therefore injects undici's own `fetch` through the client's `fetchImpl` seam.
> Without that, mocked tests silently reach the real Google Ads API. If you add a test
> that hits the network, this is why.

---

## Production limitations

- **The master budget is not a spend cap.** See
  [The master budget model](#the-master-budget-model). Set an account-level spend limit
  in Google Ads.

- **A ceiling below the current total locks out budget changes.** The invariant is
  strictly "prospective total ≤ master budget". If `masterBudgetMicros` is configured
  *below* what the account already totals, that rule rejects budget **decreases** too,
  because the post-mutation total still exceeds the ceiling. The error details include
  the current total, the prospective total, and the ceiling, so the cause is visible —
  but the fix is to correct the configuration. **Set the ceiling from a real
  `get_budget_pacing` reading**, not from an estimate of what you spend: the invariant
  sums *configured* budgets, which are typically well above actual spend.

- **One ceiling, not one per account.** `budgets.masterBudgetMicros` is a single value
  applied to whichever allowlisted account a call targets. With more than one account
  allowlisted, either set it from the largest account's total or run one server process
  per account.

- **`explicitly_shared` is conservative.** Budgets created through the Google Ads API
  often carry `explicitlyShared: true` even when only one campaign uses them. Such
  budgets are refused. `get_budget_pacing` reports `mutableByThisServer` per budget so
  this is discoverable without a failed mutation.

- **Shared resources are read-only.** Shared negative keyword lists and portfolio
  bidding strategies are reported by the read tools but cannot be modified.

- **Batches are atomic, not partial.** `partialFailure` is disabled, so one invalid item
  rejects the whole batch. There is no automatic rollback anywhere: a compensating
  mutation is not a transaction, and none is attempted.

- **Executing mutations are never retried.** Reads and validate-only calls retry on
  429/5xx; an executing mutate does not, because a replay after a timeout could apply it
  twice. Idempotent tool behavior is the retry story instead.

- **Malformed arguments produce no audit event.** The MCP SDK rejects input that fails
  the published schema before the handler runs. Nothing reaches Google Ads, but there is
  no audit record of the attempt.

- **`get_change_history` is limited to 30 days**, which is Google's retention window.

- **Ad creation is limited to responsive search ads.**

---

## Explicitly unsupported operations

Not implemented, not registered, and asserted absent by a test:

- shared-budget mutations
- billing changes, payment-method changes
- user-access and account-access changes
- manager-account linking
- customer-account creation
- campaign creation and campaign deletion
- conversion-action deletion
- arbitrary raw mutations (`execute_arbitrary_mutation`, `raw_google_ads_mutate`,
  `execute_protobuf_operation`, `mutate_resource`)
- cross-customer bulk mutations
- `reallocate_campaign_budgets`
- applying recommendations (dismissal only)

There is also, by design, no administrative HTTP API, no approval web application, no
server-side approval queue, no proposal database, no signed approval assertions, and no
generic risk-classification engine.

Campaign creation is the most likely later addition. It has deliberately not been
designed for speculatively.
