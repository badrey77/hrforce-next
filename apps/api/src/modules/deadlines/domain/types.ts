/**
 * Deadlines — reference data (docs/contracts/contracts-deadlines.md › Deadlines). Pure: no Nest, no Kysely.
 */

export const DEADLINE_KINDS = ['probation_end', 'contract_end', 'document_expiry', 'retirement', 'contract_missing'] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

export function isDeadlineKind(value: unknown): value is DeadlineKind {
  return typeof value === 'string' && (DEADLINE_KINDS as readonly string[]).includes(value);
}

export type DeadlineStatus = 'due' | 'overdue' | 'handled';
export type DeadlineSeverity = 'critical' | 'warning' | 'info';

export const DEADLINE_PERMISSIONS = {
  read: 'deadline.read',
  handle: 'deadline.handle',
  configure: 'deadline.configure',
} as const;

/** The fixed-term contract types (contract › assumption 1): every type but `cdi` needs an end date. */
export const CONTRACT_TYPES = ['cdi', 'cdd', 'pre_emploi', 'apprentissage', 'stage'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export interface DeadlinePolicy {
  probationNoticeDays: number;
  contractNoticeDays: number;
  /** 0 = no automatic contract-decision task */
  decisionNoticeDays: number;
  documentNoticeDays: number;
  retirementAge: number;
  retirementNoticeMonths: number;
  digestEnabled: boolean;
}

/** A company without a `deadline_policy` row uses these (contract › Data). */
export const DEFAULT_DEADLINE_POLICY: Readonly<DeadlinePolicy> = Object.freeze({
  probationNoticeDays: 15,
  contractNoticeDays: 30,
  decisionNoticeDays: 45,
  documentNoticeDays: 30,
  retirementAge: 60,
  retirementNoticeMonths: 6,
  digestEnabled: true,
});

/** Inclusive ranges of the numeric policy fields (contract › Data; the migration's checks are the backstop). */
export const POLICY_RANGES: Readonly<Record<Exclude<keyof DeadlinePolicy, 'digestEnabled'>, readonly [number, number]>> = {
  probationNoticeDays: [1, 90],
  contractNoticeDays: [1, 180],
  decisionNoticeDays: [0, 180],
  documentNoticeDays: [1, 180],
  retirementAge: [50, 70],
  retirementNoticeMonths: [1, 24],
};

/** An overdue probation end stays listed this many days, then it is hidden (contract › Deadlines). */
export const PROBATION_OVERDUE_DAYS = 30;

/** The board's `within` (days ahead): default and maximum (contract › Deadlines › GET /deadlines). */
export const DEFAULT_WITHIN_DAYS = 90;
export const MAX_WITHIN_DAYS = 730;

/** A deadline rule that fails: problem slug + status. */
export class DeadlineRuleViolation extends Error {
  constructor(
    readonly slug: string,
    message: string,
    readonly status: 404 | 409 | 422 = 409,
    readonly errors?: { field: string; code: string; message: string }[],
  ) {
    super(message);
  }
}
