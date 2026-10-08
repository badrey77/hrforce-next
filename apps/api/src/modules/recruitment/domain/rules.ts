/**
 * Recruitment (docs/contracts/recruitment.md) — pure rules: the fixed lists, the stage machine, the reference of an
 * opening, the phone key of the duplicate check, the retention date. No Nest, no Kysely.
 */

export const RECRUITMENT_PERMISSIONS = {
  read: 'recruitment.read',
  manage: 'recruitment.manage',
  approveOpening: 'recruitment.approve_opening',
  hire: 'recruitment.hire',
  erase: 'recruitment.erase',
  configure: 'recruitment.configure',
  salaryRead: 'recruitment.salary.read',
  salaryUpdate: 'recruitment.salary.update',
} as const;

export const OPENING_STATUSES = ['pending', 'open', 'filled', 'closed', 'rejected', 'cancelled'] as const;
export type OpeningStatus = (typeof OPENING_STATUSES)[number];

/** Assumption 4: a fixed list (recruitment_opening_contract_ck). */
export const CONTRACT_TYPES = ['cdi', 'cdd', 'pre_emploi', 'apprentissage', 'stage'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

/** Assumption 6: fixed, in pipeline order (the board's columns). */
export const STAGES = ['received', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'] as const;
export type Stage = (typeof STAGES)[number];

export const ACTIVE_STAGES = ['received', 'shortlisted', 'interview', 'offer'] as const satisfies readonly Stage[];
export type ActiveStage = (typeof ACTIVE_STAGES)[number];
export const FINAL_STAGES = ['hired', 'rejected', 'withdrawn'] as const satisfies readonly Stage[];

export const SOURCES = ['anem', 'spontaneous', 'referral', 'job_board', 'social', 'internal', 'other'] as const;
export type Source = (typeof SOURCES)[number];

export const FILE_KINDS = ['cv', 'cover_letter', 'diploma', 'id_document', 'other'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const WORKFLOW_CODES = ['recruitment.manager_then_hr', 'recruitment.hr_only'] as const;
export type OpeningWorkflowCode = (typeof WORKFLOW_CODES)[number];

export type AutoCause = 'opening_filled' | 'opening_closed' | 'hire_undone' | 'opening_reopened';

/** Policy defaults: a missing recruitment_policy row means these. */
export const DEFAULT_RETENTION_MONTHS = 12;
export const DEFAULT_WORKFLOW_CODE: OpeningWorkflowCode = 'recruitment.manager_then_hr';
export const RETENTION_MONTHS_MIN = 1;
export const RETENTION_MONTHS_MAX = 60;

/** At most this many files per candidate (409 recruitment-file-limit). */
export const MAX_FILES_PER_CANDIDATE = 20;
/** A board holds at most this many unpurged applications (422 `too_many`). */
export const BOARD_MAX_APPLICATIONS = 1000;
/** GET /me/recruitment/openings returns at most this many openings. */
export const MY_OPENINGS_MAX = 200;

/** The system reasons of an automatic closing (recruitment_rejection_reason.auto_only). */
export const AUTO_REASON = { opening_closed: 'opening_closed', opening_filled: 'position_filled' } as const;

export function isActiveStage(stage: string): stage is ActiveStage {
  return (ACTIVE_STAGES as readonly string[]).includes(stage);
}

export function isFinalStage(stage: string): boolean {
  return (FINAL_STAGES as readonly string[]).includes(stage);
}

/** The stages `POST …/move` handles between themselves, in any direction (the offer has its own endpoints, Phase B). */
const FREE_STAGES: readonly Stage[] = ['received', 'shortlisted', 'interview'];

/**
 * What `POST …/move` accepts from `stage` (contract › Stage rules): between received / shortlisted / interview in any
 * direction, and from any active stage to `rejected` or `withdrawn` (an application in `offer` is withdrawn through
 * the offer endpoints: only `rejected` here). Nothing from a final stage (reopen is its own endpoint).
 */
export function moveTargets(stage: Stage): Stage[] {
  if (stage === 'offer') return ['rejected'];
  if (!FREE_STAGES.includes(stage)) return [];
  return [...FREE_STAGES.filter((s) => s !== stage), 'rejected', 'withdrawn'];
}

/**
 * The stage a reopened (or automatically restored) application lands in: the `from_stage` of the transition that
 * closed it — `interview` when that was `offer` (the offer stays cancelled), `received` when unknown.
 */
export function restoredStage(fromStage: string | null): ActiveStage {
  if (fromStage === 'offer') return 'interview';
  return fromStage !== null && isActiveStage(fromStage) ? fromStage : 'received';
}

/** REC-{YYYY}-{SEQ:4}. */
export function openingReference(year: number, seq: number): string {
  return `REC-${year}-${String(seq).padStart(4, '0')}`;
}

const ALGIERS_OFFSET_MS = 3_600_000;

/** The calendar date in Africa/Algiers (UTC+1, no daylight saving) of an instant. */
export function algiersDate(ms: number): string {
  return new Date(ms + ALGIERS_OFFSET_MS).toISOString().slice(0, 10);
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

/** ISO date + whole months (31 Jan + 1 month → 28/29 Feb). */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/**
 * Retention (contract › Retention, erasure and worker): an application is due when the Algiers date of its decision
 * plus the policy's months is BEFORE today.
 */
export function isPurgeDue(decidedOn: string, retentionMonths: number, today: string): boolean {
  return addMonths(decidedOn, retentionMonths) < today;
}

/**
 * The duplicate key of a phone number: its digits without a leading `00213`, `213` or `0` — so `0555 12 34 56`,
 * `+213 555 12 34 56` and `00213555123456` are one number. null when the text holds no digit.
 */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  const key = digits.replace(/^(00213|213|0)/, '');
  return key === '' ? (digits === '' ? null : digits) : key;
}

/** A positive amount written like 85000 or 85000.00 (at most 10 digits before the point). */
export function isPositiveMoney(value: string): boolean {
  return /^\d{1,10}(\.\d{1,2})?$/.test(value) && Number(value) > 0;
}

/** `%q%` with LIKE wildcards escaped (the search columns are normalised by search_normalize()). */
export function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
