import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { DEADLINE_KINDS, DEFAULT_WITHIN_DAYS, MAX_WITHIN_DAYS, POLICY_RANGES } from '../domain/types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z
  .string()
  .regex(UUID, { message: 'Must be a UUID' })
  .transform((v) => v.toLowerCase());
const isoDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, { message: 'Must be a date written YYYY-MM-DD' });
const boolQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v !== 'false');

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export class DeadlinesQueryDto extends createZodDto(
  z.object({
    kind: z.enum(DEADLINE_KINDS).optional(),
    status: z.enum(['open', 'handled', 'all']).default('open'),
    unitId: uuid.optional(),
    includeSubUnits: boolQuery,
    within: z.coerce.number().int().min(0).max(MAX_WITHIN_DAYS).default(DEFAULT_WITHIN_DAYS),
    q: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((v) => (v ? v : undefined)),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  }),
) {}

export class AckDeadlineDto extends createZodDto(
  z.object({
    kind: z.enum(DEADLINE_KINDS),
    subjectId: uuid,
    dueDate: isoDate,
    note: z
      .string()
      .trim()
      .max(300, { message: 'At most 300 characters' })
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
  }),
) {}

const days = (field: keyof typeof POLICY_RANGES) => {
  const [min, max] = POLICY_RANGES[field];
  return z
    .number()
    .int({ message: 'A whole number' })
    .min(min, { message: `Between ${min} and ${max}` })
    .max(max, { message: `Between ${min} and ${max}` })
    .optional();
};

/** Every field optional: the ones sent replace the current values (the others are kept). */
export class DeadlinePolicyDto extends createZodDto(
  z
    .object({
      probationNoticeDays: days('probationNoticeDays'),
      contractNoticeDays: days('contractNoticeDays'),
      decisionNoticeDays: days('decisionNoticeDays'),
      documentNoticeDays: days('documentNoticeDays'),
      retirementAge: days('retirementAge'),
      retirementNoticeMonths: days('retirementNoticeMonths'),
      digestEnabled: z.boolean().optional(),
    })
    .strict(),
) {}
