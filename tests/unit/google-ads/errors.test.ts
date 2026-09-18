import { describe, it, expect } from 'vitest';
import {
  mapGoogleAdsHttpError,
  sanitizeGoogleAdsErrors,
  extractRequestIdFromBody,
} from '../../../src/google-ads/errors.js';

const failureBody = (errors: unknown[], requestId = 'req-abc') => ({
  error: {
    code: 400,
    status: 'INVALID_ARGUMENT',
    message: 'Request contains an invalid argument.',
    details: [
      {
        '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
        errors,
        requestId,
      },
    ],
  },
});

describe('Google Ads error sanitization', () => {
  it('flattens the one-key errorCode object', () => {
    const [first] = sanitizeGoogleAdsErrors(
      failureBody([
        { errorCode: { criterionError: 'CRITERION_ALREADY_EXISTS' }, message: 'Already exists.' },
      ]),
    );
    expect(first?.errorCode).toBe('criterionError.CRITERION_ALREADY_EXISTS');
    expect(first?.message).toBe('Already exists.');
  });

  it('renders the field path and operation index', () => {
    const [first] = sanitizeGoogleAdsErrors(
      failureBody([
        {
          errorCode: { fieldError: 'REQUIRED' },
          message: 'Required field missing.',
          location: {
            fieldPathElements: [
              { fieldName: 'operations', index: 2 },
              { fieldName: 'create' },
              { fieldName: 'keyword' },
            ],
          },
        },
      ]),
    );
    expect(first?.fieldPath).toBe('operations[2].create.keyword');
    expect(first?.operationIndex).toBe(2);
  });

  it('extracts the request ID from the failure body', () => {
    expect(extractRequestIdFromBody(failureBody([], 'req-xyz'))).toBe('req-xyz');
  });

  it('returns nothing for an unrecognised body rather than throwing', () => {
    expect(sanitizeGoogleAdsErrors(undefined)).toEqual([]);
    expect(sanitizeGoogleAdsErrors({ nope: true })).toEqual([]);
  });
});

describe('HTTP status mapping', () => {
  it('maps 429 to RATE_LIMITED and marks it retryable', () => {
    const err = mapGoogleAdsHttpError({
      httpStatus: 429,
      body: failureBody([]),
      validateOnly: false,
      retryAfterSeconds: 30,
    });
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryable).toBe(true);
    expect(err.details.retryAfterSeconds).toBe(30);
  });

  it('maps a RESOURCE_EXHAUSTED 400 to RATE_LIMITED', () => {
    const body = failureBody([]);
    body.error.status = 'RESOURCE_EXHAUSTED';
    const err = mapGoogleAdsHttpError({ httpStatus: 400, body, validateOnly: false });
    expect(err.code).toBe('RATE_LIMITED');
  });

  it('maps 5xx to TEMPORARY_FAILURE', () => {
    const err = mapGoogleAdsHttpError({ httpStatus: 503, body: {}, validateOnly: false });
    expect(err.code).toBe('TEMPORARY_FAILURE');
    expect(err.retryable).toBe(true);
  });

  it('distinguishes a validate_only rejection from an execution failure', () => {
    const body = failureBody([
      { errorCode: { fieldError: 'REQUIRED' }, message: 'Required field missing.' },
    ]);
    expect(mapGoogleAdsHttpError({ httpStatus: 400, body, validateOnly: true }).code).toBe(
      'VALIDATION_FAILED',
    );
    expect(mapGoogleAdsHttpError({ httpStatus: 400, body, validateOnly: false }).code).toBe(
      'GOOGLE_ADS_API_ERROR',
    );
  });

  it('carries the request ID into the error details', () => {
    const err = mapGoogleAdsHttpError({
      httpStatus: 400,
      body: failureBody([], 'req-99'),
      validateOnly: true,
    });
    expect(err.details.googleAdsRequestId).toBe('req-99');
  });

  it('never returns a stack trace or the raw body', () => {
    const err = mapGoogleAdsHttpError({
      httpStatus: 400,
      body: failureBody([
        { errorCode: { fieldError: 'REQUIRED' }, message: 'Required field missing.' },
      ]),
      validateOnly: false,
    });
    const serialized = JSON.stringify(err.toEnvelope());
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain('@type');
    expect(Object.keys(err.toEnvelope())).toEqual(['code', 'message', 'details']);
  });
});
