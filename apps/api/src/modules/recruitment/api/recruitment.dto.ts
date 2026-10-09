import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { createEmployeeShape, refineCreateEmployee } from '../../employment/index.js';
import {
  CONTRACT_TYPES,
  COPY_FILES_MAX,
  FILE_KINDS,
  INTERVIEW_MODES,
  INTERVIEWERS_MAX,
  isClockTime,
  isIsoDate,
  isPositiveMoney,
  OPENING_CRITERIA_MAX,
  OPENING_STATUSES,
  RECOMMENDATIONS,
  RETENTION_MONTHS_MAX,
  RETENTION_MONTHS_MIN,
  SOURCES,
  STAGES,
  WORKFLOW_CODES,
} from '../domain/rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z
  .string()
  .regex(UUID, { message: 'Must be a UUID' })
  .transform((v) => v.toLowerCase());
const isoDate = z.string().refine(isIsoDate, { message: 'Must be a date written YYYY-MM-DD' });
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, { message: min === 1 ? 'Required' : `At least ${min} characters` })
    .max(max, { message: `At most ${max} characters` });
/** Optional text: trimmed; empty / blank / null → null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: `At most ${max} characters` })
    .nullable()
    .transform((v) => (v ? v : null));
/** An optional comment: trimmed, empty → absent. */
const comment = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: `At most ${max} characters` })
    .optional()
    .transform((v) => (v ? v : undefined));
const boolQuery = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true'));
const labels = z.object({ fr: text(1, 120), ar: text(1, 120), en: text(1, 120) });
/** Money as a decimal STRING ("85000.00"): never a JSON number (float rounding). */
const money = z.string().trim().refine(isPositiveMoney, { message: 'A positive amount written like 85000 or 85000.00 (at most 10 digits before the point)' });
const posts = z.number().int().min(1, { message: 'Between 1 and 99' }).max(99, { message: 'Between 1 and 99' });
const page = z.coerce.number().int().min(1).max(100000).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(25);
const search = z.string().trim().max(100).optional().transform((v) => (v ? v : undefined));
const stage = z.enum(STAGES);

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

// ── openings ─────────────────────────────────────────────────────────────────────────────────────────────────────

export class RequestOpeningDto extends createZodDto(
  z.object({
    title: text(1, 120),
    orgUnitId: uuid,
    siteId: uuid.nullable().optional(),
    contractType: z.enum(CONTRACT_TYPES),
    posts,
    justification: text(3, 2000),
    targetDate: isoDate,
  }),
) {}

export class OpeningsQueryDto extends createZodDto(
  z.object({
    status: z.enum([...OPENING_STATUSES, 'active', 'all']).default('active'),
    unitId: uuid.optional(),
    includeSubUnits: boolQuery(true),
    contractType: z.enum(CONTRACT_TYPES).optional(),
    q: search,
    sort: z.enum(['requestedAt', 'targetDate', 'title', 'unit']).default('requestedAt'),
    dir: z.enum(['asc', 'desc']).optional(),
    page,
    pageSize,
  }),
) {}

export class UpdateOpeningDto extends createZodDto(
  z.object({
    targetDate: isoDate.optional(),
    siteId: uuid.nullable().optional(),
    anemReference: optionalText(40).optional(),
    posts: posts.optional(),
  }),
) {}

export class CloseOpeningDto extends createZodDto(z.object({ reason: text(3, 500) })) {}

export class BoardQueryDto extends createZodDto(z.object({ includeFinal: boolQuery(false) })) {}

// ── candidates ───────────────────────────────────────────────────────────────────────────────────────────────────

const name = text(1, 80);
/** Digits-only identifier: spaces are ignored; empty / null → null. */
const nin = z
  .string()
  .transform((v) => v.replace(/\s+/g, ''))
  .nullable()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /^[0-9]{18}$/.test(v), { message: 'NIN: 18 digits' });
const email = z
  .string()
  .trim()
  .max(254, { message: 'At most 254 characters' })
  .nullable()
  .transform((v) => (v ? v.toLowerCase() : null))
  .refine((v) => v === null || /^[^@\s]+@[^@\s]+$/.test(v), { message: 'Not an e-mail address' });
const phone = z
  .string()
  .trim()
  .max(30, { message: 'At most 30 characters' })
  .nullable()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /\d/.test(v), { message: 'A phone number holds digits' });
const nationality = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z]{2}$/.test(v), { message: 'ISO 3166-1 alpha-2 code, e.g. DZ' });

const candidateOptional = {
  lastNameAr: optionalText(80).optional(),
  firstNameAr: optionalText(80).optional(),
  birthDate: isoDate.nullable().optional(),
  birthPlace: optionalText(120).optional(),
  sex: z.enum(['M', 'F']).nullable().optional(),
  nationality: nationality.optional(),
  nin: nin.optional(),
  email: email.optional(),
  phone: phone.optional(),
  informedOn: isoDate.nullable().optional(),
};
const candidateInput = z.object({ lastName: name, firstName: name, ...candidateOptional });

/** At least one of nin / email / phone / the name pair, else 422 (the answer would be empty anyway). */
export class MatchCandidatesDto extends createZodDto(
  z
    .object({
      nin: z
        .string()
        .transform((v) => v.replace(/\s+/g, ''))
        .optional()
        .transform((v) => (v ? v : undefined))
        .refine((v) => v === undefined || /^[0-9]{18}$/.test(v), { message: 'NIN: 18 digits' }),
      email: z.string().trim().max(254).optional().transform((v) => (v ? v.toLowerCase() : undefined)),
      phone: z.string().trim().max(30).optional().transform((v) => (v ? v : undefined)),
      lastName: z.string().trim().max(80).optional().transform((v) => (v ? v : undefined)),
      firstName: z.string().trim().max(80).optional().transform((v) => (v ? v : undefined)),
      birthDate: isoDate.optional(),
      excludeCandidateId: uuid.optional(),
    })
    .refine((v) => v.nin !== undefined || v.email !== undefined || v.phone !== undefined || (v.lastName !== undefined && v.firstName !== undefined), {
      message: 'Give a NIN, an e-mail, a phone number or both names.',
      path: ['nin'],
      params: { code: 'required' },
    }),
) {}

export class CandidatesQueryDto extends createZodDto(
  z.object({
    q: search,
    openingId: uuid.optional(),
    stage: stage.optional(),
    state: z.enum(['active', 'final', 'all']).default('active'),
    idleMonths: z.coerce.number().int().min(1).max(60).optional(),
    unitId: uuid.optional(),
    includeSubUnits: boolQuery(true),
    sort: z.enum(['name', 'stageSince', 'createdAt']).default('name'),
    dir: z.enum(['asc', 'desc']).optional(),
    lang: z.enum(['fr', 'ar', 'en']).default('fr'),
    page,
    pageSize,
  }),
) {}

export class UpdateCandidateDto extends createZodDto(
  z.object({ lastName: name.optional(), firstName: name.optional(), ...candidateOptional, allowDuplicate: z.boolean().optional() }),
) {}

export class LinkPersonDto extends createZodDto(z.object({ personId: uuid.nullable() })) {}

// ── applications ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Either `candidateId` (an existing candidate) or `candidate` (a new one) — both or neither is a 422. */
export class CreateApplicationDto extends createZodDto(
  z
    .object({
      candidateId: uuid.optional(),
      candidate: candidateInput.optional(),
      allowDuplicate: z.boolean().optional(),
      source: z.enum(SOURCES),
      expectedSalary: money.optional(),
      comment: comment(1000),
    })
    .refine((v) => (v.candidateId === undefined) !== (v.candidate === undefined), {
      message: 'Give either `candidateId` or `candidate`.',
      path: ['candidate'],
      params: { code: 'one_of' },
    }),
) {}

export class UpdateApplicationDto extends createZodDto(z.object({ source: z.enum(SOURCES).optional(), expectedSalary: money.nullable().optional() })) {}

export class MoveApplicationDto extends createZodDto(
  z.object({
    toStage: stage,
    expectedStage: stage,
    rejectionReasonId: uuid.optional(),
    comment: comment(1000),
  }),
) {}

export class ReopenApplicationDto extends createZodDto(z.object({ expectedStage: stage })) {}

export class NoteDto extends createZodDto(z.object({ body: text(1, 4000) })) {}

/** Text fields of the multipart upload (the file itself is `file`). */
export class UploadCandidateFileDto extends createZodDto(z.object({ kind: z.enum(FILE_KINDS), title: text(1, 120) })) {}

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

export class PolicyDto extends createZodDto(
  z.object({
    retentionMonths: z
      .number()
      .int()
      .min(RETENTION_MONTHS_MIN, { message: `Between ${RETENTION_MONTHS_MIN} and ${RETENTION_MONTHS_MAX}` })
      .max(RETENTION_MONTHS_MAX, { message: `Between ${RETENTION_MONTHS_MIN} and ${RETENTION_MONTHS_MAX}` })
      .optional(),
    openingWorkflowCode: z.enum(WORKFLOW_CODES).optional(),
  }),
) {}

export class CreateReasonDto extends createZodDto(
  z.object({
    code: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,39}$/, { message: 'Lower-case letters, digits and _, starting with a letter (2–40)' }),
    labels,
  }),
) {}

export class UpdateReasonDto extends createZodDto(
  z.object({
    labels: labels.optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(899, { message: 'Between 0 and 899' }).optional(),
  }),
) {}

// ── Phase B: criteria, interviews, evaluations, offers, hire ─────────────────────────────────────────────────────

const code = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, { message: 'Lower-case letters, digits and _, starting with a letter (2–40)' });

export class CreateCriterionDto extends createZodDto(z.object({ code, labels })) {}

export class UpdateCriterionDto extends createZodDto(
  z.object({ labels: labels.optional(), active: z.boolean().optional(), sortOrder: z.number().int().min(0).max(9999, { message: 'Between 0 and 9999' }).optional() }),
) {}

/** 1–8 criteria, in order. */
export class OpeningCriteriaDto extends createZodDto(
  z.object({ criterionIds: z.array(uuid).min(1, { message: 'At least one criterion' }).max(OPENING_CRITERIA_MAX, { message: `At most ${OPENING_CRITERIA_MAX} criteria` }) }),
) {}

export class InterviewersQueryDto extends createZodDto(z.object({ q: z.string().trim().min(2, { message: 'At least 2 characters' }).max(100) })) {}

const clockTime = z.string().refine(isClockTime, { message: 'Must be a time written HH:MM', params: { code: 'invalid_time' } });
const duration = z.number().int().min(15, { message: 'Between 15 and 480 minutes' }).max(480, { message: 'Between 15 and 480 minutes' });
const interviewerIds = z.array(uuid).min(1, { message: 'At least one interviewer' }).max(INTERVIEWERS_MAX, { message: `At most ${INTERVIEWERS_MAX} interviewers` });

/** Algiers local date and time; a past date is allowed (an interview already held). */
export class ScheduleInterviewDto extends createZodDto(
  z.object({
    date: isoDate,
    time: clockTime,
    durationMinutes: duration.optional(),
    mode: z.enum(INTERVIEW_MODES),
    location: optionalText(200).optional(),
    label: optionalText(120).optional(),
    interviewerIds,
  }),
) {}

export class UpdateInterviewDto extends createZodDto(
  z.object({
    date: isoDate.optional(),
    time: clockTime.optional(),
    durationMinutes: duration.optional(),
    mode: z.enum(INTERVIEW_MODES).optional(),
    location: optionalText(200).optional(),
    label: optionalText(120).optional(),
    interviewerIds: interviewerIds.optional(),
  }),
) {}

export class CancelInterviewDto extends createZodDto(z.object({ reason: text(3, 500) })) {}

export class MyInterviewsQueryDto extends createZodDto(z.object({ filter: z.enum(['todo', 'done']).default('todo') })) {}

/** Whole scores 1–5; the use case checks they cover every criterion of the opening. */
export class EvaluationDto extends createZodDto(
  z.object({
    scores: z.array(z.object({ criterionId: uuid, score: z.number().int().min(1, { message: 'Between 1 and 5' }).max(5, { message: 'Between 1 and 5' }) })).max(OPENING_CRITERIA_MAX),
    recommendation: z.enum(RECOMMENDATIONS),
    comment: optionalText(4000).optional(),
  }),
) {}

const offerFields = {
  jobTitle: text(1, 120),
  orgUnitId: uuid,
  siteId: uuid.nullable().optional(),
  contractType: z.enum(CONTRACT_TYPES),
  startDate: isoDate,
  note: optionalText(1000).optional(),
  proposedSalary: money.nullable().optional(),
};

export class MakeOfferDto extends createZodDto(z.object({ expectedStage: stage, ...offerFields })) {}

/** What is sent replaces the offer's value (a full body works as well as a partial one); `expectedStage` is ignored. */
export class UpdateOfferDto extends createZodDto(
  z.object({
    expectedStage: stage.optional(),
    jobTitle: offerFields.jobTitle.optional(),
    orgUnitId: uuid.optional(),
    siteId: offerFields.siteId,
    contractType: offerFields.contractType.optional(),
    startDate: isoDate.optional(),
    note: offerFields.note,
    proposedSalary: offerFields.proposedSalary,
  }),
) {}

export class EndOfferDto extends createZodDto(z.object({ expectedStage: stage, comment: comment(1000) })) {}

/** The body of POST /employees (the Employment module's own shape and rule) + the stage on screen + the files to copy. */
export class HireDto extends createZodDto(
  z
    .object({
      ...createEmployeeShape,
      expectedStage: stage,
      copyFileIds: z.array(uuid).max(COPY_FILES_MAX, { message: `At most ${COPY_FILES_MAX} files` }).default([]),
    })
    .superRefine(refineCreateEmployee),
) {}

export class UndoHireDto extends createZodDto(z.object({ reason: text(3, 500) })) {}
