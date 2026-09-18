import { InvalidArgumentError, ValidationFailedError } from '../errors/tool-errors.js';
import { canonicalJson, sha256Hex } from '../util/json.js';
import type {
  GoogleAdsResponseMeta,
  GoogleAdsTransport,
  MutateOperation,
  MutateOperationResponse,
} from './types.js';

/* ------------------------------------------------------------------ *
 * GAQL read-only guard
 * ------------------------------------------------------------------ */

export interface GaqlGuardOptions {
  maxRowLimit: number;
  blockedResources: readonly string[];
}

export interface GaqlGuardResult {
  /** The query actually sent, with a LIMIT applied if the caller omitted one. */
  query: string;
  resource: string;
  appliedLimit: number;
}

const FORBIDDEN_VERBS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'MUTATE',
  'CREATE',
  'DROP',
  'ALTER',
  'GRANT',
  'REVOKE',
  'TRUNCATE',
];

/**
 * Validate a caller-supplied GAQL statement for the generic reporting tool.
 *
 * Note what is *not* needed here: the customer ID never appears in GAQL - it is a URL
 * path segment - so there is nothing in the query text that can redirect the call to
 * another account. Authorization is structural.
 */
export function assertReadOnlyGaql(rawQuery: string, options: GaqlGuardOptions): GaqlGuardResult {
  const query = rawQuery.trim();
  if (query.length === 0) {
    throw new InvalidArgumentError('query must not be empty.', { field: 'query' });
  }

  // Comments could hide a second statement from a naive scan.
  if (/--|\/\*|\*\/|#/.test(stripStringLiterals(query))) {
    throw new InvalidArgumentError('GAQL comments are not permitted in this tool.', {
      field: 'query',
    });
  }

  const withoutStrings = stripStringLiterals(query);
  if (withoutStrings.includes("'")) {
    throw new InvalidArgumentError('query contains an unterminated string literal.', {
      field: 'query',
    });
  }

  // Reject multiple statements. One optional trailing semicolon is tolerated.
  const trimmedSemis = withoutStrings.replace(/;\s*$/, '');
  if (trimmedSemis.includes(';')) {
    throw new InvalidArgumentError('Only a single GAQL statement is permitted.', {
      field: 'query',
    });
  }

  if (!/^SELECT\s/i.test(query)) {
    throw new InvalidArgumentError('Only SELECT queries are permitted.', { field: 'query' });
  }

  const upper = trimmedSemis.toUpperCase();
  for (const verb of FORBIDDEN_VERBS) {
    if (new RegExp(`\\b${verb}\\b`).test(upper)) {
      throw new InvalidArgumentError(`"${verb}" is not permitted in this tool.`, {
        field: 'query',
      });
    }
  }

  const fromMatches = [...trimmedSemis.matchAll(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi)];
  if (fromMatches.length !== 1) {
    throw new InvalidArgumentError(
      'query must contain exactly one FROM clause naming one resource.',
      { field: 'query' },
    );
  }
  const resource = (fromMatches[0]?.[1] ?? '').toLowerCase();
  if (options.blockedResources.includes(resource)) {
    // Billing, payments and user-access are prohibited capabilities. Nothing else
    // would stop a generic reader reaching them.
    throw new InvalidArgumentError(
      `Reading from "${resource}" is not permitted through this server.`,
      { field: 'query', resource },
    );
  }

  const limitMatch = /\bLIMIT\s+(\d+)/i.exec(trimmedSemis);
  if (limitMatch) {
    const limit = Number(limitMatch[1]);
    if (limit > options.maxRowLimit) {
      throw new InvalidArgumentError(
        `LIMIT ${limit} exceeds the configured maximum of ${options.maxRowLimit}.`,
        { field: 'query', requested: limit, maximum: options.maxRowLimit },
      );
    }
    return { query: query.replace(/;\s*$/, ''), resource, appliedLimit: limit };
  }

  // Insert LIMIT before any PARAMETERS clause - appending at the end would produce
  // an invalid statement for queries that use PARAMETERS.
  const base = query.replace(/;\s*$/, '');
  const parametersMatch = /\bPARAMETERS\b/i.exec(base);
  const withLimit = parametersMatch
    ? `${base.slice(0, parametersMatch.index).trimEnd()} LIMIT ${options.maxRowLimit} ${base.slice(parametersMatch.index)}`
    : `${base} LIMIT ${options.maxRowLimit}`;

  return { query: withLimit, resource, appliedLimit: options.maxRowLimit };
}

/**
 * Blank out single-quoted string literals so scans do not trip on their contents.
 *
 * The replacement must contain no single quote, otherwise the unterminated-literal
 * check below would fire on every query that legitimately contains a string.
 */
function stripStringLiterals(query: string): string {
  return query.replace(/'(?:[^'\\]|\\.)*'/g, '""');
}

/* ------------------------------------------------------------------ *
 * validate_only -> execute
 * ------------------------------------------------------------------ */

export interface ExecOutcome {
  responses: MutateOperationResponse[];
  requestId?: string;
  validateMeta: GoogleAdsResponseMeta;
  executeMeta: GoogleAdsResponseMeta;
  operationHash: string;
  validateOnlySupported: boolean;
}

/**
 * Validate the operation, then execute the very same operation.
 *
 * The two request bodies differ only in the `validateOnly` flag. The hash assertion
 * makes that a checked property rather than a convention: if anything mutated the
 * operation array between the two calls, execution aborts.
 */
export async function validateThenExecute(
  transport: GoogleAdsTransport,
  customerId: string,
  operations: readonly MutateOperation[],
  options?: { responseContentType?: 'RESOURCE_NAME_ONLY' | 'MUTABLE_RESOURCE'; timeoutMs?: number },
): Promise<ExecOutcome> {
  const operationHash = sha256Hex(canonicalJson(operations));

  const base = {
    customerId,
    mutateOperations: operations,
    // Interdependent operations must never partially succeed.
    partialFailure: false as const,
    ...(options?.responseContentType !== undefined && {
      responseContentType: options.responseContentType,
    }),
  };

  const validate = await transport.mutate(
    { ...base, validateOnly: true },
    { ...(options?.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }), label: 'validate_only' },
  );

  if (sha256Hex(canonicalJson(operations)) !== operationHash) {
    throw new ValidationFailedError(
      'The Google Ads operation changed between validation and execution; refusing to execute.',
      { operationHash },
    );
  }

  const execute = await transport.mutate(
    { ...base, validateOnly: false },
    { ...(options?.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }), label: 'execute' },
  );

  return {
    responses: execute.mutateOperationResponses,
    ...(execute.meta.requestId !== undefined && { requestId: execute.meta.requestId }),
    validateMeta: validate.meta,
    executeMeta: execute.meta,
    operationHash,
    validateOnlySupported: true,
  };
}
