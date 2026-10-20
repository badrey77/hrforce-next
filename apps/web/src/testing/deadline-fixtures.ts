import type { DeadlineItem, DeadlinePage, DeadlinePolicyView, DeadlineSummary } from '../app/core/deadlines/deadlines.models';
import type { OpenTask } from '../app/core/tasks/tasks.models';

const EMPLOYEE = {
  id: 'emp-27',
  matricule: 'EMP-0027',
  person: { lastName: 'Benali', firstName: 'Amine', lastNameAr: 'بن علي', firstNameAr: 'أمين' },
  unit: { id: 'u-annaba', code: 'AG-ANNABA', name: 'Agence Annaba', nameAr: 'وكالة عنابة', kind: 'agency' },
  jobTitle: 'Chargé de clientèle',
};

/** A CDD that ended 3 days ago, the person still employed: critical. */
export const CRITICAL_ITEM: DeadlineItem = {
  key: 'contract_end:c-1:2026-10-16',
  kind: 'contract_end',
  dueDate: '2026-10-16',
  daysLeft: -3,
  status: 'overdue',
  severity: 'critical',
  employee: EMPLOYEE,
  contract: { id: 'c-1', contractType: 'cdd', startDate: '2025-10-17', endDate: '2026-10-16' },
  file: null,
  decision: null,
  ack: null,
  _actions: ['ack', 'open_decision'],
};

/** A probation ending in 10 days. */
export const PROBATION_ITEM: DeadlineItem = {
  key: 'probation_end:c-2:2026-10-29',
  kind: 'probation_end',
  dueDate: '2026-10-29',
  daysLeft: 10,
  status: 'due',
  severity: 'info',
  employee: { ...EMPLOYEE, id: 'emp-28', matricule: 'EMP-0028' },
  contract: { id: 'c-2', contractType: 'cdi', startDate: '2026-04-29', endDate: null },
  file: null,
  decision: null,
  ack: null,
  _actions: ['ack'],
};

/** A document expiring in 45 days (the « later » group). */
export const DOCUMENT_ITEM: DeadlineItem = {
  key: 'document_expiry:f-1:2026-12-03',
  kind: 'document_expiry',
  dueDate: '2026-12-03',
  daysLeft: 45,
  status: 'due',
  severity: 'info',
  employee: { ...EMPLOYEE, id: 'emp-29', matricule: 'EMP-0029' },
  contract: null,
  file: { id: 'f-1', title: 'Permis de conduire', category: { code: 'identity', names: { fr: 'Identité', ar: 'الهوية', en: 'Identity' } } },
  decision: null,
  ack: null,
  _actions: ['ack'],
};

/** Already handled (listed with status=handled). */
export const HANDLED_ITEM: DeadlineItem = {
  ...PROBATION_ITEM,
  key: 'probation_end:c-3:2026-10-25',
  dueDate: '2026-10-25',
  daysLeft: 6,
  status: 'handled',
  contract: { id: 'c-3', contractType: 'cdi', startDate: '2026-04-25', endDate: null },
  ack: { id: 'ack-1', note: 'Période d’essai confirmée', at: '2026-10-18T09:00:00Z', by: { id: 'u-amina', displayName: 'Amina Benali' } },
  _actions: ['unack'],
};

export function deadlinePage(items: readonly DeadlineItem[] = [CRITICAL_ITEM, PROBATION_ITEM, DOCUMENT_ITEM]): DeadlinePage {
  return { items, total: items.length, page: 1, pageSize: 50 };
}

export const SUMMARY: DeadlineSummary = {
  overdue: 4,
  critical: 1,
  next30: 7,
  byKind: { contract_end: { overdue: 1, due: 2 } },
};

export const POLICY: DeadlinePolicyView = {
  probationNoticeDays: 15,
  contractNoticeDays: 30,
  decisionNoticeDays: 45,
  documentNoticeDays: 30,
  retirementAge: 60,
  retirementNoticeMonths: 6,
  digestEnabled: true,
};

/** A contract-decision task at the manager step, nothing proposed yet. */
export function decisionTask(overrides: Partial<Extract<OpenTask['subject'], { type: 'contract_decision' }>> = {}, stepKey = 'manager'): OpenTask {
  return {
    id: 't-decision',
    stepKey,
    stepIndex: stepKey === 'hr' ? 1 : 0,
    stepLabels: stepKey === 'hr' ? { fr: 'RH', ar: 'الموارد البشرية', en: 'HR' } : { fr: 'Responsable', ar: 'المسؤول', en: 'Manager' },
    createdAt: '2026-10-19T05:00:00Z',
    subject: {
      type: 'contract_decision',
      id: 'dec-1',
      employee: { id: EMPLOYEE.id, matricule: EMPLOYEE.matricule, person: EMPLOYEE.person, unit: EMPLOYEE.unit },
      contract: { contractType: 'cdd', startDate: '2025-12-01', endDate: '2026-11-30' },
      proposal: null,
      proposedEndDate: null,
      proposedStartDate: null,
      comment: null,
      ...overrides,
    },
  };
}
