import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { isIsoDate } from '../domain/dates.js';
import { isWeekendSet } from '../domain/rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z
  .string()
  .regex(UUID, { message: 'Must be a UUID' })
  .transform((v) => v.toLowerCase());
const isoDate = z.string().refine(isIsoDate, { message: 'Must be a date written YYYY-MM-DD' });
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: `At most ${max} characters` })
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));
const label = z.string().trim().min(1, { message: 'Required' }).max(120, { message: 'At most 120 characters' });
const labels = z.object({ fr: label, ar: label, en: label });
/** A day amount written with at most one decimal (numeric(5,1)). */
const dayAmount = z.number().refine((v) => Math.abs(Math.round(v * 10) - v * 10) < 1e-9, { message: 'At most one decimal' });
const boolQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v !== 'false');

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

const requestShape = {
  leaveTypeId: uuid,
  startDate: isoDate,
  endDate: isoDate,
  halfDayStart: z.boolean().default(false),
  halfDayEnd: z.boolean().default(false),
  reason: optionalText(500),
  documentRef: optionalText(200),
};

export class LeaveRequestDto extends createZodDto(z.object(requestShape)) {}

export class LeavePreviewDto extends createZodDto(z.object({ ...requestShape, employmentId: uuid.optional() })) {}

export class BalancesQueryDto extends createZodDto(z.object({ asOf: isoDate.optional() })) {}

export class HolidaysQueryDto extends createZodDto(z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() })) {}

export class LeaveListQueryDto extends createZodDto(
  z.object({
    status: z
      .enum(['pending', 'approved', 'rejected', 'cancelled', 'all'])
      .optional()
      .transform((v) => (v === 'all' ? undefined : v)),
    unitId: uuid.optional(),
    includeSubUnits: boolQuery,
    from: isoDate.optional(),
    to: isoDate.optional(),
    typeId: uuid.optional(),
    q: z.string().trim().max(100).optional().transform((v) => (v ? v : undefined)),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  }),
) {}

export class UpdateLeaveTypeDto extends createZodDto(
  z.object({
    labels: labels.optional(),
    countMode: z.enum(['calendar', 'working']).optional(),
    hasBalance: z.boolean().optional(),
    accrualDaysPerMonth: z.number().positive().max(31).multipleOf(0.01).nullable().optional(),
    maxDaysPerYear: dayAmount.pipe(z.number().positive().max(366)).nullable().optional(),
    maxDaysPerRequest: dayAmount.pipe(z.number().positive().max(366)).nullable().optional(),
    oncePerCareer: z.boolean().optional(),
    requiresDocument: z.boolean().optional(),
    workflowDefinitionId: uuid.optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  }),
) {}

export class HolidayDto extends createZodDto(z.object({ date: isoDate, labels, approximate: z.boolean().default(false) })) {}

export class PolicyDto extends createZodDto(
  z.object({
    referenceStartMonth: z.number().int().min(1).max(12),
    weekendDays: z.array(z.number().int()).refine(isWeekendSet, { message: 'Distinct ISO weekdays 1–7, at most 3' }),
    entitlementDelayMonths: z.number().int().min(0).max(24).optional(),
  }),
) {}

export class AdjustmentDto extends createZodDto(
  z.object({
    leaveTypeId: uuid,
    periodStart: isoDate,
    days: dayAmount.refine((v) => v !== 0 && Math.abs(v) <= 366, { message: 'Non-zero, at most 366 days' }),
    note: z.string().trim().min(1, { message: 'A note is required' }).max(500, { message: 'At most 500 characters' }),
  }),
) {}

export class AccrualRunDto extends createZodDto(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Must be YYYY-MM' }) })) {}
