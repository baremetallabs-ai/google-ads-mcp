import { z } from 'zod';
import type { AuditEvent } from '../../../audit/logger.js';
import type { MutationToolName } from '../../../capabilities/tool-names.js';
import type { PolicyFor } from '../../../capabilities/schema.js';
import { toToolError } from '../../../google-ads/errors.js';
import { validateThenExecute, type ExecOutcome } from '../../../google-ads/validation.js';
import type { GoogleAdsTransport, MutateOperation } from '../../../google-ads/types.js';
import { auditResultFor } from '../../../errors/tool-errors.js';
import { canonicalJson, deepFreeze, sha256Hex } from '../../../util/json.js';
import { toolErrorResult, toolResult, type McpToolResult } from '../../tool-result.js';
import type { Deps, ToolAnnotations } from '../../../types/index.js';

/** Context handed to every step of a mutation. */
export interface MutationCtx<N extends MutationToolName = MutationToolName> {
  customerId: string;
  policy: PolicyFor<N>;
  transport: GoogleAdsTransport;
  deps: Deps;
}

/**
 * A single mutation tool.
 *
 * The pipeline owns ordering, authorization, validation and auditing; a tool supplies
 * only what is specific to it.
 */
export interface MutationDefinition<
  N extends MutationToolName,
  TInput = Record<string, unknown>,
  TState = unknown,
> {
  name: N;
  title: string;
  description: string;
  resourceType: string;
  annotations: ToolAnnotations;
  /** Fixed descriptor shared by every install mode. */
  buildInputSchema(): z.ZodRawShape;
  outputSchema: z.ZodRawShape;
  /** Checks policy-dependent input before any Google Ads read. */
  checkInputConstraints?(ctx: MutationCtx<N>, input: TInput): void;

  /** Step 5: authoritative current state from Google Ads. */
  fetchState(ctx: MutationCtx<N>, input: TInput): Promise<TState>;
  /** Step 6: tool-specific constraints. Throws a ToolError. */
  checkConstraints(ctx: MutationCtx<N>, input: TInput, state: TState): void;
  /** Idempotency: return a result to short-circuit without calling Google Ads. */
  detectNoOp(ctx: MutationCtx<N>, input: TInput, state: TState): Record<string, unknown> | null;
  /** Step 7: the exact Google Ads operation(s). */
  buildOperations(ctx: MutationCtx<N>, input: TInput, state: TState): MutateOperation[];
  /** Override for endpoints that are not googleAds:mutate. */
  execute?(ctx: MutationCtx<N>, operations: readonly MutateOperation[], input: TInput, state: TState): Promise<ExecOutcome>;
  /** Step 10: structured before/after result. */
  buildResult(ctx: MutationCtx<N>, input: TInput, state: TState, exec: ExecOutcome): Record<string, unknown>;
  /** Step 11: IDs and counts for the audit log - never full ad copy. */
  canonicalArguments(input: TInput): unknown;
  responseContentType?: 'RESOURCE_NAME_ONLY' | 'MUTABLE_RESOURCE';
}

/**
 * Build the MCP handler for a mutation tool.
 *
 * The pipeline is the spec's ordering, executed once here rather than repeated in
 * fifteen tools:
 *
 *   validate input -> normalize customer ID -> authorize customer -> confirm enabled
 *   -> fetch current state -> apply constraints -> build the exact operation
 *   -> validate_only -> execute -> structured before/after -> audit event
 *
 * Client-side confirmation is deliberately absent: it is the client's concern, and
 * this server behaves identically whether or not one was shown.
 */
export function createMutationHandler<N extends MutationToolName, TInput, TState>(
  def: MutationDefinition<N, TInput, TState>,
  deps: Deps,
  /** The same strict schema published in tools/list, so advertised == enforced. */
  prebuiltSchema?: z.ZodType,
) {
  const inputSchema = prebuiltSchema ?? z.strictObject(def.buildInputSchema());

  return async (rawArgs: Record<string, unknown>): Promise<McpToolResult> => {
    const started = Date.now();
    const audit: Partial<AuditEvent> = {
      timestamp: new Date().toISOString(),
      toolName: def.name,
    };
    let customerId: string | undefined;

    try {
      // 1. Validate input.
      const input = inputSchema.parse(rawArgs ?? {}) as TInput;

      // 2-3. Normalize and authorize the customer ID before any Google Ads call.
      const rawCustomerId = (input as { customerId?: unknown }).customerId;
      customerId = deps.allowlist.authorize(String(rawCustomerId ?? ''));
      audit.customerId = customerId;
      audit.canonicalArguments = def.canonicalArguments(input);

      // 4. Confirm the tool is enabled after customer authorization.
      const livePolicy = deps.registry.assertEnabled(def.name);
      const ctx: MutationCtx<N> = {
        customerId,
        policy: livePolicy,
        transport: deps.transport,
        deps,
      };

      def.checkInputConstraints?.(ctx, input);

      // 5. Authoritative current state.
      const state = await def.fetchState(ctx, input);

      // 6. Tool-specific constraints, then idempotency.
      def.checkConstraints(ctx, input, state);
      const noop = def.detectNoOp(ctx, input, state);
      if (noop) {
        audit.result = 'no_op';
        audit.beforeState = noop.before;
        audit.afterState = noop.after;
        return toolResult(noop);
      }

      // 7. The exact operation, frozen so nothing can alter it later.
      const operations = deepFreeze(def.buildOperations(ctx, input, state));
      const operationHash = sha256Hex(canonicalJson(operations));
      audit.operationHash = operationHash;
      audit.operationCount = operations.length;

      // 8-9. Validate, then execute the same operation.
      const exec = def.execute
        ? await def.execute(ctx, operations, input, state)
        : await validateThenExecute(deps.transport, customerId, operations, {
            ...(def.responseContentType !== undefined && {
              responseContentType: def.responseContentType,
            }),
          });
      audit.googleAdsRequestId = exec.requestId;

      // 10. Structured before/after.
      const result = def.buildResult(ctx, input, state, exec);
      audit.result = 'executed';
      audit.beforeState = result.before;
      audit.afterState = result.after;
      return toolResult(result);
    } catch (err) {
      const toolError = toToolError(err);
      audit.result = auditResultFor(toolError.code);
      audit.errorCode = toolError.code;
      audit.googleAdsRequestId ??= toolError.details.googleAdsRequestId as string | undefined;
      audit.canonicalArguments ??= { unparsed: true };
      // Log the real cause to stderr for the operator; return only the sanitized envelope.
      deps.logger.error(
        {
          tool: def.name,
          customerId,
          errorCode: toolError.code,
          err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
        },
        'mutation_error',
      );
      return toolErrorResult(toolError, {
        ...(customerId !== undefined && { customerId }),
        resourceType: def.resourceType,
      });
    } finally {
      // 11. Always audit, including denials and failures.
      deps.audit.write({
        timestamp: audit.timestamp ?? new Date().toISOString(),
        toolName: def.name,
        canonicalArguments: audit.canonicalArguments ?? null,
        result: audit.result ?? 'failed',
        durationMs: Date.now() - started,
        ...(audit.customerId !== undefined && { customerId: audit.customerId }),
        ...(audit.errorCode !== undefined && { errorCode: audit.errorCode }),
        ...(audit.googleAdsRequestId !== undefined && { googleAdsRequestId: audit.googleAdsRequestId }),
        ...(audit.beforeState !== undefined && { beforeState: audit.beforeState }),
        ...(audit.afterState !== undefined && { afterState: audit.afterState }),
        ...(audit.operationHash !== undefined && { operationHash: audit.operationHash }),
        ...(audit.operationCount !== undefined && { operationCount: audit.operationCount }),
      });
    }
  };
}

/** Annotations for a status-changing mutation. */
export const DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** Annotations for a create-only mutation, which adds rather than replaces. */
export const ADDITIVE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Standard structured output shape shared by mutation tools. */
export const MUTATION_OUTPUT_SHAPE = {
  success: z.boolean(),
  changed: z.boolean(),
  customerId: z.string(),
  resourceType: z.string(),
  message: z.string(),
} as const;
