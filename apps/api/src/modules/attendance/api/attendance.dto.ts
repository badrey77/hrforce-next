import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { isIsoDate, parseHhMm } from '../domain/time.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z
  .string()
  .regex(UUID, { message: 'Must be a UUID' })
  .transform((v) => v.toLowerCase());
const isoDate = z.string().refine(isIsoDate, { message: 'Must be a date written YYYY-MM-DD' });
const boolQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v !== 'false');
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, { message: min === 1 ? 'Required' : `At least ${min} characters` })
    .max(max, { message: `At most ${max} characters` });
const labels3 = z.object({ fr: text(1, 120), ar: text(1, 120), en: text(1, 120) });
const labels2 = z.object({ fr: text(1, 120), ar: text(1, 120) });
const tolerance = z.number().int().min(0, { message: 'Between 0 and 60' }).max(60, { message: 'Between 0 and 60' });
/** The week is validated by the domain (contract codes invalid_time / invalid_break / no_working_day). */
const week = z.array(z.unknown());
const STATUS = ['present', 'late', 'absent', 'incomplete', 'expected', 'on_leave', 'holiday', 'rest_day'] as const;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

// ── device side ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The one-time pairing code typed on the kiosk (redacted from logs: req.body.code). */
export class PairKioskDto extends createZodDto(z.object({ code: z.string().max(40, { message: 'At most 40 characters' }) })) {}

/** The QR token read by the phone's camera from `/punch#<token>` (input only, never echoed). */
export class ScanRequestDto extends createZodDto(z.object({ token: z.string().max(200, { message: 'At most 200 characters' }) })) {}

// ── presence ─────────────────────────────────────────────────────────────────────────────────────────────────────

export class DayRangeQueryDto extends createZodDto(
  z.object({
    from: z.string().optional(),
    to: z.string().optional(),
  }),
) {}

const pageQuery = {
  q: z.string().trim().max(100).optional().transform((v) => (v ? v : undefined)),
  status: z.enum(STATUS).optional(),
  sort: z.enum(['unit', 'name', 'arrival', 'status']).default('unit'),
  lang: z.enum(['fr', 'ar', 'en']).default('fr'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
};

export class PresenceQueryDto extends createZodDto(
  z.object({
    date: isoDate.optional(),
    unitId: uuid.optional(),
    includeSubUnits: boolQuery,
    siteId: uuid.optional(),
    ...pageQuery,
  }),
) {}

export class TeamQueryDto extends createZodDto(z.object({ date: isoDate.optional(), ...pageQuery })) {}

// ── punches ──────────────────────────────────────────────────────────────────────────────────────────────────────

export class ManualPunchDto extends createZodDto(
  z.object({
    direction: z.enum(['in', 'out']),
    date: isoDate,
    time: z.string().refine((v) => parseHhMm(v) !== null, { message: 'HH:MM, 00:00–23:59' }),
    reason: text(3, 500),
    siteId: uuid.optional(),
  }),
) {}

export class VoidPunchDto extends createZodDto(z.object({ reason: text(3, 500) })) {}

// ── configuration ────────────────────────────────────────────────────────────────────────────────────────────────

export class PolicyDto extends createZodDto(
  z.object({
    retentionMonths: z.number().int().min(12, { message: 'Between 12 and 120' }).max(120, { message: 'Between 12 and 120' }).optional(),
    minPunchGapSeconds: z.number().int().min(0, { message: 'Between 0 and 600' }).max(600, { message: 'Between 0 and 600' }).optional(),
  }),
) {}

export class CreateScheduleDto extends createZodDto(
  z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, { message: 'Lower-case letters, digits and _, starting with a letter (2–40)' }),
    labels: labels3,
    week,
    toleranceMinutes: tolerance,
    validFrom: isoDate.optional(),
  }),
) {}

export class UpdateScheduleDto extends createZodDto(z.object({ labels: labels3.optional(), active: z.boolean().optional() })) {}

export class ScheduleVersionDto extends createZodDto(z.object({ validFrom: isoDate, week, toleranceMinutes: tolerance })) {}

export class OverrideDto extends createZodDto(
  z.object({
    scheduleId: uuid.nullable(),
    labels: labels3,
    from: isoDate,
    to: isoDate,
    week,
    toleranceMinutes: tolerance,
    approximate: z.boolean().default(false),
  }),
) {}

export class OverridesQueryDto extends createZodDto(z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() })) {}

export class AssignmentsQueryDto extends createZodDto(
  z.object({
    targetKind: z.enum(['company', 'site', 'unit', 'employment']).optional(),
    scheduleId: uuid.optional(),
    at: z.union([isoDate, z.literal('all')]).optional(),
  }),
) {}

export class CreateAssignmentDto extends createZodDto(
  z.object({
    scheduleId: uuid,
    target: z.object({ kind: z.enum(['company', 'site', 'unit', 'employment']), id: uuid.nullable() }),
    validFrom: isoDate,
  }),
) {}

export class EndAssignmentDto extends createZodDto(z.object({ validTo: isoDate })) {}

export class CreateKioskDto extends createZodDto(
  z.object({
    siteId: uuid,
    labels: labels2,
    allowedNetworks: z.array(z.string().max(60)).max(10, { message: 'At most 10' }).optional(),
  }),
) {}

export class UpdateKioskDto extends createZodDto(
  z.object({
    siteId: uuid.optional(),
    labels: labels2.optional(),
    allowedNetworks: z.array(z.string().max(60)).max(10, { message: 'At most 10' }).optional(),
  }),
) {}

export class RevokeKioskDto extends createZodDto(z.object({ reason: text(3, 500) })) {}
