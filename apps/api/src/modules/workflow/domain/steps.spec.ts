import { describe, expect, it } from 'vitest';
import { excludedActors, parseSteps, progressOf, WorkflowRuleViolation, type StepDef } from './steps.js';

const L = { fr: 'Manager', ar: 'المسؤول', en: 'Manager' };
const MANAGER_THEN_HR = [
  { key: 'manager', kind: 'manager', labels: L },
  { key: 'hr', kind: 'permission', permission: 'leave.approve_hr', labels: L },
];

function slugOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkflowRuleViolation) return error.slug;
    throw error;
  }
  return undefined;
}

describe('parseSteps', () => {
  it('accepts manager → permission', () => {
    expect(parseSteps(MANAGER_THEN_HR).map((s) => `${s.kind}:${s.key}`)).toEqual(['manager:manager', 'permission:hr']);
  });

  it('refuses malformed definitions', () => {
    expect(slugOf(() => parseSteps([]))).toBe('workflow-definition');
    expect(slugOf(() => parseSteps({}))).toBe('workflow-definition');
    expect(slugOf(() => parseSteps([{ key: 'manager', kind: 'manager', labels: L }]))).toBe('workflow-definition'); // last must be permission
    expect(slugOf(() => parseSteps([{ key: 'hr', kind: 'permission', labels: L }]))).toBe('workflow-definition'); // no permission
    expect(slugOf(() => parseSteps([{ key: 'hr', kind: 'permission', permission: 'leave.approve_hr', labels: { fr: 'x' } }]))).toBe('workflow-definition');
    expect(slugOf(() => parseSteps([...MANAGER_THEN_HR, MANAGER_THEN_HR[1]]))).toBe('workflow-definition'); // duplicate key
    expect(slugOf(() => parseSteps([{ key: 'X', kind: 'permission', permission: 'leave.approve_hr', labels: L }]))).toBe('workflow-definition');
    expect(slugOf(() => parseSteps([{ key: 'a', kind: 'robot', labels: L }, MANAGER_THEN_HR[1]]))).toBe('workflow-definition');
  });
});

describe('progressOf', () => {
  const steps = parseSteps(MANAGER_THEN_HR) as StepDef[];

  it('pending at the manager step', () => {
    expect(progressOf(steps, [{ stepIndex: 0, status: 'open', outcome: null }], 'pending').map((s) => s.state)).toEqual(['current', 'pending']);
  });

  it('manager approved, HR open; escalated manager step', () => {
    expect(
      progressOf(steps, [{ stepIndex: 0, status: 'done', outcome: 'approve' }, { stepIndex: 1, status: 'open', outcome: null }], 'pending').map((s) => s.state),
    ).toEqual(['done', 'current']);
    expect(
      progressOf(steps, [{ stepIndex: 0, status: 'skipped', outcome: 'escalated' }, { stepIndex: 1, status: 'open', outcome: null }], 'pending').map((s) => s.state),
    ).toEqual(['escalated', 'current']);
  });

  it('rejected at the manager step; cancelled while at HR; fully approved', () => {
    expect(progressOf(steps, [{ stepIndex: 0, status: 'done', outcome: 'reject' }], 'rejected').map((s) => s.state)).toEqual(['rejected', 'skipped']);
    expect(
      progressOf(steps, [{ stepIndex: 0, status: 'done', outcome: 'approve' }, { stepIndex: 1, status: 'cancelled', outcome: null }], 'cancelled').map((s) => s.state),
    ).toEqual(['done', 'cancelled']);
    expect(
      progressOf(steps, [{ stepIndex: 0, status: 'done', outcome: 'approve' }, { stepIndex: 1, status: 'done', outcome: 'approve' }], 'approved').map((s) => s.state),
    ).toEqual(['done', 'done']);
  });
});

describe('separation of duties', () => {
  it('the starter and the subject user are excluded', () => {
    expect([...excludedActors('u1', 'u2')]).toEqual(['u1', 'u2']);
    expect([...excludedActors('u1', null)]).toEqual(['u1']);
  });
});
