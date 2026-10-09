import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { isIsoDate } from '../../organization/index.js';
import {
  END_REASONS,
  isPositiveMoney,
  LIST_LANGS,
  JOB_TITLE_MAX,
  MATRICULE_PATTERN,
  NIN_PATTERN,
  NSS_PATTERN,
  PERSON_NAME_MAX,
  RIB_PATTERN,
} from '../domain/employee.js';

const isoDate = z.string().refine(isIsoDate, { message: 'Must be a date written YYYY-MM-DD' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z
  .string()
  .regex(UUID, { message: 'Must be a UUID' })
  .transform((v) => v.toLowerCase());

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

const requiredName = z.string().trim().min(1, { message: 'Required' }).max(PERSON_NAME_MAX, { message: `At most ${PERSON_NAME_MAX} characters` });
/** Optional text: trimmed; empty / blank / null → null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: `At most ${max} characters` })
    .nullable()
    .transform((v) => (v ? v : null));
/** Digits-only identifiers: spaces are ignored; empty / null → null. */
const digits = (pattern: RegExp, message: string) =>
  z
    .string()
    .transform((v) => v.replace(/\s+/g, ''))
    .nullable()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || pattern.test(v), { message });
const nin = digits(NIN_PATTERN, 'NIN: 18 digits');
const sex = z.enum(['M', 'F']).nullable();
const nationality = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z]{2}$/.test(v), { message: 'ISO 3166-1 alpha-2 code, e.g. DZ' });
const jobTitle = z.string().trim().min(1, { message: 'Required' }).max(JOB_TITLE_MAX, { message: `At most ${JOB_TITLE_MAX} characters` });
/** Money as a decimal STRING ("85000.00"): never a JSON number (float rounding). */
const money = z.string().trim().refine(isPositiveMoney, { message: 'A positive amount written like 85000 or 85000.00 (at most 10 digits before the point)' });
const siteId = uuid.nullable().optional();

const salaryBlock = z.object({ baseSalary: money });
const bankBlock = z.object({
  rib: digits(RIB_PATTERN, 'RIB: exactly 20 digits'),
  bankName: optionalText(120),
});
const nssBlock = z.object({ nss: digits(NSS_PATTERN, 'NSS: 10 to 15 digits') });

const PERSON_FIELDS = ['lastName', 'firstName', 'lastNameAr', 'firstNameAr', 'birthDate', 'birthPlace', 'sex', 'nationality', 'nin'] as const;

export class ListEmployeesQueryDto extends createZodDto(
  z.object({
    q: z.string().trim().max(100).optional(),
    unitId: uuid.optional(),
    includeSubUnits: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    siteId: uuid.optional(),
    status: z.enum(['active', 'ended', 'all']).default('active'),
    asOf: isoDate.optional(),
    sort: z.enum(['name', 'matricule', 'hireDate', 'unit']).default('name'),
    dir: z.enum(['asc', 'desc']).default('asc'),
    lang: z.enum(LIST_LANGS).default('fr'),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  }),
) {}

/**
 * POST /employees. Person fields are flat (so the 409 fields `nin` / `matricule` / `personId` match the body); the
 * sensitive blocks are nested like in the detail (`salary`, `bank`, `nss`), which is what `forbidden-field` names.
 * With `personId` (rehire) the person fields must be omitted; otherwise lastName and firstName are required.
 * The shape and its rule are exported: the hire of a recruited candidate takes the SAME body (plus two fields of its
 * own — docs/contracts/recruitment.md › Hire).
 */
export const createEmployeeShape = {
      personId: uuid.optional(),
      lastName: requiredName.optional(),
      firstName: requiredName.optional(),
      lastNameAr: optionalText(PERSON_NAME_MAX).optional(),
      firstNameAr: optionalText(PERSON_NAME_MAX).optional(),
      birthDate: isoDate.nullable().optional(),
      birthPlace: optionalText(120).optional(),
      sex: sex.optional(),
      nationality: nationality.optional(),
      nin: nin.optional(),
      matricule: z
        .string()
        .trim()
        .transform((v) => v.toUpperCase())
        .refine((v) => MATRICULE_PATTERN.test(v), { message: 'Matricule must match ^[A-Z0-9][A-Z0-9-]{0,19}$' }),
      hireDate: isoDate,
      orgUnitId: uuid,
      siteId,
      jobTitle,
      salary: salaryBlock.optional(),
      bank: bankBlock.optional(),
      nss: nssBlock.optional(),
};

/** With `personId` (rehire) no person field is accepted; without it lastName and firstName are required. */
export function refineCreateEmployee(body: Partial<Record<(typeof PERSON_FIELDS)[number] | 'personId', unknown>>, ctx: z.RefinementCtx): void {
  if (body.personId !== undefined) {
    for (const field of PERSON_FIELDS) {
      if (body[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'Not allowed together with personId (rehire)' });
    }
    return;
  }
  if (body.lastName === undefined) ctx.addIssue({ code: 'custom', path: ['lastName'], message: 'Required' });
  if (body.firstName === undefined) ctx.addIssue({ code: 'custom', path: ['firstName'], message: 'Required' });
}

export class CreateEmployeeDto extends createZodDto(z.object(createEmployeeShape).superRefine(refineCreateEmployee)) {}

export class UpdatePersonDto extends createZodDto(
  z
    .object({
      lastName: requiredName.optional(),
      firstName: requiredName.optional(),
      lastNameAr: optionalText(PERSON_NAME_MAX).optional(),
      firstNameAr: optionalText(PERSON_NAME_MAX).optional(),
      birthDate: isoDate.nullable().optional(),
      birthPlace: optionalText(120).optional(),
      sex: sex.optional(),
      nationality: nationality.optional(),
      nin: nin.optional(),
    })
    .superRefine((body, ctx) => {
      if (PERSON_FIELDS.every((f) => body[f] === undefined)) {
        ctx.addIssue({ code: 'custom', path: ['lastName'], message: 'Provide at least one person field' });
      }
    }),
) {}

export class AssignDto extends createZodDto(z.object({ orgUnitId: uuid, siteId, jobTitle, validFrom: isoDate })) {}

export class EndEmploymentDto extends createZodDto(z.object({ endDate: isoDate, reason: z.enum(END_REASONS) })) {}

export class SetSalaryDto extends createZodDto(z.object({ baseSalary: money, validFrom: isoDate })) {}

export class SetBankDto extends createZodDto(bankBlock) {}

export class SetNssDto extends createZodDto(nssBlock) {}
