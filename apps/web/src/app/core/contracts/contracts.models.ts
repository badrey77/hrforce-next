/**
 * Employment contract types — copied from `docs/contracts/contracts-deadlines.md` › Contracts. Keep names and unions
 * exactly as written there. The deadlines and contract-decision screens import the contract types from here.
 */

export const CONTRACT_TYPES = ['cdi', 'cdd', 'pre_emploi', 'apprentissage', 'stage'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_KINDS = ['initial', 'renewal', 'conversion', 'amendment'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];
/** The kinds a user adds after the initial contract (the initial one comes with the employment). */
export const NEW_CONTRACT_KINDS: readonly Exclude<ContractKind, 'initial'>[] = ['renewal', 'conversion', 'amendment'];

/** Every type but `cdi` is fixed-term: an end date is required (assumption 1). */
export function isFixedTerm(type: ContractType | '' | null | undefined): boolean {
  return !!type && type !== 'cdi';
}

/** Probation ends at most this many months after the contract start (Law 90-11 art. 18, assumption 3). */
export const PROBATION_MAX_MONTHS = 12;
export const CONTRACT_REFERENCE_MAX = 40;
export const CONTRACT_REASON_MAX = 300;
export const CONTRACT_NOTE_MAX = 500;

export interface UserRef {
  readonly id: string;
  readonly displayName: string;
}

export interface ContractView {
  readonly id: string;
  readonly seq: number;
  readonly kind: ContractKind;
  readonly contractType: ContractType;
  readonly startDate: string;
  /** Last day (inclusive); `null` for a CDI. */
  readonly endDate: string | null;
  /** Last day of probation. */
  readonly probationEnd: string | null;
  readonly reference: string | null;
  readonly reason: string | null;
  readonly note: string | null;
  /** The contract decision that created this contract. */
  readonly decision: { readonly id: string } | null;
  /**
   * A pending decision about this contract (unit head → HR). Not in the contract's `ContractView`: read when the API
   * sends it, absent otherwise.
   */
  readonly pendingDecision?: { readonly id: string; readonly status: string } | null;
  readonly createdAt: string;
  readonly createdBy: UserRef | null;
  readonly current: boolean;
  readonly _actions: readonly 'edit'[];
}

/** `GET /employees/:id/contracts`. */
export interface ContractList {
  /** Newest first. */
  readonly items: readonly ContractView[];
  readonly currentId: string | null;
}

/** The current contract as the employee list and detail carry it. */
export interface ContractSummary {
  readonly type: ContractType;
  readonly endDate: string | null;
  readonly probationEnd: string | null;
}

/** `POST /employees/:id/contracts`. */
export interface NewContract {
  /** `initial` only for an employment without any contract (it starts on the hire date). */
  readonly kind: ContractKind;
  readonly contractType: ContractType;
  readonly startDate: string;
  readonly endDate?: string;
  readonly probationEnd?: string;
  readonly reference?: string;
  readonly reason?: string;
  readonly note?: string;
}

/** `PATCH /employees/:id/contracts/:contractId` — corrections of the latest contract (`null` clears). */
export interface ContractCorrection {
  readonly endDate?: string | null;
  readonly probationEnd?: string | null;
  readonly reference?: string | null;
  readonly reason?: string | null;
  readonly note?: string | null;
}

/** The `contract` block of `POST /employees` (the `initial` contract, starting on the hire date). */
export interface InitialContract {
  readonly contractType: ContractType;
  readonly endDate?: string;
  readonly probationEnd?: string;
  readonly reference?: string;
  readonly reason?: string;
}

/** `contract.*` problem slugs of the contract. */
export type ContractProblemSlug =
  | 'contract-overlap'
  | 'contract-not-latest'
  | 'contract-decision-pending'
  | 'contract-not-fixed-term'
  | 'employment-ended';

export function contractActions(contract: Pick<ContractView, '_actions'>): readonly 'edit'[] {
  // oxlint-disable-next-line no-underscore-dangle -- contract field name
  return contract._actions ?? [];
}
