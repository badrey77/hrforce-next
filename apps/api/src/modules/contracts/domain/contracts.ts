/**
 * Employment contracts — rules (docs/contracts/contracts-deadlines.md › Contracts). Pure: no Nest, no Kysely.
 * Dates are ISO `YYYY-MM-DD`; a contract's `endDate` and `probationEnd` are LAST days (inclusive).
 */

export const CONTRACT_TYPES = ['cdi', 'cdd', 'pre_emploi', 'apprentissage', 'stage'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_KINDS = ['initial', 'renewal', 'conversion', 'amendment'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

/** The kinds a user adds after the initial contract (POST /employees/:id/contracts). */
export const LATER_KINDS = ['renewal', 'conversion', 'amendment'] as const;
export type LaterKind = (typeof LATER_KINDS)[number];

export const PROPOSALS = ['renew', 'convert_cdi', 'end'] as const;
export type Proposal = (typeof PROPOSALS)[number];

export const CONTRACT_REFERENCE_MAX = 40;
export const CONTRACT_REASON_MAX = 300;
export const CONTRACT_NOTE_MAX = 500;
export const DECISION_COMMENT_MAX = 500;
/** Probation ends at most 12 months after the contract starts (Law 90-11 art. 18 — assumption 3). */
export const PROBATION_MAX_MONTHS = 12;

export const CONTRACT_PERMISSIONS = { manage: 'employee.contract.manage', read: 'employee.read' } as const;
export const DECISION_WORKFLOW_CODE = 'contract.decision';

export function isFixedTerm(type: ContractType): boolean {
  return type !== 'cdi';
}

/** A contract rule that fails: 409 (or 422 on a field) problem with this slug / code. */
export class ContractRuleViolation extends Error {
  constructor(
    readonly slug: string,
    message: string,
    readonly status: 409 | 422 = 409,
    readonly field?: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function invalid(field: string, code: string, message: string): ContractRuleViolation {
  return new ContractRuleViolation('validation-error', message, 422, field, code);
}

// ── dates ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function parse(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function addDays(iso: string, days: number): string {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `iso` + `months` months (day clamped to the target month's length: 31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const d = parse(iso);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

export function addYears(iso: string, years: number): string {
  return addMonths(iso, years * 12);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}

// ── contracts ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ContractFacts {
  id: string;
  seq: number;
  kind: ContractKind;
  contractType: ContractType;
  startDate: string;
  endDate: string | null;
  probationEnd: string | null;
}

export interface EmploymentFacts {
  hireDate: string;
  /** inclusive last day; null = open */
  endDate: string | null;
}

export interface ContractTerms {
  contractType: ContractType;
  startDate: string;
  endDate: string | null;
  probationEnd: string | null;
}

/** Oldest first. */
export function bySeq<C extends Pick<ContractFacts, 'seq'>>(contracts: readonly C[]): C[] {
  return [...contracts].toSorted((a, b) => a.seq - b.seq);
}

/** The contract covering `date`, or null. */
export function currentOf<C extends Pick<ContractFacts, 'startDate' | 'endDate'>>(contracts: readonly C[], date: string): C | null {
  return contracts.find((c) => c.startDate <= date && (c.endDate === null || date <= c.endDate)) ?? null;
}

/** The contract with the highest seq (the only one that can be corrected or followed). */
export function latestOf<C extends Pick<ContractFacts, 'seq'>>(contracts: readonly C[]): C | null {
  return bySeq(contracts).at(-1) ?? null;
}

/** Field rules shared by every write: end date by type, probation range (422 on the field). */
export function checkTerms(terms: ContractTerms, prefix = ''): void {
  const f = (name: string) => `${prefix}${name}`;
  if (isFixedTerm(terms.contractType) && terms.endDate === null) {
    throw invalid(f('endDate'), 'required', 'A fixed-term contract needs an end date.');
  }
  if (!isFixedTerm(terms.contractType) && terms.endDate !== null) {
    throw invalid(f('endDate'), 'not_allowed', 'A CDI has no end date.');
  }
  if (terms.endDate !== null && terms.endDate < terms.startDate) {
    throw invalid(f('endDate'), 'before_start', 'The end date is before the start date.');
  }
  if (terms.probationEnd !== null) {
    const max = addDays(addMonths(terms.startDate, PROBATION_MAX_MONTHS), -1);
    if (terms.probationEnd < terms.startDate || terms.probationEnd > max || (terms.endDate !== null && terms.probationEnd > terms.endDate)) {
      throw invalid(f('probationEnd'), 'out_of_range', `The probation ends between the start date and ${PROBATION_MAX_MONTHS} months later (within the contract).`);
    }
  }
}

/** Writes on an employment whose end date has passed are refused; a contract starting after the end neither. */
export function checkEmployment(employment: EmploymentFacts, startDate: string, today: string, prefix = ''): void {
  if (employment.endDate !== null && employment.endDate < today) {
    throw new ContractRuleViolation('employment-ended', 'This employment has ended: its contracts can no longer change.');
  }
  if (employment.endDate !== null && startDate > employment.endDate) {
    throw invalid(`${prefix}startDate`, 'after_employment_end', 'The contract would start after the end of the employment.');
  }
}

/** The initial contract starts on the hire date and is the first one. */
export function planInitial(existing: readonly ContractFacts[], employment: EmploymentFacts, terms: ContractTerms, today: string, prefix = ''): { seq: 1 } {
  if (existing.length > 0) throw new ContractRuleViolation('contract-initial-exists', 'This employment already has its initial contract.');
  if (terms.startDate !== employment.hireDate) {
    throw invalid(`${prefix}startDate`, 'must_equal_hire_date', 'The initial contract starts on the hire date.');
  }
  checkTerms(terms, prefix);
  checkEmployment(employment, terms.startDate, today, prefix);
  return { seq: 1 };
}

export interface LaterPlan {
  seq: number;
  /** amendment: the previous contract is cut to end the day before the new one */
  shortenPrevious: { id: string; endDate: string } | null;
}

/**
 * A renewal (same type, starting the day after the previous end), a conversion (any type, starting after the previous
 * start — the previous one is cut when it would overlap) or an amendment (new terms from a date after the previous
 * start; the previous contract is cut to end the day before).
 */
export function planLater(existing: readonly ContractFacts[], employment: EmploymentFacts, kind: LaterKind, terms: ContractTerms, today: string): LaterPlan {
  const previous = latestOf(existing);
  if (!previous) throw new ContractRuleViolation('contract-initial-missing', 'Record the initial contract first.');
  checkTerms(terms);
  checkEmployment(employment, terms.startDate, today);
  if (kind === 'renewal') {
    if (previous.endDate === null) throw new ContractRuleViolation('contract-not-fixed-term', 'Only a fixed-term contract can be renewed.');
    if (terms.contractType !== previous.contractType) {
      throw invalid('contractType', 'must_match_previous', 'A renewal keeps the type of the contract it renews.');
    }
    if (terms.startDate !== addDays(previous.endDate, 1)) {
      throw invalid('startDate', 'must_follow_previous', 'A renewal starts the day after the previous contract ends.');
    }
    return { seq: previous.seq + 1, shortenPrevious: null };
  }
  if (terms.startDate <= previous.startDate) {
    throw invalid('startDate', 'must_follow_previous', 'The new contract starts after the start of the previous one.');
  }
  const dayBefore = addDays(terms.startDate, -1);
  const overlaps = previous.endDate === null || previous.endDate > dayBefore;
  return { seq: previous.seq + 1, shortenPrevious: overlaps ? { id: previous.id, endDate: dayBefore } : null };
}

/**
 * A correction of the latest contract (reference, reason, note, probation end, end date). Shortening the end below a
 * later start is impossible (no later contract exists by construction); the end date follows the type rule.
 */
export function planCorrection(existing: readonly ContractFacts[], contractId: string, patch: { endDate?: string | null; probationEnd?: string | null }, employment: EmploymentFacts, today: string): ContractTerms {
  const latest = latestOf(existing);
  const target = existing.find((c) => c.id === contractId);
  if (!target) throw new ContractRuleViolation('not-found', 'Contract not found', 409);
  if (!latest || latest.id !== contractId) {
    throw new ContractRuleViolation('contract-not-latest', 'Only the latest contract can be corrected; record a new contract instead.');
  }
  const terms: ContractTerms = {
    contractType: target.contractType,
    startDate: target.startDate,
    endDate: patch.endDate !== undefined ? patch.endDate : target.endDate,
    probationEnd: patch.probationEnd !== undefined ? patch.probationEnd : target.probationEnd,
  };
  checkTerms(terms);
  if (employment.endDate !== null && employment.endDate < today) {
    throw new ContractRuleViolation('employment-ended', 'This employment has ended: its contracts can no longer change.');
  }
  return terms;
}

// ── decisions ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ProposalInput {
  proposal: Proposal;
  proposedStartDate?: string | null | undefined;
  proposedEndDate?: string | null | undefined;
}

/** The normalised proposal: start defaults to the day after the contract end; renew needs an end after the start. */
export function planProposal(contract: Pick<ContractFacts, 'endDate' | 'contractType'>, input: ProposalInput): { proposal: Proposal; startDate: string | null; endDate: string | null } {
  if (contract.endDate === null) throw new ContractRuleViolation('contract-not-fixed-term', 'Only a fixed-term contract has an end-of-contract decision.');
  const defaultStart = addDays(contract.endDate, 1);
  if (input.proposal === 'end') {
    if (input.proposedEndDate) throw invalid('proposedEndDate', 'not_allowed', 'Ending the contract takes no new end date.');
    return { proposal: 'end', startDate: null, endDate: null };
  }
  const startDate = input.proposedStartDate ?? defaultStart;
  if (startDate <= contract.endDate && input.proposal === 'renew') {
    throw invalid('proposedStartDate', 'must_follow_previous', 'A renewal starts the day after the contract ends.');
  }
  if (input.proposal === 'renew') {
    if (startDate !== defaultStart) throw invalid('proposedStartDate', 'must_follow_previous', 'A renewal starts the day after the contract ends.');
    if (!input.proposedEndDate) throw invalid('proposedEndDate', 'required', 'A renewal needs its new end date.');
    if (input.proposedEndDate < startDate) throw invalid('proposedEndDate', 'before_start', 'The new end date is before the start of the renewal.');
    return { proposal: 'renew', startDate, endDate: input.proposedEndDate };
  }
  if (input.proposedEndDate) throw invalid('proposedEndDate', 'not_allowed', 'A CDI has no end date.');
  return { proposal: 'convert_cdi', startDate, endDate: null };
}

/**
 * The fixed-term contracts whose end-of-contract decision opens today: the latest contract of an open employment, fixed
 * term, ending within `noticeDays` from `today` (not yet passed), with no pending or approved decision.
 */
export function decisionDue(contract: Pick<ContractFacts, 'endDate' | 'contractType'>, isLatest: boolean, employment: EmploymentFacts, today: string, noticeDays: number, hasDecision: boolean): boolean {
  if (noticeDays <= 0 || !isLatest || hasDecision || contract.endDate === null) return false;
  if (employment.endDate !== null && employment.endDate <= contract.endDate) return false;
  return contract.endDate >= today && daysBetween(today, contract.endDate) <= noticeDays;
}
