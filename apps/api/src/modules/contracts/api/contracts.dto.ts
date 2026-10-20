import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { isIsoDate } from '../../organization/index.js';
import { CONTRACT_NOTE_MAX, CONTRACT_REASON_MAX, CONTRACT_REFERENCE_MAX, CONTRACT_TYPES, DECISION_COMMENT_MAX, LATER_KINDS, PROPOSALS } from '../domain/contracts.js';

const isoDate = z.string().refine(isIsoDate, { message: 'Must be a date written YYYY-MM-DD' });
/** C0 controls other than tab / line feed / carriage return, and DEL. */
function isControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
}

/** Optional text: trimmed; empty / blank / null → null; control characters refused. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: `At most ${max} characters` })
    .refine((v) => ![...v].some(isControl), { message: 'Control characters are not allowed' })
    .nullable()
    .transform((v) => (v ? v : null));

const terms = {
  contractType: z.enum(CONTRACT_TYPES),
  endDate: isoDate.nullable().optional(),
  probationEnd: isoDate.nullable().optional(),
  reference: optionalText(CONTRACT_REFERENCE_MAX).optional(),
  reason: optionalText(CONTRACT_REASON_MAX).optional(),
};

/** The `contract` block of POST /employees (and of a hire): the initial contract, starting on the hire date. */
export const initialContractBlock = z.object(terms).strict();

/**
 * POST /employees/:id/contracts. `kind: 'initial'` records a missing initial contract (start = the hire date when
 * omitted); a renewal / conversion / amendment needs its start date.
 */
export class CreateContractDto extends createZodDto(
  z
    .object({ kind: z.enum(['initial', ...LATER_KINDS]), ...terms, startDate: isoDate.optional(), note: optionalText(CONTRACT_NOTE_MAX).optional() })
    .strict()
    .superRefine((body, ctx) => {
      if (body.kind !== 'initial' && body.startDate === undefined) ctx.addIssue({ code: 'custom', path: ['startDate'], message: 'Required' });
    }),
) {}

export class PatchContractDto extends createZodDto(
  z
    .object({
      endDate: isoDate.nullable().optional(),
      probationEnd: isoDate.nullable().optional(),
      reference: optionalText(CONTRACT_REFERENCE_MAX).optional(),
      reason: optionalText(CONTRACT_REASON_MAX).optional(),
      note: optionalText(CONTRACT_NOTE_MAX).optional(),
    })
    .strict()
    .superRefine((body, ctx) => {
      if (Object.values(body).every((v) => v === undefined)) ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Provide at least one field' });
    }),
) {}

export class ProposalDto extends createZodDto(
  z
    .object({
      proposal: z.enum(PROPOSALS),
      proposedStartDate: isoDate.nullable().optional(),
      proposedEndDate: isoDate.nullable().optional(),
      comment: optionalText(DECISION_COMMENT_MAX).optional(),
    })
    .strict(),
) {}
