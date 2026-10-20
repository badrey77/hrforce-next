/**
 * The deadline computation (docs/contracts/contracts-deadlines.md › Deadlines): pure, from facts read at request
 * time and a pinned `today`. No stored deadline rows: an item is identified by kind + subject + due date, so a changed
 * date (a new contract, a corrected expiry) is a new item and an old acknowledgement no longer applies.
 */
import { addDays, addMonths, addYears, daysBetween } from './dates.js';
import { PROBATION_OVERDUE_DAYS, type ContractType, type DeadlineKind, type DeadlinePolicy, type DeadlineSeverity } from './types.js';

export interface ContractFact {
  id: string;
  contractType: ContractType;
  startDate: string;
  /** last day (inclusive); null = open-ended (cdi) */
  endDate: string | null;
  /** last day of probation */
  probationEnd: string | null;
}

export interface EmploymentFact {
  employmentId: string;
  hireDate: string;
  /** inclusive last day worked; null = open */
  endDate: string | null;
  birthDate: string | null;
  contracts: readonly ContractFact[];
}

export interface FileFact {
  id: string;
  employmentId: string;
  expiresOn: string;
}

export interface DeadlineCandidate {
  kind: DeadlineKind;
  /** contract id (probation_end, contract_end), employee-file id (document_expiry), employment id (retirement, contract_missing) */
  subjectId: string;
  employmentId: string;
  dueDate: string;
  /** dueDate − today (negative = past) */
  daysLeft: number;
  status: 'due' | 'overdue';
  severity: DeadlineSeverity;
  /** first day of the kind's notice window (the digest counts items entering it); the due date itself for contract_missing */
  windowStart: string;
  /** first overdue day (dueDate + 1) */
  overdueFrom: string;
  contractId: string | null;
  fileId: string | null;
}

export const deadlineKey = (kind: DeadlineKind, subjectId: string, dueDate: string) => `${kind}:${subjectId}:${dueDate}`;

const isOpenOn = (e: EmploymentFact, today: string) => e.endDate === null || e.endDate >= today;

/** The contract covering `date`, or undefined. */
export function contractOn(contracts: readonly ContractFact[], date: string): ContractFact | undefined {
  return contracts.find((c) => c.startDate <= date && (c.endDate === null || c.endDate >= date));
}

function sorted(contracts: readonly ContractFact[]): ContractFact[] {
  return [...contracts].toSorted((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
}

function candidate(
  kind: DeadlineKind,
  e: EmploymentFact,
  subjectId: string,
  dueDate: string,
  windowStart: string,
  today: string,
  refs: { contractId?: string; fileId?: string } = {},
): DeadlineCandidate {
  const daysLeft = daysBetween(today, dueDate);
  const overdue = kind === 'contract_missing' || daysLeft < 0;
  const severity: DeadlineSeverity = !overdue ? 'info' : kind === 'contract_end' ? 'critical' : 'warning';
  return {
    kind,
    subjectId,
    employmentId: e.employmentId,
    dueDate,
    daysLeft,
    status: overdue ? 'overdue' : 'due',
    severity,
    windowStart,
    overdueFrom: kind === 'contract_missing' ? dueDate : addDays(dueDate, 1),
    contractId: refs.contractId ?? null,
    fileId: refs.fileId ?? null,
  };
}

/**
 * The first day of `e`'s employment, up to today, that no contract covers — the due date of `contract_missing` —
 * or null when every day from the hire date to today is covered, or when the uncovered stretch is the one after a
 * fixed-term contract that ended (that is the critical `contract_end`, not a missing contract).
 */
export function firstUncoveredDay(e: EmploymentFact, today: string): string | null {
  if (e.hireDate > today) return null;
  const contracts = sorted(e.contracts);
  let day = e.hireDate;
  for (const c of contracts) {
    if (c.startDate > day) break;
    if (c.endDate === null) return null;
    if (c.endDate >= day) day = addDays(c.endDate, 1);
  }
  if (day > today) return null;
  const last = contracts.at(-1);
  // the gap right after the last (fixed-term) contract: reported as its overdue contract_end
  if (last?.endDate && addDays(last.endDate, 1) === day) return null;
  return day;
}

/**
 * Every deadline of the open employments on `today`, before acknowledgements and before the board's horizon. Items
 * after an employment's recorded end date are dropped; an overdue probation end is dropped after
 * {@link PROBATION_OVERDUE_DAYS} days.
 */
export function computeDeadlines(employments: readonly EmploymentFact[], files: readonly FileFact[], policy: DeadlinePolicy, today: string): DeadlineCandidate[] {
  const out: DeadlineCandidate[] = [];
  const open = new Map<string, EmploymentFact>();
  for (const e of employments) {
    if (!isOpenOn(e, today)) continue;
    open.set(e.employmentId, e);
    const beforeEnd = (date: string) => e.endDate === null || date <= e.endDate;
    const contracts = sorted(e.contracts);

    const current = contractOn(contracts, today);
    if (current?.probationEnd && beforeEnd(current.probationEnd) && daysBetween(current.probationEnd, today) <= PROBATION_OVERDUE_DAYS) {
      out.push(candidate('probation_end', e, current.id, current.probationEnd, addDays(current.probationEnd, -policy.probationNoticeDays), today, { contractId: current.id }));
    }

    // the last fixed-term contract, when nothing follows it and the employment is not recorded as ending with it
    const last = contracts.at(-1);
    if (last?.endDate && (e.endDate === null || e.endDate > last.endDate)) {
      out.push(candidate('contract_end', e, last.id, last.endDate, addDays(last.endDate, -policy.contractNoticeDays), today, { contractId: last.id }));
    }

    if (e.birthDate) {
      const due = addYears(e.birthDate, policy.retirementAge);
      if (beforeEnd(due)) out.push(candidate('retirement', e, e.employmentId, due, addMonths(due, -policy.retirementNoticeMonths), today));
    }

    const gap = firstUncoveredDay(e, today);
    if (gap) out.push(candidate('contract_missing', e, e.employmentId, gap, gap, today));
  }
  for (const f of files) {
    const e = open.get(f.employmentId);
    if (!e || (e.endDate !== null && f.expiresOn > e.endDate)) continue;
    out.push(candidate('document_expiry', e, f.id, f.expiresOn, addDays(f.expiresOn, -policy.documentNoticeDays), today, { fileId: f.id }));
  }
  return out;
}

/**
 * Is the item on the board for a horizon of `within` days? Overdue items always; a due item when its due date is at
 * most `within` days ahead, or when its notice window has started (a retirement six months ahead shows on the
 * default 90-day board).
 */
export function onBoard(c: DeadlineCandidate, today: string, within: number): boolean {
  return c.status === 'overdue' || c.daysLeft <= within || c.windowStart <= today;
}

/**
 * The digest's delta (contract › Worker): the items that entered their notice window or became overdue in
 * `(since, today]`. `since` is the previous run's date (the day before, for a daily cron).
 */
export function enteredSince(c: DeadlineCandidate, since: string, today: string): boolean {
  const inRange = (d: string) => d > since && d <= today;
  return inRange(c.windowStart) || (c.kind !== 'contract_missing' && inRange(c.overdueFrom));
}

const STATUS_ORDER = { overdue: 0, due: 1, handled: 2 } as const;

/** Board order: overdue first, then by due date, then kind, then subject (stable). */
export function compareCandidates(a: { status: 'due' | 'overdue' | 'handled'; dueDate: string; kind: string; subjectId: string }, b: typeof a): number {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) ||
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
    (a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0)
  );
}
