import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ME_FIXTURE } from '../../../testing/auth-fixtures';
import { conflict, flushLeaveTypes, leaveDetail } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { LeaveRequestDetail } from '../../core/leave/leave.models';
import { LEAVE_PREVIEW_DEBOUNCE_MS, LeaveRequestForm } from './leave-request-form';

@Component({
  imports: [LeaveRequestForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-leave-request-form [employmentId]="employmentId()" (saved)="saved.set($event)" (notLinked)="notLinked.set(true)" />`,
})
class Host {
  readonly employmentId = signal<string | null>(null);
  readonly saved = signal<LeaveRequestDetail | null>(null);
  readonly notLinked = signal(false);
}

const PREVIEW = '/api/leave/preview';

describe('LeaveRequestForm', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  let http: HttpTestingController;

  beforeEach(async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({
      imports: [Host, translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(Session).set(ME_FIXTURE);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  /** Let promises (resource values) resolve, then render. */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    fixture.detectChanges();
  }

  async function create(employmentId: string | null = null): Promise<void> {
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.employmentId.set(employmentId);
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    TestBed.tick();
    flushLeaveTypes(http);
    await settle();
  }

  const q = (selector: string) => el.querySelector(selector);
  const field = (suffix: string) => el.querySelector(`[id$="-${suffix}"]`) as HTMLInputElement | HTMLSelectElement;
  function set(suffix: string, value: string | boolean): void {
    const input = field(suffix);
    if (typeof value === 'boolean' && input instanceof HTMLInputElement) {
      input.checked = value;
      input.dispatchEvent(new Event('change'));
    } else {
      input.value = String(value);
      input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
    }
    fixture.detectChanges();
  }
  /** Let the debounce run out, then let the resource send its request. */
  async function waitDebounce(ms = LEAVE_PREVIEW_DEBOUNCE_MS): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    TestBed.tick();
    fixture.detectChanges();
  }
  function submit(): void {
    q('form')?.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
  }
  async function flushPreviews(): Promise<void> {
    await waitDebounce();
    http.match(PREVIEW).forEach((r) => r.flush({ days: 2, breakdown: { calendarDays: 2, weekendDays: 0, holidays: [] }, balanceAfter: null }));
  }

  it('lists active types only, in the UI language', async () => {
    await create();
    const options = [...(field('type') as HTMLSelectElement).options].map((o) => o.textContent?.trim());
    expect(options).toEqual(['Choisissez un type…', 'Congé annuel', 'Congé de maladie']);
  });

  it('previews once the form is still (debounce), and a newer input cancels the older request', async () => {
    await create();
    await waitDebounce();
    http.expectNone(PREVIEW); // no type yet: nothing to count
    expect(q('[data-preview="idle"]')).not.toBeNull();

    set('type', 't-annual');
    set('start', '2026-10-05');
    set('end', '2026-10-0');
    set('end', '2026-10-09');
    await waitDebounce(LEAVE_PREVIEW_DEBOUNCE_MS - 1);
    http.expectNone(PREVIEW);
    await waitDebounce(1);
    const first = http.expectOne(PREVIEW);
    expect(first.request.method).toBe('POST');
    expect(first.request.body).toEqual({
      leaveTypeId: 't-annual',
      startDate: '2026-10-05',
      endDate: '2026-10-09',
      halfDayStart: false,
      halfDayEnd: false,
    });

    set('half-end', true);
    await waitDebounce();
    const second = http.expectOne(PREVIEW);
    expect(first.cancelled).toBe(true);
    expect(second.request.body).toMatchObject({ halfDayEnd: true });
    second.flush({
      days: 4.5,
      breakdown: {
        calendarDays: 5,
        weekendDays: 0,
        holidays: [{ date: '2026-11-01', name: { fr: 'Anniversaire du 1er Novembre', ar: 'عيد الثورة', en: 'Revolution Day' } }],
        halfDays: 1,
      },
      balanceAfter: -1.5,
      warnings: ['leave-balance', 'leave-overlap'],
    });
    await settle();
    expect(q('[data-preview="days"]')?.textContent?.trim()).toBe('4,5 jour(s) décompté(s)');
    expect(q('[data-preview="half"]')?.textContent?.trim()).toBe('1');
    expect(q('[data-preview="holidays"]')?.textContent).toContain('Anniversaire du 1er Novembre');
    expect(q('[data-preview="balance"]')?.classList).toContain('negative');
    expect(q('[data-preview="over"]')).not.toBeNull();
    // leave-balance is already said by "over"; the overlap warning is shown.
    expect([...el.querySelectorAll('[data-preview="warning"]')].map((p) => p.textContent?.trim())).toEqual([
      'Une autre demande en attente ou approuvée couvre déjà ces dates.',
    ]);

    // Changing only the reason does not change the preview body: no request.
    set('reason', 'Vacances');
    await waitDebounce();
    http.expectNone(PREVIEW);
  });

  it('adds employmentId to the preview on behalf of an employee, and POSTs to /employees/:id', async () => {
    await create('e-7');
    set('type', 't-annual');
    await waitDebounce();
    expect(http.expectOne(PREVIEW).request.body).toMatchObject({ employmentId: 'e-7' });
    submit();
    const req = http.expectOne('/api/employees/e-7/leave/requests');
    expect(req.request.body).toEqual({ leaveTypeId: 't-annual', startDate: expect.any(String), endDate: expect.any(String), halfDayStart: false, halfDayEnd: false });
    req.flush(leaveDetail());
    expect(fixture.componentInstance.saved()?.id).toBe('r-1');
  });

  it('validates before sending: type, date order, half days, document for sick leave', async () => {
    await create();
    submit();
    http.expectNone('/api/me/leave/requests');
    expect(q('[id$="-type-error"]')?.textContent?.trim()).toBe('Ce champ est obligatoire.');

    set('type', 't-sick');
    set('start', '2026-10-05');
    set('end', '2026-10-04');
    submit();
    expect(q('[data-error="dateOrder"]')).not.toBeNull();
    expect(q('[id$="-doc-error"]')?.textContent?.trim()).toBe('Ce type de congé exige un justificatif.');

    set('end', '2026-10-05');
    set('half-start', true);
    set('half-end', true);
    submit();
    expect(q('[data-error="halfDays"]')).not.toBeNull();
    http.expectNone('/api/me/leave/requests');
    await flushPreviews();
  });

  function fillValid(): void {
    set('type', 't-sick');
    set('start', '2026-10-05');
    set('end', '2026-10-06');
    set('doc', 'CM-42');
  }

  it.each([
    ['leave-overlap', '[id$="-start-error"]', 'Une autre demande en attente ou approuvée couvre déjà ces dates.'],
    ['leave-dates', '[id$="-end-error"]', 'Dates invalides : la fin précède le début, ou la période sort de l\'emploi.'],
    ['leave-document-required', '[id$="-doc-error"]', 'Un justificatif est obligatoire pour ce type de congé.'],
    ['leave-balance', '[data-error="form"]', 'Solde insuffisant (demandes en attente comprises).'],
  ])('maps 409 %s to where it can be fixed', async (slug, selector, message) => {
    await create();
    fillValid();
    submit();
    const req = http.expectOne('/api/me/leave/requests');
    expect(req.request.body).toMatchObject({ documentRef: 'CM-42' });
    req.flush(...conflict(slug));
    fixture.detectChanges();
    expect(q(selector)?.textContent?.trim()).toBe(message);
    await flushPreviews();
  });

  it('raises leave-not-linked to the page instead of the form', async () => {
    await create();
    fillValid();
    submit();
    http.expectOne('/api/me/leave/requests').flush(...conflict('leave-not-linked'));
    fixture.detectChanges();
    expect(fixture.componentInstance.notLinked()).toBe(true);
    expect(q('[data-error="form"]')).toBeNull();
    await flushPreviews();
  });
});
