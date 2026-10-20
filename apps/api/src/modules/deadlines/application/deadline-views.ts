/** Response shapes of docs/contracts/contracts-deadlines.md › Deadlines (the API layer returns them as-is). */
import type { ContractType, DeadlineKind, DeadlinePolicy, DeadlineSeverity, DeadlineStatus } from '../domain/types.js';

export interface NamePairView {
  id: string;
  lastName: string;
  firstName: string;
  lastNameAr: string | null;
  firstNameAr: string | null;
}

export interface UnitRefView {
  id: string;
  code: string;
  kind: string;
  name: string;
  nameAr: string | null;
}

export interface UserRefView {
  id: string;
  displayName: string;
}

export interface DeadlineItem {
  /** `${kind}:${subjectId}:${dueDate}` */
  key: string;
  kind: DeadlineKind;
  dueDate: string;
  daysLeft: number;
  status: DeadlineStatus;
  severity: DeadlineSeverity;
  employee: { id: string; matricule: string; person: NamePairView; unit: UnitRefView; jobTitle: string };
  contract: { id: string; contractType: ContractType; startDate: string; endDate: string | null } | null;
  file: { id: string; title: string; category: { code: string; names: { fr: string; ar: string; en: string } } } | null;
  /** contract_end: the pending or approved contract decision, if any */
  decision: { id: string; status: string } | null;
  ack: { id: string; note: string | null; at: string; by: UserRefView | null } | null;
  _actions: ('ack' | 'unack' | 'open_decision')[];
}

export interface DeadlinePage {
  items: DeadlineItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DeadlineSummary {
  overdue: number;
  critical: number;
  /** due (not yet overdue) within 30 days */
  next30: number;
  byKind: Record<DeadlineKind, { overdue: number; due: number }>;
}

export type DeadlinePolicyView = DeadlinePolicy;
