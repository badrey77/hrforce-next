import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { detail } from '../../../testing/employee-fixtures';
import { BALANCE_2025, BALANCE_2026, flushLeaveTypes } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { adjustmentDays, EmployeeLeaveTab } from './employee-leave-tab';
import { FormControl } from '@angular/forms';

@Component({
  imports: [EmployeeLeaveTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-employee-leave-tab [employee]="employee" />`,
})
class Host {
  readonly employee = detail();
}

async function settle(fixture: ComponentFixture<Host>): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
  fixture.detectChanges();
}

const LEDGER = [
  { id: 'l-1', leaveTypeId: 't-annual', periodStart: '2025-07-01', kind: 'accrual', days: 2.5, requestId: null, note: null, createdBy: null, createdAt: '2025-08-01T00:00:00Z' },
  { id: 'l-2', leaveTypeId: 't-annual', periodStart: '2025-07-01', kind: 'taken', days: -5, requestId: 'r-1', note: null, createdBy: { id: 'u', displayName: 'Karim Haddad' }, createdAt: '2025-12-01T00:00:00Z' },
];

describe('adjustmentDays', () => {
  it('accepts non-zero amounts with one decimal', () => {
    expect(adjustmentDays(new FormControl(-0.5))).toBeNull();
    expect(adjustmentDays(new FormControl(0))).toEqual({ number: true });
    expect(adjustmentDays(new FormControl(1.25))).toEqual({ number: true });
    expect(adjustmentDays(new FormControl(null))).toBeNull();
  });
});

describe('EmployeeLeaveTab', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  let http: HttpTestingController;

  async function create(permissions: string[]): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [Host, translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(Session).set(meWith(permissions));
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement as HTMLElement;
    http = TestBed.inject(HttpTestingController);
    await settle(fixture);
    flushLeaveTypes(http);
    http.expectOne('/api/employees/e-1/leave/balances').flush({ items: [BALANCE_2025, BALANCE_2026] });
    http.expectOne('/api/employees/e-1/leave/ledger').flush({ items: LEDGER });
    await settle(fixture);
  }

  afterEach(() => http.verify());

  it('shows balances and the ledger; no write buttons with leave.read only', async () => {
    await create(['leave.read']);
    expect(el.querySelectorAll('app-balance-cards [data-period]')).toHaveLength(2);
    const rows = [...el.querySelectorAll('[data-table="ledger"] tbody tr')];
    expect(rows[0]?.textContent).toContain('Acquisition');
    expect(rows[0]?.textContent).toContain('+2,5');
    expect(rows[0]?.textContent).toContain('Automatique');
    expect(rows[1]?.textContent).toContain('-5');
    expect(rows[1]?.textContent).toContain('Karim Haddad');
    expect(el.querySelector('[data-action="adjust"]')).toBeNull();
    expect(el.querySelector('[data-action="request-on-behalf"]')).toBeNull();
  });

  it('adjusts a balance (leave.adjust) and reloads balances and ledger', async () => {
    await create(['leave.read', 'leave.adjust', 'leave.request']);
    expect(el.querySelector('[data-action="request-on-behalf"]')).not.toBeNull();
    (el.querySelector('[data-action="adjust"]') as HTMLButtonElement).click();
    await settle(fixture);
    expect((el.querySelector('#adjust-period') as HTMLInputElement).value).toBe('2026-07-01');

    const days = el.querySelector('#adjust-days') as HTMLInputElement;
    days.value = '0';
    days.dispatchEvent(new Event('input'));
    el.querySelector('[data-form="adjust"]')?.dispatchEvent(new Event('submit'));
    await settle(fixture);
    http.expectNone('/api/employees/e-1/leave/adjustments');
    expect(el.querySelector('[data-error="days"]')?.textContent?.trim()).toBe('Nombre invalide.');
    expect(el.querySelector('[data-error="note"]')).not.toBeNull();

    days.value = '-1.5';
    days.dispatchEvent(new Event('input'));
    const note = el.querySelector('#adjust-note') as HTMLTextAreaElement;
    note.value = 'Correction';
    note.dispatchEvent(new Event('input'));
    el.querySelector('[data-form="adjust"]')?.dispatchEvent(new Event('submit'));
    const post = http.expectOne('/api/employees/e-1/leave/adjustments');
    expect(post.request.body).toEqual({ leaveTypeId: 't-annual', periodStart: '2026-07-01', days: -1.5, note: 'Correction' });
    post.flush({});
    await settle(fixture);
    expect(el.querySelector('.feedback')?.textContent?.trim()).toBe('Ajustement enregistré.');
    http.expectOne('/api/employees/e-1/leave/balances').flush({ items: [] });
    http.expectOne('/api/employees/e-1/leave/ledger').flush({ items: [] });
  });
});
