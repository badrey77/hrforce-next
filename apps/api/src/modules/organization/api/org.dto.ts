import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { isOrgUnitCode, ORG_UNIT_NAME_MAX } from '../domain/org-unit.js';
import { isIsoDate } from '../domain/versions.js';

const isoDate = z.string().refine(isIsoDate, { message: 'Must be a date written YYYY-MM-DD' });
/** Any 8-4-4-4-12 hex UUID (the seeded ids are hand-written UUIDv7s). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z
  .string()
  .regex(UUID, { message: 'Must be a UUID' })
  .transform((v) => v.toLowerCase());
const name = z
  .string()
  .trim()
  .min(1, { message: 'Name is required' })
  .max(ORG_UNIT_NAME_MAX, { message: `At most ${ORG_UNIT_NAME_MAX} characters` });
/** Optional Arabic name: trimmed, 1–120 characters; empty / blank / null → null (no Arabic name). */
const nameAr = z
  .string()
  .trim()
  .max(ORG_UNIT_NAME_MAX, { message: `At most ${ORG_UNIT_NAME_MAX} characters` })
  .nullable()
  .transform((v) => (v ? v : null));
const code = z.string().refine(isOrgUnitCode, { message: 'Code must match ^[A-Z0-9][A-Z0-9_-]{1,31}$' });
/**
 * Kind codes are data (GET /org/kinds): the DTO checks the shape, the service checks the catalogue (unknown → 422
 * on `kind` as well).
 */
const kindCode = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/, { message: 'Unknown kind' });
/** siteId: a UUID, or null (= inherit from the nearest ancestor). */
const siteId = uuid.nullable();

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export class OrgTreeQueryDto extends createZodDto(z.object({ asOf: isoDate.optional() })) {}

export class OrgUnitSearchQueryDto extends createZodDto(
  z.object({
    q: z.string().trim().max(100).optional(),
    // `kind` may repeat: ?kind=region&kind=agency (Express parses repeated keys into an array)
    kind: z
      .union([kindCode, z.array(kindCode).max(20)])
      .optional()
      .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
    asOf: isoDate.optional(),
  }),
) {}

export class CreateOrgUnitDto extends createZodDto(
  z.object({
    kind: kindCode,
    code,
    name,
    nameAr: nameAr.optional(),
    parentId: uuid,
    siteId: siteId.optional(),
    validFrom: isoDate.optional(),
  }),
) {}

export class ChangeOrgUnitDto extends createZodDto(
  z
    .object({
      name: name.optional(),
      nameAr: nameAr.optional(),
      parentId: uuid.optional(),
      siteId: siteId.optional(),
      validFrom: isoDate.optional(),
    })
    .superRefine((body, ctx) => {
      if (body.name === undefined && body.nameAr === undefined && body.parentId === undefined && body.siteId === undefined) {
        ctx.addIssue({ code: 'custom', path: ['name'], message: 'Provide a new name, nameAr, parentId and/or siteId' });
      }
    }),
) {}

export class SiteSearchQueryDto extends createZodDto(z.object({ q: z.string().trim().max(100).optional() })) {}

export class CreateSiteDto extends createZodDto(
  z.object({
    code,
    name,
    wilaya: z.string().trim().min(1, { message: 'Wilaya is required' }).max(60, { message: 'At most 60 characters' }),
    // empty / blank → null (no address)
    address: z
      .string()
      .trim()
      .max(300, { message: 'At most 300 characters' })
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
  }),
) {}
