import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  checkTerms,
  ContractRuleViolation,
  currentOf,
  decisionDue,
  planCorrection,
  planInitial,
  planLater,
  planProposal,
  type ContractFacts,
} from './contracts.js';

const today = '2026-10-19';
const open = { hireDate: '2024-01-01', endDate: null };
const c = (over: Partial<ContractFacts>): ContractFacts => ({ id: 'c1', seq: 1, kind: 'initial', contractType: 'cdd', startDate: '2024-01-01', endDate: '2026-12-31', probationEnd: null, ...over });

function violation(run: () => unknown): ContractRuleViolation {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractRuleViolation) return error;
    throw error;
  }
  throw new Error('no violation');
}

describe('dates', () => {
  it('adds days and months (clamped to the month length)', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
  });
});

describe('checkTerms', () => {
  it('needs an end date for a fixed-term contract and refuses one for a CDI', () => {
    expect(violation(() => checkTerms({ contractType: 'cdd', startDate: today, endDate: null, probationEnd: null }))).toMatchObject({ status: 422, field: 'endDate', code: 'required' });
    expect(violation(() => checkTerms({ contractType: 'cdi', startDate: today, endDate: '2027-01-01', probationEnd: null }))).toMatchObject({ field: 'endDate', code: 'not_allowed' });
    expect(violation(() => checkTerms({ contractType: 'stage', startDate: today, endDate: '2026-10-01', probationEnd: null }))).toMatchObject({ code: 'before_start' });
  });

  it('keeps the probation within 12 months of the start and within the contract', () => {
    expect(() => checkTerms({ contractType: 'cdi', startDate: '2026-01-15', endDate: null, probationEnd: '2027-01-14' })).not.toThrow();
    expect(violation(() => checkTerms({ contractType: 'cdi', startDate: '2026-01-15', endDate: null, probationEnd: '2027-01-15' }))).toMatchObject({ field: 'probationEnd', code: 'out_of_range' });
    expect(violation(() => checkTerms({ contractType: 'cdd', startDate: '2026-01-15', endDate: '2026-03-31', probationEnd: '2026-04-30' }))).toMatchObject({ code: 'out_of_range' });
    expect(violation(() => checkTerms({ contractType: 'cdi', startDate: '2026-01-15', endDate: null, probationEnd: '2026-01-14' }, 'contract.'))).toMatchObject({ field: 'contract.probationEnd' });
  });
});

describe('planInitial', () => {
  it('starts on the hire date, once', () => {
    expect(planInitial([], open, { contractType: 'cdi', startDate: '2024-01-01', endDate: null, probationEnd: null }, today)).toEqual({ seq: 1 });
    expect(violation(() => planInitial([], open, { contractType: 'cdi', startDate: '2024-02-01', endDate: null, probationEnd: null }, today, 'contract.'))).toMatchObject({ field: 'contract.startDate', code: 'must_equal_hire_date' });
    expect(violation(() => planInitial([c({})], open, { contractType: 'cdi', startDate: '2024-01-01', endDate: null, probationEnd: null }, today)).slug).toBe('contract-initial-exists');
  });

  it('refuses an employment whose end has passed and a start after the end', () => {
    expect(violation(() => planInitial([], { hireDate: '2024-01-01', endDate: '2026-01-31' }, { contractType: 'cdi', startDate: '2024-01-01', endDate: null, probationEnd: null }, today)).slug).toBe('employment-ended');
  });
});

describe('planLater', () => {
  const previous = [c({})];

  it('renews the same type from the day after the previous end', () => {
    expect(planLater(previous, open, 'renewal', { contractType: 'cdd', startDate: '2027-01-01', endDate: '2027-06-30', probationEnd: null }, today)).toEqual({ seq: 2, shortenPrevious: null });
    expect(violation(() => planLater(previous, open, 'renewal', { contractType: 'cdd', startDate: '2027-01-02', endDate: '2027-06-30', probationEnd: null }, today))).toMatchObject({ field: 'startDate', code: 'must_follow_previous' });
    expect(violation(() => planLater(previous, open, 'renewal', { contractType: 'stage', startDate: '2027-01-01', endDate: '2027-06-30', probationEnd: null }, today))).toMatchObject({ field: 'contractType', code: 'must_match_previous' });
    expect(violation(() => planLater([c({ contractType: 'cdi', endDate: null })], open, 'renewal', { contractType: 'cdi', startDate: '2027-01-01', endDate: null, probationEnd: null }, today)).slug).toBe('contract-not-fixed-term');
  });

  it('converts or amends from a later start, cutting the previous contract when it would overlap', () => {
    expect(planLater(previous, open, 'conversion', { contractType: 'cdi', startDate: '2027-01-01', endDate: null, probationEnd: null }, today)).toEqual({ seq: 2, shortenPrevious: null });
    expect(planLater(previous, open, 'conversion', { contractType: 'cdi', startDate: '2026-11-01', endDate: null, probationEnd: null }, today)).toEqual({ seq: 2, shortenPrevious: { id: 'c1', endDate: '2026-10-31' } });
    expect(planLater([c({ contractType: 'cdi', endDate: null })], open, 'amendment', { contractType: 'cdi', startDate: '2026-11-01', endDate: null, probationEnd: null }, today)).toEqual({ seq: 2, shortenPrevious: { id: 'c1', endDate: '2026-10-31' } });
    expect(violation(() => planLater(previous, open, 'amendment', { contractType: 'cdd', startDate: '2024-01-01', endDate: '2027-01-01', probationEnd: null }, today))).toMatchObject({ code: 'must_follow_previous' });
    expect(violation(() => planLater([], open, 'conversion', { contractType: 'cdi', startDate: '2026-11-01', endDate: null, probationEnd: null }, today)).slug).toBe('contract-initial-missing');
  });
});

describe('planCorrection', () => {
  it('corrects only the latest contract', () => {
    const contracts = [c({}), c({ id: 'c2', seq: 2, kind: 'renewal', startDate: '2027-01-01', endDate: '2027-06-30' })];
    expect(planCorrection(contracts, 'c2', { endDate: '2027-12-31' }, open, today)).toMatchObject({ endDate: '2027-12-31' });
    expect(violation(() => planCorrection(contracts, 'c1', { endDate: '2026-11-30' }, open, today)).slug).toBe('contract-not-latest');
    expect(violation(() => planCorrection(contracts, 'c2', { endDate: null }, open, today))).toMatchObject({ field: 'endDate', code: 'required' });
  });
});

describe('planProposal', () => {
  const contract = { contractType: 'cdd' as const, endDate: '2026-11-08' };
  it('normalises renew, convert and end', () => {
    expect(planProposal(contract, { proposal: 'renew', proposedEndDate: '2027-05-08' })).toEqual({ proposal: 'renew', startDate: '2026-11-09', endDate: '2027-05-08' });
    expect(planProposal(contract, { proposal: 'convert_cdi' })).toEqual({ proposal: 'convert_cdi', startDate: '2026-11-09', endDate: null });
    expect(planProposal(contract, { proposal: 'end' })).toEqual({ proposal: 'end', startDate: null, endDate: null });
    expect(violation(() => planProposal(contract, { proposal: 'renew' }))).toMatchObject({ field: 'proposedEndDate', code: 'required' });
    expect(violation(() => planProposal(contract, { proposal: 'renew', proposedStartDate: '2026-11-20', proposedEndDate: '2027-05-08' }))).toMatchObject({ field: 'proposedStartDate' });
    expect(violation(() => planProposal(contract, { proposal: 'convert_cdi', proposedEndDate: '2027-01-01' }))).toMatchObject({ code: 'not_allowed' });
  });
});

describe('currentOf and decisionDue', () => {
  it('finds the contract covering a date (inclusive end)', () => {
    const contracts = [c({ endDate: '2026-10-19' }), c({ id: 'c2', seq: 2, startDate: '2026-10-20', endDate: null, contractType: 'cdi' })];
    expect(currentOf(contracts, '2026-10-19')?.id).toBe('c1');
    expect(currentOf(contracts, '2026-10-20')?.id).toBe('c2');
    expect(currentOf([c({ startDate: '2027-01-01' })], today)).toBeNull();
  });

  it('opens a decision within the notice, once, for an open employment', () => {
    const ending = { contractType: 'cdd' as const, endDate: addDays(today, 45) };
    expect(decisionDue(ending, true, open, today, 45, false)).toBe(true);
    expect(decisionDue({ ...ending, endDate: addDays(today, 46) }, true, open, today, 45, false)).toBe(false);
    expect(decisionDue(ending, true, open, today, 45, true)).toBe(false);
    expect(decisionDue(ending, false, open, today, 45, false)).toBe(false);
    expect(decisionDue(ending, true, open, today, 0, false)).toBe(false);
    expect(decisionDue(ending, true, { hireDate: '2024-01-01', endDate: addDays(today, 45) }, today, 45, false)).toBe(false);
    expect(decisionDue({ ...ending, endDate: addDays(today, -1) }, true, open, today, 45, false)).toBe(false);
  });
});
