import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { ROLE_CODE_PATTERN, ROLE_NAME_MAX } from '../domain/catalogue.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const uuid = z
  .string()
  .regex(UUID, { message: 'Must be a UUID' })
  .transform((v) => v.toLowerCase());
const isoDate = z.string().refine(isIsoDate, { message: 'Must be a date written YYYY-MM-DD' });
const name = z
  .string()
  .trim()
  .min(1, { message: 'Name is required' })
  .max(ROLE_NAME_MAX, { message: `At most ${ROLE_NAME_MAX} characters` });
const names = z.object({ fr: name, ar: name, en: name });
const permissions = z.array(z.string().min(1).max(64)).max(100);

export class CreateRoleDto extends createZodDto(
  z.object({
    code: z.string().refine((v) => ROLE_CODE_PATTERN.test(v), { message: 'Code must match ^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$' }),
    names,
    permissions,
  }),
) {}

export class UpdateRoleDto extends createZodDto(
  z
    .object({ names: names.optional(), permissions: permissions.optional() })
    .superRefine((body, ctx) => {
      if (body.names === undefined && body.permissions === undefined) {
        ctx.addIssue({ code: 'custom', path: ['names'], message: 'Provide names and/or permissions' });
      }
    }),
) {}

export class UsersQueryDto extends createZodDto(z.object({ q: z.string().trim().max(100).optional() })) {}

export class GrantsQueryDto extends createZodDto(
  z.object({
    userId: uuid.optional(),
    unitId: uuid.optional(),
    includeEnded: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  }),
) {}

export class CreateGrantDto extends createZodDto(
  z.object({
    userId: uuid,
    roleId: uuid,
    orgUnitId: uuid,
    includeDescendants: z.boolean().default(true),
    validFrom: isoDate.optional(),
    validTo: isoDate.nullable().optional(),
  }),
) {}

export class EndGrantDto extends createZodDto(z.object({ validTo: isoDate })) {}

/** PUT /api/access/security-policy */
export class SecurityPolicyDto extends createZodDto(
  z.object({
    mfaEnforced: z.boolean(),
    mfaRequiredPermissions: z.array(z.string().min(1).max(64)).max(100),
  }),
) {}
