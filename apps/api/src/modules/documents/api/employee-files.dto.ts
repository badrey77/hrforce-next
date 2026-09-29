import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { CATEGORY_CODE_PATTERN } from '../domain/employee-files.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z
  .string()
  .regex(UUID, { message: 'Must be a UUID' })
  .transform((v) => v.toLowerCase());
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, { message: min === 1 ? 'Required' : `At least ${min} characters` })
    .max(max, { message: `At most ${max} characters` });
/** Multipart text fields arrive as strings: an absent or empty date is null. */
const optionalDate = z
  .string()
  .trim()
  .regex(/^(\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))?$/, { message: 'Must be a date written YYYY-MM-DD' })
  .refine((v) => v === '' || new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), { message: 'Not a calendar date' })
  .optional()
  .transform((v) => (v ? v : null));
const labels = z.object({ fr: text(1, 120), ar: text(1, 120), en: text(1, 120) });
const retention = z.number().int().min(1, { message: 'At least 1 year' }).max(100, { message: 'At most 100 years' }).nullable();

/** Text fields of the multipart upload (the file itself is `file`). */
export class UploadFileDto extends createZodDto(
  z.object({
    categoryId: uuid,
    title: text(1, 120),
    documentDate: optionalDate,
    expiresOn: optionalDate,
  }),
) {}

export class ListFilesQueryDto extends createZodDto(
  z.object({
    categoryId: uuid.optional(),
    includeDeleted: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  }),
) {}

export class DeleteFileDto extends createZodDto(z.object({ reason: text(3, 500) })) {}

export class CreateCategoryDto extends createZodDto(
  z.object({
    code: z.string().trim().regex(CATEGORY_CODE_PATTERN, { message: 'Lower-case letters, digits and _, starting with a letter (2–40)' }),
    labels,
    retentionYearsAfterEnd: retention.optional(),
  }),
) {}

export class UpdateCategoryDto extends createZodDto(
  z.object({
    labels: labels.optional(),
    retentionYearsAfterEnd: retention.optional(),
    active: z.boolean().optional(),
  }),
) {}
