import { describe, expect, it } from 'vitest';
import { addDays, addMonths, addYears, daysBetween } from './dates.js';
import { compareCandidates, computeDeadlines, contractOn, deadlineKey, enteredSince, firstUncoveredDay, onBoard, type ContractFact, type EmploymentFact } from './compute.js';
import { DEFAULT_DEADLINE_POLICY as P } from './types.js';

const TODAY = '2026-10-19';

const cdi = (id: string, startDate: string, probationEnd: string | null = null): ContractFact => ({ id, contractType: 'cdi', startDate, endDate: null, probationEnd });
const cdd = (id: string, startDate: string, endDate: string, probationEnd: string | null = null): ContractFact => ({ id, contractType: 'cdd', startDate, endDate, probationEnd });

function emp(over: Partial<EmploymentFact> & { contracts?: ContractFact[] } = {}): EmploymentFact {
  return { employmentId: 'e1', hireDate: '2024-01-01', endDate: null, birthDate: null, contracts: [cdi('c1', '2024-01-01')], ...over };
}

const kinds = (list: { kind: string }[]) => list.map((c) => c.kind).toSorted();

describe('dates', () => {
  it('adds days, months and years on the calendar', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-19', '2026-11-18')).toBe(30);
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2028-03-31', -1)).toBe('2028-02-29');
    expect(addMonths('2026-10-19', -6)).toBe('2026-04-19');
    expect(addYears('1968-02-29', 60)).toBe('2028-02-29');
    expect(addYears('1967-02-28', 60)).toBe('2027-02-28');
    expect(addYears('1968-02-29', 59)).toBe('2027-02-28');
  });
});

const probationOnly = emp({ contracts: [cdi('c1', '2024-01-01', '2026-10-29')] });
const at = (today: string, e: EmploymentFact) => computeDeadlines([e], [], P, today);
const on = (today: string) => at(today, probationOnly);

describe('computeDeadlines', () => {
  it('a CDI without probation or birth date has nothing', () => {
    expect(computeDeadlines([emp()], [], P, TODAY)).toEqual([]);
  });

  it('probation end: due before the date, overdue for 30 days, then hidden', () => {
    const due = on(TODAY);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ kind: 'probation_end', subjectId: 'c1', contractId: 'c1', dueDate: '2026-10-29', daysLeft: 10, status: 'due', severity: 'info', windowStart: '2026-10-14' });
    expect(on('2026-10-29')[0]).toMatchObject({ status: 'due', daysLeft: 0 });
    expect(on('2026-10-30')[0]).toMatchObject({ status: 'overdue', severity: 'warning', daysLeft: -1 });
    expect(on('2026-11-28')).toHaveLength(1);
    expect(on('2026-11-29')).toHaveLength(0);
  });

  it('contract end of a running CDD: due, then critical while the person keeps working', () => {
    const e = emp({ contracts: [cdd('c1', '2024-01-01', '2026-11-08')] });
    const [due] = computeDeadlines([e], [], P, TODAY);
    expect(due).toMatchObject({ kind: 'contract_end', subjectId: 'c1', dueDate: '2026-11-08', daysLeft: 20, status: 'due', severity: 'info', windowStart: '2026-10-09', overdueFrom: '2026-11-09' });
    const after = computeDeadlines([e], [], P, '2026-11-12');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: 'contract_end', status: 'overdue', severity: 'critical', daysLeft: -4 });
  });

  it('no contract_end when a contract follows, or when the employment ends with the contract', () => {
    const renewed = emp({ contracts: [cdd('c1', '2024-01-01', '2026-11-08'), cdd('c2', '2026-11-09', '2027-11-08')] });
    expect(computeDeadlines([renewed], [], P, TODAY).map((c) => c.subjectId)).toEqual(['c2']);
    const ending = emp({ endDate: '2026-11-08', contracts: [cdd('c1', '2024-01-01', '2026-11-08')] });
    expect(computeDeadlines([ending], [], P, TODAY)).toEqual([]);
    // the employment ends later than the contract: the contract end still needs a decision
    const later = emp({ endDate: '2026-12-31', contracts: [cdd('c1', '2024-01-01', '2026-11-08')] });
    expect(kinds(computeDeadlines([later], [], P, TODAY))).toEqual(['contract_end']);
  });

  it('ended employments have nothing; items after a future end date are dropped', () => {
    const ended = emp({ endDate: '2026-10-18', birthDate: '1960-01-01', contracts: [cdd('c1', '2024-01-01', '2026-10-18')] });
    expect(computeDeadlines([ended], [{ id: 'f1', employmentId: 'e1', expiresOn: '2026-10-25' }], P, TODAY)).toEqual([]);
    const leaving = emp({ endDate: '2026-11-30', birthDate: '1966-12-15' });
    expect(computeDeadlines([leaving], [{ id: 'f1', employmentId: 'e1', expiresOn: '2026-12-05' }], P, TODAY)).toEqual([]);
  });

  it('retirement at the policy age, shown from the notice months', () => {
    const [r] = computeDeadlines([emp({ birthDate: '1967-03-10' })], [], P, TODAY);
    expect(r).toMatchObject({ kind: 'retirement', subjectId: 'e1', dueDate: '2027-03-10', status: 'due', windowStart: '2026-09-10' });
    const [past] = computeDeadlines([emp({ birthDate: '1960-01-01' })], [], P, TODAY);
    expect(past).toMatchObject({ kind: 'retirement', status: 'overdue', severity: 'warning' });
    expect(computeDeadlines([emp({ birthDate: '1967-03-10' })], [], { ...P, retirementAge: 62 }, TODAY)[0]?.dueDate).toBe('2029-03-10');
  });

  it('document expiry from the employee file', () => {
    const [d] = computeDeadlines([emp()], [{ id: 'f1', employmentId: 'e1', expiresOn: '2026-11-02' }], P, TODAY);
    expect(d).toMatchObject({ kind: 'document_expiry', subjectId: 'f1', fileId: 'f1', status: 'due', windowStart: '2026-10-03' });
    expect(computeDeadlines([emp()], [{ id: 'f1', employmentId: 'other', expiresOn: '2026-11-02' }], P, TODAY)).toEqual([]);
  });

  it('missing contract: none at all, a gap at the start or between contracts', () => {
    const none = computeDeadlines([emp({ contracts: [] })], [], P, TODAY);
    expect(none).toEqual([expect.objectContaining({ kind: 'contract_missing', subjectId: 'e1', dueDate: '2024-01-01', status: 'overdue', severity: 'warning' })]);
    expect(firstUncoveredDay(emp({ contracts: [cdi('c1', '2024-03-01')] }), TODAY)).toBe('2024-01-01');
    expect(firstUncoveredDay(emp({ contracts: [cdd('c1', '2024-01-01', '2024-12-31'), cdi('c2', '2025-02-01')] }), TODAY)).toBe('2025-01-01');
    // a future hire, a fully covered employment, or the lapse right after the last fixed-term contract: not missing
    expect(firstUncoveredDay(emp({ hireDate: '2026-11-01', contracts: [] }), TODAY)).toBeNull();
    expect(firstUncoveredDay(emp(), TODAY)).toBeNull();
    expect(firstUncoveredDay(emp({ contracts: [cdd('c1', '2024-01-01', '2026-10-10')] }), TODAY)).toBeNull();
    expect(firstUncoveredDay(emp({ contracts: [cdd('c1', '2024-01-01', '2026-10-25')] }), TODAY)).toBeNull();
  });

  it('the current contract', () => {
    const list = [cdd('c1', '2024-01-01', '2024-12-31'), cdi('c2', '2025-01-01')];
    expect(contractOn(list, '2024-12-31')?.id).toBe('c1');
    expect(contractOn(list, '2025-01-01')?.id).toBe('c2');
    expect(contractOn(list, '2023-12-31')).toBeUndefined();
  });
});

describe('board horizon, digest delta, order, key', () => {

  it('onBoard: overdue, within the horizon, or inside the notice window', () => {
    const [far] = at(TODAY, emp({ contracts: [cdd('c1', '2024-01-01', '2027-03-01')] }));
    expect(far && onBoard(far, TODAY, 90)).toBe(false);
    expect(far && onBoard(far, TODAY, 200)).toBe(true);
    const [retire] = at(TODAY, emp({ birthDate: '1967-03-10' }));
    expect(retire && onBoard(retire, TODAY, 90)).toBe(true);
  });

  it('enteredSince: the window opened or the item became overdue in (since, today]', () => {
    const e = emp({ contracts: [cdd('c1', '2024-01-01', '2026-11-18')] });
    const [opening] = at('2026-10-19', e);
    expect(opening?.windowStart).toBe('2026-10-19');
    expect(opening && enteredSince(opening, '2026-10-18', '2026-10-19')).toBe(true);
    const [next] = at('2026-10-20', e);
    expect(next && enteredSince(next, '2026-10-19', '2026-10-20')).toBe(false);
    const [overdue] = at('2026-11-19', e);
    expect(overdue && enteredSince(overdue, '2026-11-18', '2026-11-19')).toBe(true);
    const [missing] = at(TODAY, emp({ contracts: [] }));
    expect(missing && enteredSince(missing, '2026-10-18', TODAY)).toBe(false);
  });

  it('orders overdue first, then by due date', () => {
    const items = [
      { status: 'due' as const, dueDate: '2026-10-20', kind: 'a', subjectId: '1' },
      { status: 'overdue' as const, dueDate: '2026-10-30', kind: 'a', subjectId: '2' },
      { status: 'due' as const, dueDate: '2026-10-19', kind: 'b', subjectId: '3' },
    ];
    expect(items.toSorted(compareCandidates).map((i) => i.subjectId)).toEqual(['2', '3', '1']);
  });

  it('key', () => {
    expect(deadlineKey('contract_end', 'c1', '2026-11-08')).toBe('contract_end:c1:2026-11-08');
  });
});
