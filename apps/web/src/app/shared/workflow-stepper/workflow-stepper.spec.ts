import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { leaveDetail, MANAGER_THEN_HR } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { LanguageService } from '../../core/i18n/language.service';
import type { WorkflowStepDef, WorkflowTaskHistory } from '../../core/leave/leave.models';
import { stepStates, WorkflowStepper } from './workflow-stepper';

const states = (...args: Parameters<typeof stepStates>) => stepStates(...args).map((v) => v.state);
const [MANAGER_TASK, HR_TASK] = leaveDetail().history as [WorkflowTaskHistory, WorkflowTaskHistory];

describe('stepStates', () => {
  it('pending: steps before the current one are done, after it upcoming', () => {
    expect(states({ ...MANAGER_THEN_HR, currentStep: 0 })).toEqual(['current', 'upcoming']);
    expect(states(MANAGER_THEN_HR)).toEqual(['done', 'current']);
  });

  it('approved: all done; rejected/cancelled: stop where the history says', () => {
    expect(states({ ...MANAGER_THEN_HR, status: 'approved', currentStep: null })).toEqual(['done', 'done']);
    const reject: WorkflowTaskHistory = { ...MANAGER_TASK, outcome: 'reject', stepIndex: 0 };
    expect(states({ ...MANAGER_THEN_HR, status: 'rejected', currentStep: null }, [reject])).toEqual(['rejected', 'upcoming']);
    const cancelled: WorkflowTaskHistory = { ...HR_TASK, status: 'cancelled' };
    expect(states({ ...MANAGER_THEN_HR, status: 'cancelled', currentStep: null }, [cancelled])).toEqual(['done', 'cancelled']);
    // Cancelled after approval (a future leave): nothing stopped it.
    expect(states({ ...MANAGER_THEN_HR, status: 'cancelled', currentStep: null })).toEqual(['done', 'done']);
  });

  it("uses the API's per-step state when sent (list rows have no history)", () => {
    const [manager, hr] = MANAGER_THEN_HR.steps as [WorkflowStepDef, WorkflowStepDef];
    const cancelledPending = { status: 'cancelled' as const, currentStep: null, steps: [{ ...manager, state: 'cancelled' as const }, { ...hr, state: 'skipped' as const }] };
    expect(states(cancelledPending)).toEqual(['cancelled', 'upcoming']);
    const rejectedAtHr = { status: 'rejected' as const, currentStep: null, steps: [{ ...manager, state: 'escalated' as const }, { ...hr, state: 'rejected' as const }] };
    expect(stepStates(rejectedAtHr).map((v) => [v.state, v.escalated])).toEqual([['skipped', true], ['rejected', false]]);
  });

  it('flags an escalated step', () => {
    const escalated: WorkflowTaskHistory = { ...MANAGER_TASK, outcome: 'escalated' };
    expect(stepStates(MANAGER_THEN_HR, [escalated])[0]?.escalated).toBe(true);
  });
});

describe('WorkflowStepper', () => {
  it('renders an ordered list with aria-current on the open step, labels in the UI language', async () => {
    await TestBed.configureTestingModule({
      imports: [WorkflowStepper, translocoTesting()],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const fixture = TestBed.createComponent(WorkflowStepper);
    fixture.componentRef.setInput('progress', MANAGER_THEN_HR);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const items = [...el.querySelectorAll('ol > li')];
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['done', 'current']);
    expect(items[1]?.getAttribute('aria-current')).toBe('step');
    expect(items[1]?.textContent).toContain('RH régionales');
    expect(items[1]?.textContent).toContain('En attente');

    TestBed.inject(LanguageService).use('ar', { remember: false });
    await fixture.whenStable();
    expect(items[0]?.textContent).toContain('المسؤول');
    TestBed.inject(LanguageService).use('fr', { remember: false });
  });
});
