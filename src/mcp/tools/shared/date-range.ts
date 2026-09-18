import type { z } from 'zod';
import { InvalidArgumentError } from '../../../errors/tool-errors.js';
import { DateInput, DatePresetInput } from './schemas.js';

/**
 * Date-range input, expressed flat rather than as a union.
 *
 * A discriminated union would generate awkward JSON Schema for LLM clients, so the
 * fields are flat and a refinement enforces "preset XOR explicit range".
 */
export const dateRangeShape = {
  datePreset: DatePresetInput.optional().describe(
    'Named Google Ads date range. Mutually exclusive with startDate/endDate.',
  ),
  startDate: DateInput.optional().describe('Inclusive start date, YYYY-MM-DD.'),
  endDate: DateInput.optional().describe('Inclusive end date, YYYY-MM-DD.'),
};

export interface DateRangeInput {
  datePreset?: string;
  startDate?: string;
  endDate?: string;
}

export interface ResolvedDateRange {
  /** GAQL fragment, e.g. `segments.date DURING LAST_30_DAYS`. */
  clause: string;
  preset?: string;
  startDate?: string;
  endDate?: string;
}

export function resolveDateRange(
  input: DateRangeInput,
  defaultPreset = 'LAST_30_DAYS',
): ResolvedDateRange {
  const hasExplicit = input.startDate !== undefined || input.endDate !== undefined;
  if (input.datePreset !== undefined && hasExplicit) {
    throw new InvalidArgumentError(
      'Supply either datePreset or startDate/endDate, not both.',
      { field: 'datePreset' },
    );
  }
  if (hasExplicit) {
    if (input.startDate === undefined || input.endDate === undefined) {
      throw new InvalidArgumentError('startDate and endDate must be supplied together.', {
        field: 'startDate',
      });
    }
    if (input.startDate > input.endDate) {
      throw new InvalidArgumentError('startDate must not be after endDate.', {
        field: 'startDate',
      });
    }
    return {
      clause: `segments.date BETWEEN '${input.startDate}' AND '${input.endDate}'`,
      startDate: input.startDate,
      endDate: input.endDate,
    };
  }
  const preset = input.datePreset ?? defaultPreset;
  return { clause: `segments.date DURING ${preset}`, preset };
}

export const dateRangeRefinement = (
  input: DateRangeInput,
  ctx: z.RefinementCtx,
): void => {
  const hasExplicit = input.startDate !== undefined || input.endDate !== undefined;
  if (input.datePreset !== undefined && hasExplicit) {
    ctx.addIssue({
      code: 'custom',
      path: ['datePreset'],
      message: 'Supply either datePreset or startDate/endDate, not both.',
    });
  }
  if (hasExplicit && (input.startDate === undefined || input.endDate === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['startDate'],
      message: 'startDate and endDate must be supplied together.',
    });
  }
};
