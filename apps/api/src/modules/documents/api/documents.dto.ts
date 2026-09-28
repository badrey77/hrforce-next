import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { DOCUMENT_LANGUAGES, DOCUMENT_TYPE_CODES } from '../domain/types.js';

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

const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, { message: min === 1 ? 'Required' : `At least ${min} characters` })
    .max(max, { message: `At most ${max} characters` });
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: `At most ${max} characters` })
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));
/** NIF / NIS / RC / article d'imposition: digits, capitals, space, slash, hyphen (upper-cased). */
const identifier = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9A-Z /-]{0,30}$/, { message: 'Digits, capital letters, space, / and - (at most 30)' })
  .nullable()
  .optional()
  .transform((v) => (v ? v : null));
const pair = (max: number) => z.object({ fr: text(1, max), ar: text(1, max) });

export const issueShape = z.object({
  typeCode: z.enum(DOCUMENT_TYPE_CODES),
  employmentId: uuid.optional(),
  leaveRequestId: uuid.optional(),
  language: z.enum(DOCUMENT_LANGUAGES),
  signatoryId: uuid.optional(),
  clientRequestId: uuid.optional(),
});

export class IssueDocumentDto extends createZodDto(issueShape) {}

export class RegisterQueryDto extends createZodDto(
  z.object({
    typeCode: z.enum(DOCUMENT_TYPE_CODES).optional(),
    status: z
      .enum(['issued', 'void', 'all'])
      .optional()
      .transform((v) => (v === 'all' ? undefined : v)),
    employmentId: uuid.optional(),
    leaveRequestId: uuid.optional(),
    unitId: uuid.optional(),
    includeSubUnits: boolQuery,
    from: isoDate.optional(),
    to: isoDate.optional(),
    q: z.string().trim().max(100).optional().transform((v) => (v ? v : undefined)),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  }),
) {}

export class DispositionQueryDto extends createZodDto(z.object({ disposition: z.enum(['attachment', 'inline']).default('attachment') })) {}

export class SignatoriesQueryDto extends createZodDto(z.object({ employmentId: uuid.optional() })) {}

export class VoidDocumentDto extends createZodDto(z.object({ reason: text(3, 500) })) {}

export class UpdateDocumentTypeDto extends createZodDto(
  z.object({
    numberFormat: z.string().trim().min(1).max(60).optional(),
    languages: z.array(z.enum(DOCUMENT_LANGUAGES)).min(1, { message: 'At least one language' }).max(2).optional(),
    selfService: z.boolean().optional(),
    defaultSignatoryId: uuid.nullable().optional(),
    active: z.boolean().optional(),
  }),
) {}

export class ProfileDto extends createZodDto(
  z.object({
    legalNameFr: text(1, 200),
    legalNameAr: optionalText(200),
    addressFr: text(1, 300),
    addressAr: optionalText(300),
    cityFr: text(1, 200),
    cityAr: optionalText(200),
    phone: z
      .string()
      .trim()
      .regex(/^[0-9+ ().-]{0,40}$/, { message: 'Digits, spaces, + ( ) . - (at most 40)' })
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
    email: z
      .union([z.email({ message: 'Must be an e-mail address' }).max(200), z.literal('')])
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
    nif: identifier,
    nis: identifier,
    rc: identifier,
    ai: identifier,
    footerFr: optionalText(300),
    footerAr: optionalText(300),
  }),
) {}

export class CreateSignatoryDto extends createZodDto(z.object({ orgUnitId: uuid.nullable(), names: pair(120), titles: pair(120) })) {}

export class UpdateSignatoryDto extends createZodDto(
  z.object({ orgUnitId: uuid.nullable().optional(), names: pair(120).optional(), titles: pair(120).optional(), active: z.boolean().optional() }),
) {}

export class DocumentRequestDto extends createZodDto(
  z.object({ typeCode: z.enum(DOCUMENT_TYPE_CODES), language: z.enum(DOCUMENT_LANGUAGES), purpose: optionalText(200) }),
) {}
