import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import {
  CODE_PATTERN,
  DECIMAL_SEPARATORS,
  ENCODINGS,
  FILE_EXTENSIONS,
  LAYOUTS,
  LINE_COLUMNS,
  MAX_COLUMNS,
  NAME_MAX,
  PAYROLL_UNITS,
  PERIOD_FORMATS,
  SEPARATORS,
  SETTINGS_RANGES,
} from '../domain/settings.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z
  .string()
  .regex(UUID, { message: 'Must be a UUID' })
  .transform((v) => v.toLowerCase());
const boolQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v !== 'false');

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

const range = (field: keyof typeof SETTINGS_RANGES) => {
  const [min, max] = SETTINGS_RANGES[field];
  return z
    .number()
    .int({ message: 'A whole number' })
    .min(min, { message: `Between ${min} and ${max}` })
    .max(max, { message: `Between ${min} and ${max}` })
    .optional();
};

/** Every field optional: the ones sent replace the current values (the others are kept). */
export class PayrollSettingsDto extends createZodDto(
  z
    .object({
      cutoffDay: range('cutoffDay'),
      regularizationMonths: range('regularizationMonths'),
      overtimeMinMinutes: range('overtimeMinMinutes'),
      layout: z.enum(LAYOUTS).optional(),
      separator: z.enum(SEPARATORS).optional(),
      decimalSeparator: z.enum(DECIMAL_SEPARATORS).optional(),
      encoding: z.enum(ENCODINGS).optional(),
      headerRow: z.boolean().optional(),
      columns: z.array(z.enum(LINE_COLUMNS)).min(1).max(MAX_COLUMNS).optional(),
      periodFormat: z.enum(PERIOD_FORMATS).optional(),
      fileExtension: z.enum(FILE_EXTENSIONS).optional(),
    })
    .strict(),
) {}

const exportCode = z.string().trim().regex(CODE_PATTERN, { message: '1–20 letters, digits, _ . -' });
const name = z.string().trim().min(1, { message: 'Required' }).max(NAME_MAX, { message: `At most ${NAME_MAX} characters` });
const names = z.object({ fr: name, ar: name, en: name }).strict();

export class CreateRubriqueDto extends createZodDto(
  z
    .object({
      exportCode,
      names,
      unit: z.enum(PAYROLL_UNITS),
    })
    .strict(),
) {}

export class UpdateRubriqueDto extends createZodDto(
  z
    .object({
      exportCode: exportCode.optional(),
      names: names.optional(),
      unit: z.enum(PAYROLL_UNITS).optional(),
      active: z.boolean().optional(),
      sortOrder: z.number().int({ message: 'A whole number' }).min(0).max(100000).optional(),
    })
    .strict(),
) {}

export class EmployeeCodeDto extends createZodDto(
  z
    .object({
      code: z
        .string()
        .trim()
        .transform((v) => (v === '' ? null : v))
        .pipe(z.string().regex(CODE_PATTERN, { message: '1–20 letters, digits, _ . -' }).nullable())
        .nullable(),
    })
    .strict(),
) {}

export class ExportQueryDto extends createZodDto(
  z.object({
    unitId: uuid.optional(),
    includeSubUnits: boolQuery,
    draft: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  }),
) {}

export class ControlQueryDto extends createZodDto(
  z.object({
    unitId: uuid.optional(),
    includeSubUnits: boolQuery,
    lang: z.enum(['fr', 'ar']).default('fr'),
  }),
) {}
