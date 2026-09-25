import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { CREATABLE_KINDS, isOrgUnitCode, ORG_UNIT_KINDS, ORG_UNIT_NAME_MAX } from '../domain/org-unit.js';
import { isIsoDate } from '../domain/versions.js';

const isoDate = z.string().refine(isIsoDate, { message: 'Must be a date written YYYY-MM-DD' });
/** Any 8-4-4-4-12 hex UUID (the seeded ids are hand-written UUIDv7s). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unitId = z
  .string()
  .regex(UUID, { message: 'Must be a UUID' })
  .transform((v) => v.toLowerCase());
const name = z
  .string()
  .trim()
  .min(1, { message: 'Name is required' })
  .max(ORG_UNIT_NAME_MAX, { message: `At most ${ORG_UNIT_NAME_MAX} characters` });

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export class OrgTreeQueryDto extends createZodDto(z.object({ asOf: isoDate.optional() })) {}

export class OrgUnitSearchQueryDto extends createZodDto(
  z.object({
    q: z.string().trim().max(100).optional(),
    kind: z.enum(ORG_UNIT_KINDS).optional(),
    asOf: isoDate.optional(),
  }),
) {}

export class CreateOrgUnitDto extends createZodDto(
  z.object({
    kind: z.enum(CREATABLE_KINDS),
    code: z.string().refine(isOrgUnitCode, { message: 'Code must match ^[A-Z0-9][A-Z0-9_-]{1,31}$' }),
    name,
    parentId: unitId,
    validFrom: isoDate.optional(),
  }),
) {}

export class ChangeOrgUnitDto extends createZodDto(
  z
    .object({
      name: name.optional(),
      parentId: unitId.optional(),
      validFrom: isoDate.optional(),
    })
    .superRefine((body, ctx) => {
      if (body.name === undefined && body.parentId === undefined) {
        ctx.addIssue({ code: 'custom', path: ['name'], message: 'Provide a new name and/or parentId' });
      }
    }),
) {}
