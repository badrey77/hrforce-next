import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { isIsoDate } from '../../organization/index.js';
import { RIB_PATTERN } from '../domain/employee.js';
import {
  ADDRESS_LINE_MAX,
  CHILD_NAME_MAX,
  COMMUNE_MAX,
  CONTACT_NAME_MAX,
  isValidEmail,
  isValidPhone,
  MARITAL_STATUSES,
  normalizeEmail,
  normalizePhone,
  normalizeWilaya,
  POSTAL_CODE_PATTERN,
  RELATIONSHIPS,
  SPOUSE_EMPLOYED,
  WILAYA_CODE_PATTERN,
} from '../domain/personal.js';

/**
 * Bodies of the personal-details sections (docs/contracts/profile-changes.md › Employment additions). Exported: the
 * self-service requests (module `profile`) validate their `payload` with the SAME schemas (field paths prefixed with
 * `payload.` by the caller). Rules that need the person's children or today's date are checked by the use cases
 * (domain `familyErrors`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDate = z.string().refine(isIsoDate, { message: 'Must be a date written YYYY-MM-DD' });

/** Optional text: trimmed; empty / blank / null → null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: `At most ${max} characters` })
    .nullable()
    .transform((v) => (v ? v : null));

const phone = z
  .string()
  .trim()
  .refine(isValidPhone, { message: 'A phone number: digits and spaces, optionally starting with +, 8 to 20 characters', params: { code: 'invalid_phone' } })
  .transform(normalizePhone);
/** An optional phone: empty / blank / null → null. */
const optionalPhone = z
  .string()
  .trim()
  .nullable()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isValidPhone(v), { message: 'A phone number: digits and spaces, optionally starting with +, 8 to 20 characters', params: { code: 'invalid_phone' } })
  .transform((v) => (v === null ? null : normalizePhone(v)));

export const contactInputSchema = z.object({
  mobilePhone: optionalPhone,
  otherPhone: optionalPhone,
  personalEmail: z
    .string()
    .trim()
    .nullable()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || isValidEmail(v), { message: 'An e-mail address (at most 254 characters)', params: { code: 'invalid_email' } })
    .transform((v) => (v === null ? null : normalizeEmail(v))),
  addressLine: optionalText(ADDRESS_LINE_MAX),
  commune: optionalText(COMMUNE_MAX),
  wilayaCode: z
    .string()
    .trim()
    .nullable()
    .transform((v) => (v ? normalizeWilaya(v) : null))
    .refine((v) => v === null || WILAYA_CODE_PATTERN.test(v), { message: 'A wilaya code from 01 to 58', params: { code: 'invalid_wilaya' } }),
  postalCode: z
    .string()
    .trim()
    .nullable()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || POSTAL_CODE_PATTERN.test(v), { message: 'A postal code: 5 digits', params: { code: 'invalid_postal_code' } }),
});

export const emergencyInputSchema = z.object({
  fullName: z.string().trim().min(1, { message: 'Required' }).max(CONTACT_NAME_MAX, { message: `At most ${CONTACT_NAME_MAX} characters` }),
  relationship: z.enum(RELATIONSHIPS),
  phone,
});

const childSchema = z.object({
  id: z
    .string()
    .regex(UUID, { message: 'Must be a UUID' })
    .transform((v) => v.toLowerCase())
    .optional(),
  firstName: z.string().trim().min(1, { message: 'Required' }).max(CHILD_NAME_MAX, { message: `At most ${CHILD_NAME_MAX} characters` }),
  birthDate: isoDate,
  sex: z.enum(['M', 'F']).nullable(),
  dependent: z.boolean(),
});

export const familyInputSchema = z.object({
  maritalStatus: z.enum(MARITAL_STATUSES).nullable(),
  maritalStatusSince: isoDate.nullable(),
  spouseEmployed: z.enum(SPOUSE_EMPLOYED).nullable(),
  // the 15-children limit is checked by the use case (one error on `children`), not here
  children: z.array(childSchema).max(100, { message: 'Too many children' }),
});

/** A bank change asked by the employee: both fields required (HR's PUT /employees/:id/bank stays as it is). */
export const bankInputSchema = z.object({
  rib: z
    .string()
    .transform((v) => v.replace(/\s+/g, ''))
    .refine((v) => RIB_PATTERN.test(v), { message: 'RIB: exactly 20 digits' }),
  bankName: z.string().trim().min(1, { message: 'Required' }).max(120, { message: 'At most 120 characters' }),
});

export class ContactDto extends createZodDto(contactInputSchema) {}
/** The body `null` clears the emergency contact (wrapped: a DTO class needs an object output). */
export class EmergencyDto extends createZodDto(emergencyInputSchema.nullable().transform((value) => ({ value }))) {}
export class FamilyDto extends createZodDto(familyInputSchema) {}
