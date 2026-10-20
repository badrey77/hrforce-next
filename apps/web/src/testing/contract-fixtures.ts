import type { ContractList, ContractView } from '../app/core/contracts/contracts.models';

/** A contract of EMP-0001 shaped like `docs/contracts/contracts-deadlines.md` › ContractView (a CDD by default). */
export function contract(extra: Partial<ContractView> = {}): ContractView {
  return {
    id: 'k-2',
    seq: 2,
    kind: 'renewal',
    contractType: 'cdd',
    startDate: '2025-03-01',
    endDate: '2026-02-28',
    probationEnd: null,
    reference: 'CT-2025-07',
    reason: 'Surcroît de travail',
    note: null,
    decision: null,
    pendingDecision: null,
    createdAt: '2025-02-20T09:00:00Z',
    createdBy: { id: 'u-amina', displayName: 'Amina Benali' },
    current: true,
    _actions: ['edit'],
    ...extra,
  };
}

/** The initial CDD of EMP-0001, followed by its renewal (`contract()`): newest first. */
export function contractList(items: readonly ContractView[] = [
  contract(),
  contract({ id: 'k-1', seq: 1, kind: 'initial', startDate: '2024-03-01', endDate: '2025-02-28', probationEnd: '2024-05-31', reference: null, reason: null, current: false, _actions: [] }),
]): ContractList {
  return { items, currentId: items.find((k) => k.current)?.id ?? null };
}
