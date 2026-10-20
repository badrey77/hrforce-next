/**
 * Deadlines and contract decisions (docs/contracts/contracts-deadlines.md › Deadlines, Contract decisions). Plain
 * TypeScript; field names follow the contract.
 */
import type { ContractType } from '../contracts/contracts.models';
import type { NamePair, UnitRef } from '../employees/employees.models';
import type { WorkflowProgress } from '../leave/leave.models';

export const DEADLINE_KINDS = ['contract_end', 'probation_end', 'contract_missing', 'document_expiry', 'retirement'] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

export type DeadlineStatus = 'due' | 'overdue' | 'handled';
export type DeadlineSeverity = 'critical' | 'warning' | 'info';

/** `status` filter of `GET /deadlines`: `open` = due + overdue (default). */
export const DEADLINE_STATUS_FILTERS = ['open', 'handled', 'all'] as const;
export type DeadlineStatusFilter = (typeof DEADLINE_STATUS_FILTERS)[number];

/** Days ahead the board looks (`within`; the API accepts up to 730). */
export const DEADLINE_WITHIN_OPTIONS = [30, 90, 180, 365, 730] as const;
export const DEADLINE_WITHIN_MAX = 730;
export const DEADLINE_PAGE_SIZES = [25, 50, 100] as const;

/** The board's "next 30 days" group. */
export const SOON_DAYS = 30;

/** The contract model belongs to the contracts screens (core/contracts); deadlines only name the type. */
export type DeadlineContractType = ContractType;

export interface DeadlineEmployee {
  readonly id: string;
  readonly matricule: string;
  readonly person: NamePair;
  readonly unit: UnitRef;
  readonly jobTitle: string;
}

export interface DeadlineItem {
  /** `${kind}:${subjectId}:${dueDate}` */
  readonly key: string;
  readonly kind: DeadlineKind;
  readonly dueDate: string;
  /** Negative once overdue. */
  readonly daysLeft: number;
  readonly status: DeadlineStatus;
  readonly severity: DeadlineSeverity;
  readonly employee: DeadlineEmployee;
  readonly contract: { readonly id: string; readonly contractType: DeadlineContractType; readonly startDate: string; readonly endDate: string | null } | null;
  readonly file: { readonly id: string; readonly title: string; readonly category: { readonly code: string; readonly names: { readonly fr: string; readonly ar: string; readonly en: string } } } | null;
  readonly decision: { readonly id: string; readonly status: string } | null;
  readonly ack: { readonly id: string; readonly note: string | null; readonly at: string; readonly by: { readonly id: string; readonly displayName: string } | null } | null;
  readonly _actions: readonly ('ack' | 'unack' | 'open_decision')[];
}

export interface DeadlinePage {
  readonly items: readonly DeadlineItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface DeadlineSummary {
  readonly overdue: number;
  readonly critical: number;
  readonly next30: number;
  readonly byKind: Readonly<Partial<Record<DeadlineKind, { readonly overdue: number; readonly due: number }>>>;
}

export interface DeadlineQuery {
  readonly q: string;
  readonly kind: DeadlineKind | null;
  readonly status: DeadlineStatusFilter;
  readonly unitId: string | null;
  readonly includeSubUnits: boolean;
  readonly within: number;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_DEADLINE_QUERY: DeadlineQuery = {
  q: '',
  kind: null,
  status: 'open',
  unitId: null,
  includeSubUnits: true,
  within: 90,
  page: 1,
  pageSize: 50,
};

export interface NewDeadlineAck {
  readonly kind: DeadlineKind;
  readonly subjectId: string;
  readonly dueDate: string;
  readonly note?: string;
}

export const ACK_NOTE_MAX = 300;

/** The subject id an ack names: the contract, the employee-file document, or the employment. */
export function ackSubjectId(item: DeadlineItem): string {
  if (item.kind === 'document_expiry') return item.file?.id ?? item.employee.id;
  if (item.kind === 'probation_end' || item.kind === 'contract_end') return item.contract?.id ?? item.employee.id;
  return item.employee.id;
}

export type DeadlineGroup = 'overdue' | 'soon' | 'later' | 'handled';
export const DEADLINE_GROUPS: readonly DeadlineGroup[] = ['overdue', 'soon', 'later', 'handled'];

export function groupOf(item: DeadlineItem): DeadlineGroup {
  if (item.status === 'handled') return 'handled';
  if (item.status === 'overdue') return 'overdue';
  return item.daysLeft <= SOON_DAYS ? 'soon' : 'later';
}

/** The page's items by board group, in the API's order inside each group; empty groups left out. */
export function groupItems(items: readonly DeadlineItem[]): { readonly group: DeadlineGroup; readonly items: readonly DeadlineItem[] }[] {
  return DEADLINE_GROUPS.map((group) => ({ group, items: items.filter((item) => groupOf(item) === group) })).filter((g) => g.items.length > 0);
}

// --- Policy -------------------------------------------------------------------------------------------------------

export interface DeadlinePolicyView {
  readonly probationNoticeDays: number;
  readonly contractNoticeDays: number;
  readonly decisionNoticeDays: number;
  readonly documentNoticeDays: number;
  readonly retirementAge: number;
  readonly retirementNoticeMonths: number;
  readonly digestEnabled: boolean;
}

/** The API's bounds (contract › Data › deadline_policy). */
export const POLICY_BOUNDS = {
  probationNoticeDays: { min: 1, max: 90 },
  contractNoticeDays: { min: 1, max: 180 },
  decisionNoticeDays: { min: 0, max: 180 },
  documentNoticeDays: { min: 1, max: 180 },
  retirementAge: { min: 50, max: 70 },
  retirementNoticeMonths: { min: 1, max: 24 },
} as const;
export type PolicyNumberField = keyof typeof POLICY_BOUNDS;
export const POLICY_NUMBER_FIELDS = Object.keys(POLICY_BOUNDS) as PolicyNumberField[];

export const DEFAULT_DEADLINE_POLICY: DeadlinePolicyView = {
  probationNoticeDays: 15,
  contractNoticeDays: 30,
  decisionNoticeDays: 45,
  documentNoticeDays: 30,
  retirementAge: 60,
  retirementNoticeMonths: 6,
  digestEnabled: true,
};

// --- Contract decisions -------------------------------------------------------------------------------------------

export const DECISION_PROPOSALS = ['renew', 'convert_cdi', 'end'] as const;
export type DecisionProposal = (typeof DECISION_PROPOSALS)[number];
export type DecisionStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface DecisionContract {
  readonly id?: string;
  readonly contractType: DeadlineContractType;
  readonly startDate: string;
  readonly endDate: string | null;
}

export interface ProposalBody {
  readonly proposal: DecisionProposal;
  readonly proposedEndDate?: string;
  readonly proposedStartDate?: string;
  readonly comment?: string;
}

export const DECISION_COMMENT_MAX = 500;

export interface ContractDecisionView {
  readonly id: string;
  readonly status: DecisionStatus;
  readonly employee: { readonly id: string; readonly matricule: string; readonly person: NamePair; readonly unit: UnitRef };
  readonly contract: DecisionContract;
  readonly proposal: DecisionProposal | null;
  readonly proposedStartDate: string | null;
  readonly proposedEndDate: string | null;
  readonly comment: string | null;
  readonly proposedBy: { readonly id: string; readonly displayName: string } | null;
  readonly proposedAt: string | null;
  readonly workflow: WorkflowProgress & { readonly instanceId: string };
  readonly resultContractId: string | null;
  readonly openedBy: 'system' | 'user';
  readonly _actions: readonly 'propose'[];
}

/** `YYYY-MM-DD` + `days` (calendar), in UTC so no time zone shifts the date. */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
