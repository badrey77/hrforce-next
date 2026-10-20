import type { WorkflowProgressView } from '../../workflow/index.js';
import type { ContractKind, ContractType, Proposal } from '../domain/contracts.js';

export interface UserRef {
  id: string;
  displayName: string;
}

export interface ContractView {
  id: string;
  seq: number;
  kind: ContractKind;
  contractType: ContractType;
  startDate: string;
  endDate: string | null;
  probationEnd: string | null;
  reference: string | null;
  reason: string | null;
  note: string | null;
  /** the decision that created this contract (renewal / conversion) */
  decision: { id: string } | null;
  /** the pending or approved end-of-contract decision ABOUT this contract, if any */
  pendingDecision: { id: string; status: 'pending' | 'approved' } | null;
  createdAt: string;
  createdBy: UserRef | null;
  current: boolean;
  _actions: 'edit'[];
}

export interface ContractListView {
  items: ContractView[];
  currentId: string | null;
}

/** The current contract of an employment, as the employee list and detail show it. */
export interface ContractSummary {
  type: ContractType;
  endDate: string | null;
  probationEnd: string | null;
}

export interface NamePair {
  lastName: string;
  firstName: string;
  lastNameAr: string | null;
  firstNameAr: string | null;
}

export interface UnitRef {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  kind: string;
}

export interface ContractDecisionView {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  employee: { id: string; matricule: string; person: NamePair; unit: UnitRef };
  contract: ContractView;
  proposal: Proposal | null;
  proposedStartDate: string | null;
  proposedEndDate: string | null;
  comment: string | null;
  proposedBy: UserRef | null;
  proposedAt: string | null;
  workflow: WorkflowProgressView | null;
  resultContractId: string | null;
  openedBy: 'system' | 'user';
  _actions: 'propose'[];
}
