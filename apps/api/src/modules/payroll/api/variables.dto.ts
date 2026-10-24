import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z
  .string()
  .regex(UUID, { message: 'Must be a UUID' })
  .transform((v) => v.toLowerCase());
const boolQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v !== 'false');
const monthString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'A month written YYYY-MM' });
const MAX_VALUE = 999_999_999.99;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export class PeriodsQueryDto extends createZodDto(
  z.object({
    year: z.coerce.number().int().min(2000).max(2100).optional(),
  }),
) {}

export class VariablesQueryDto extends createZodDto(
  z.object({
    unitId: uuid.optional(),
    includeSubUnits: boolQuery,
    q: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((v) => (v ? v : undefined)),
    rubriqueId: uuid.optional(),
    filter: z.enum(['adjusted', 'regularization', 'flagged']).optional(),
    lang: z.enum(['fr', 'ar', 'en']).default('fr'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  }),
) {}

export class LineDto extends createZodDto(
  z
    .object({
      rubriqueId: uuid,
      originMonth: monthString.optional(),
      value: z
        .number({ message: 'A number' })
        .finite()
        .min(-MAX_VALUE, { message: `Between -${MAX_VALUE} and ${MAX_VALUE}` })
        .max(MAX_VALUE, { message: `Between -${MAX_VALUE} and ${MAX_VALUE}` })
        .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, { message: 'At most two decimals' }),
      note: z
        .string()
        .trim()
        .max(300, { message: 'At most 300 characters' })
        .nullable()
        .optional()
        .transform((v) => (v ? v : null)),
    })
    .strict(),
) {}

export class DeleteLineQueryDto extends createZodDto(
  z.object({
    originMonth: monthString.optional(),
  }),
) {}

export class CloseDto extends createZodDto(z.object({}).strict()) {}

export class ReopenDto extends createZodDto(
  z
    .object({
      reason: z.string().trim().min(5, { message: 'Between 5 and 300 characters' }).max(300, { message: 'Between 5 and 300 characters' }),
    })
    .strict(),
) {}
