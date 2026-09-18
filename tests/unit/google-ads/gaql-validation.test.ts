import { describe, it, expect } from 'vitest';
import { assertReadOnlyGaql } from '../../../src/google-ads/validation.js';
import { InvalidArgumentError } from '../../../src/errors/tool-errors.js';

const opts = {
  maxRowLimit: 100,
  blockedResources: ['billing_setup', 'customer_user_access', 'customer_client'],
};

const guard = (q: string) => assertReadOnlyGaql(q, opts);

describe('GAQL read-only guard', () => {
  it('accepts a plain SELECT', () => {
    const r = guard('SELECT campaign.id FROM campaign');
    expect(r.resource).toBe('campaign');
    expect(r.query).toBe('SELECT campaign.id FROM campaign LIMIT 100');
  });

  it('rejects every non-SELECT verb', () => {
    for (const q of [
      'UPDATE campaign SET x = 1',
      'DELETE FROM campaign',
      'INSERT INTO campaign VALUES (1)',
      'MUTATE campaign',
      'DROP TABLE campaign',
    ]) {
      expect(() => guard(q)).toThrow(InvalidArgumentError);
    }
  });

  it('rejects a mutation smuggled after a SELECT', () => {
    expect(() => guard('SELECT campaign.id FROM campaign; DELETE FROM campaign')).toThrow(
      InvalidArgumentError,
    );
  });

  it('tolerates a single trailing semicolon', () => {
    expect(guard('SELECT campaign.id FROM campaign;').query).toBe(
      'SELECT campaign.id FROM campaign LIMIT 100',
    );
  });

  it('rejects comments, which could hide a second statement', () => {
    expect(() => guard('SELECT campaign.id FROM campaign -- comment')).toThrow(InvalidArgumentError);
    expect(() => guard('SELECT campaign.id FROM campaign /* c */')).toThrow(InvalidArgumentError);
    expect(() => guard('SELECT campaign.id FROM campaign # c')).toThrow(InvalidArgumentError);
  });

  it('does not trip on a semicolon inside a string literal', () => {
    const r = guard("SELECT campaign.id FROM campaign WHERE campaign.name = 'a;b'");
    expect(r.resource).toBe('campaign');
  });

  it('rejects an unterminated string literal', () => {
    expect(() => guard("SELECT campaign.id FROM campaign WHERE campaign.name = 'oops")).toThrow(
      InvalidArgumentError,
    );
  });

  it('requires exactly one FROM clause', () => {
    expect(() => guard('SELECT campaign.id')).toThrow(InvalidArgumentError);
    expect(() => guard('SELECT campaign.id FROM campaign FROM ad_group')).toThrow(
      InvalidArgumentError,
    );
  });

  it('blocks billing and user-access resources', () => {
    // These are prohibited capabilities; nothing else stops a generic reader.
    expect(() => guard('SELECT billing_setup.id FROM billing_setup')).toThrow(InvalidArgumentError);
    expect(() => guard('SELECT customer_user_access.email_address FROM customer_user_access')).toThrow(
      InvalidArgumentError,
    );
    expect(() => guard('SELECT customer_client.id FROM customer_client')).toThrow(
      InvalidArgumentError,
    );
  });

  it('is case-insensitive about the blocked resource name', () => {
    expect(() => guard('SELECT billing_setup.id FROM BILLING_SETUP')).toThrow(InvalidArgumentError);
  });

  it('clamps a caller LIMIT above the maximum', () => {
    expect(() => guard('SELECT campaign.id FROM campaign LIMIT 5000')).toThrow(InvalidArgumentError);
  });

  it('keeps a caller LIMIT within the maximum', () => {
    const r = guard('SELECT campaign.id FROM campaign LIMIT 10');
    expect(r.appliedLimit).toBe(10);
    expect(r.query).toBe('SELECT campaign.id FROM campaign LIMIT 10');
  });

  it('inserts LIMIT before a PARAMETERS clause, not after it', () => {
    // Appending at the end would produce an invalid statement.
    const r = guard('SELECT campaign.id FROM campaign PARAMETERS include_drafts=true');
    expect(r.query).toBe(
      'SELECT campaign.id FROM campaign LIMIT 100 PARAMETERS include_drafts=true',
    );
  });

  it('rejects an empty query', () => {
    expect(() => guard('   ')).toThrow(InvalidArgumentError);
  });
});
