import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { PROFILE_SECTIONS, REQUEST_STATUSES } from '../domain/profile.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z
  .string()
  .regex(UUID, { message: 'Must be a UUID' })
  .transform((v) => v.toLowerCase());

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

const mode = z.enum(['immediate', 'approval']);

export class MyRequestsQueryDto extends createZodDto(z.object({ status: z.enum(REQUEST_STATUSES).optional() })) {}

export class HrRequestsQueryDto extends createZodDto(
  z.object({
    status: z.enum(REQUEST_STATUSES).optional(),
    section: z.enum(PROFILE_SECTIONS).optional(),
    unitId: uuid.optional(),
    includeSubUnits: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    q: z.string().trim().max(100).optional(),
    employmentId: uuid.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  }),
) {}

/** The multipart text field (`data` = JSON, parsed by the use case so its errors carry the contract's paths). */
export class SubmitRequestDto extends createZodDto(z.object({ data: z.string().max(200_000).optional() }).passthrough()) {}

export class ProfileSettingsDto extends createZodDto(
  z.object({
    contactMode: mode,
    emergencyMode: mode,
    familyMode: mode,
    fileRetentionDays: z.number().int().min(7, { message: 'At least 7 days' }).max(365, { message: 'At most 365 days' }),
  }),
) {}
