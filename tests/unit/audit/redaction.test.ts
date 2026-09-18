import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createAuditLogger, createLogger } from '../../../src/audit/logger.js';
import { makeSecretScrubber } from '../../../src/audit/redaction.js';

const DEV_TOKEN = 'dEvToKeN-7y2T-supersecret';
const CLIENT_SECRET = 'GOCSPX-clientsecretvalue';
const REFRESH_TOKEN = '1//0gRefreshTokenValueHere';

function capture(): { stream: PassThrough; lines: () => string[] } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  return { stream, lines: () => chunks.join('').split('\n').filter((l) => l.trim()) };
}

describe('secret scrubber', () => {
  it('replaces a secret wherever it appears, including inside free text', () => {
    const scrub = makeSecretScrubber([DEV_TOKEN]);
    const out = scrub({ msg: `call failed with developer-token: ${DEV_TOKEN}` }) as {
      msg: string;
    };
    expect(out.msg).not.toContain(DEV_TOKEN);
    expect(out.msg).toContain('[REDACTED]');
  });

  it('walks nested structures and arrays', () => {
    const scrub = makeSecretScrubber([REFRESH_TOKEN]);
    const out = scrub({ a: { b: [{ c: REFRESH_TOKEN }] } });
    expect(JSON.stringify(out)).not.toContain(REFRESH_TOKEN);
  });

  it('ignores short values that would corrupt unrelated text', () => {
    const scrub = makeSecretScrubber(['abc']);
    expect(scrub({ msg: 'abcdef' })).toEqual({ msg: 'abcdef' });
  });

  it('is a no-op when no secrets are configured', () => {
    expect(makeSecretScrubber([])({ msg: 'hello' })).toEqual({ msg: 'hello' });
  });
});

describe('logger redaction', () => {
  it('redacts credential-bearing fields by path', () => {
    const { stream, lines } = capture();
    const logger = createLogger({ destination: stream, secrets: [] });
    logger.info(
      {
        headers: { authorization: 'Bearer abc123', 'developer-token': DEV_TOKEN },
        refreshToken: REFRESH_TOKEN,
        clientSecret: CLIENT_SECRET,
      },
      'test',
    );
    const out = lines().join('');
    expect(out).not.toContain('Bearer abc123');
    expect(out).not.toContain(REFRESH_TOKEN);
    expect(out).not.toContain(CLIENT_SECRET);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a secret that lands somewhere path redaction cannot see', () => {
    const { stream, lines } = capture();
    const logger = createLogger({
      destination: stream,
      secrets: [DEV_TOKEN, CLIENT_SECRET, REFRESH_TOKEN],
    });
    // A credential echoed inside an upstream error message is the realistic leak.
    logger.error({ err: { message: `invalid_grant for ${REFRESH_TOKEN}` } }, 'oauth failed');
    const out = lines().join('');
    expect(out).not.toContain(REFRESH_TOKEN);
    expect(out).toContain('[REDACTED]');
  });

  it('writes audit events as structured JSON with the audit marker', () => {
    const { stream, lines } = capture();
    const audit = createAuditLogger(createLogger({ destination: stream, secrets: [] }));
    audit.write({
      timestamp: '2026-08-24T00:00:00.000Z',
      toolName: 'pause_campaign',
      canonicalArguments: { campaignId: '123' },
      result: 'executed',
      googleAdsRequestId: 'req-1',
    });
    const parsed = JSON.parse(lines()[0] as string) as Record<string, unknown>;
    expect(parsed.audit).toBe(true);
    expect(parsed.msg).toBe('mutation_attempt');
    expect(parsed.toolName).toBe('pause_campaign');
    expect(parsed.result).toBe('executed');
    expect(parsed.googleAdsRequestId).toBe('req-1');
  });
});
