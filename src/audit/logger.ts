import pino from 'pino';

export type Logger = pino.Logger;
import { REDACT_PATHS, makeSecretScrubber } from './redaction.js';

/**
 * A structured audit event for a mutation attempt.
 *
 * One is written for every attempt including denials, no-ops and failures. The
 * initial implementation is structured JSON on stderr; there is deliberately no
 * separate audit service.
 */
export interface AuditEvent {
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

export interface AuditLogger {
  write(event: AuditEvent): void;
}

export interface LoggerOptions {
  level?: string;
  secrets?: readonly (string | undefined)[];
  /** Test seam. Defaults to stderr. */
  destination?: NodeJS.WritableStream;
}

/**
 * Create the root logger.
 *
 * CRITICAL: this writes to file descriptor 2 and nothing else. stdout carries the
 * MCP JSON-RPC stream, and a single log line written there corrupts the protocol for
 * the rest of the session.
 *
 * Synchronous because a stdio MCP process can be terminated abruptly and an async
 * flush would lose the last audit events - exactly the ones most worth having.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const scrub = makeSecretScrubber(options.secrets ?? []);
  const stream = options.destination ?? pino.destination({ fd: 2, sync: true });

  return pino(
    {
      level: options.level ?? 'info',
      base: { service: 'google-ads-mcp' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((arg) =>
            typeof arg === 'string' || (arg !== null && typeof arg === 'object')
              ? scrub(arg)
              : arg,
          );
          method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
    },
    stream,
  );
}

export function createAuditLogger(logger: Logger): AuditLogger {
  const child = logger.child({ audit: true });
  return {
    write(event: AuditEvent): void {
      child.info({ ...event }, 'mutation_attempt');
    },
  };
}
