import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { flushLeaveTypes, LEAVE_TYPES, TYPE_ANNUAL } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LEAVE_ROUTES } from './leave.routes';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const HOLIDAYS = [
  { id: 'h-2', date: '2026-11-01', labels: { fr: 'Anniversaire du 1er Novembre', ar: 'عيد الثورة', en: 'Revolution Day' }, approximate: false },
  { id: 'h-1', date: '2026-03-20', labels: { fr: 'Aïd el-Fitr', ar: 'عيد الفطر', en: 'Eid al-Fitr' }, approximate: true },
];

describe('LeaveSettingsPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  const year = new Date().getFullYear();

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'leave', children: LEAVE_ROUTES }]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['leave.configure']));
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/leave/settings');
    await settle();
    flushLeaveTypes(http);
    http.expectOne((r) => r.url === '/api/leave/holidays' && r.params.get('year') === String(year)).flush({ items: HOLIDAYS });
    http.expectOne('/api/leave/policy').flush({ referenceStartMonth: 7, weekendDays: [5, 6], entitlementDelayMonths: 12 });
    await settle();
  });

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const click = (selector: string, root: ParentNode = el()) => (root.querySelector(selector) as HTMLElement).click();
  function fill(selector: string, value: string): void {
    const input = el().querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('edits a leave type inline (numbers and labels) and reloads the shared catalogue', async () => {
    const row = () => el().querySelector('[data-type="t-annual"]') as HTMLElement;
    expect(row().querySelector('[data-field="name"]')?.textContent?.trim()).toBe('Congé annuel');
    click('[data-action="edit"]', row());
    await settle();
    expect((el().querySelector('#type-label-ar') as HTMLInputElement).value).toBe('عطلة سنوية');
    fill('#type-label-fr', 'Congé annuel payé');
    fill('#type-accrual', '');
    fill('#type-max-year', '0');
    click('[data-action="save"]', row());
    await settle();
    http.expectNone('/api/leave/types/t-annual');
    expect(el().querySelector('[data-error="numbers"]')).not.toBeNull();

    fill('#type-max-year', '32');
    click('[data-action="save"]', row());
    const put = http.expectOne('/api/leave/types/t-annual');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({
      labels: { fr: 'Congé annuel payé', ar: 'عطلة سنوية', en: 'Annual leave' },
      accrualDaysPerMonth: null,
      maxDaysPerYear: 32,
      maxDaysPerRequest: null,
      requiresDocument: false,
      active: true,
    });
    put.flush({ ...TYPE_ANNUAL, maxDaysPerYear: 32 });
    await settle();
    flushLeaveTypes(http, [{ ...TYPE_ANNUAL, labels: { ...TYPE_ANNUAL.labels, fr: 'Congé annuel payé' } }, ...LEAVE_TYPES.slice(1)]);
    await settle();
    expect(row().querySelector('[data-field="name"]')?.textContent?.trim()).toBe('Congé annuel payé');
  });

  it('lists holidays by date with the approximate flag; adds and deletes one', async () => {
    const rows = [...el().querySelectorAll('[data-holiday]')];
    expect(rows.map((r) => r.getAttribute('data-holiday'))).toEqual(['h-1', 'h-2']);
    expect(rows[0]?.querySelector('[data-flag="approximate"]')?.textContent?.trim()).toBe('À confirmer');
    expect(rows[1]?.querySelector('[data-flag="approximate"]')).toBeNull();

    click('[data-action="add-holiday"]');
    await settle();
    fill('#holiday-date', `${year}-01-12`);
    fill('#holiday-label-fr', 'Yennayer');
    fill('#holiday-label-ar', 'يناير');
    fill('#holiday-label-en', 'Yennayer');
    el().querySelector('[data-form="holiday"]')?.dispatchEvent(new Event('submit'));
    const post = http.expectOne('/api/leave/holidays');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({ date: `${year}-01-12`, labels: { fr: 'Yennayer', ar: 'يناير', en: 'Yennayer' }, approximate: false });
    post.flush({ id: 'h-3', ...post.request.body });
    await settle();
    http.expectOne((r) => r.url === '/api/leave/holidays').flush({ items: HOLIDAYS });
    await settle();

    click('[data-holiday="h-2"] [data-action="delete-holiday"]');
    await settle();
    click('[data-action="confirm-delete"]');
    expect(http.expectOne('/api/leave/holidays/h-2').request.method).toBe('DELETE');
  });

  it('saves the policy: weekend checkboxes (at most three) and the reference month', async () => {
    const checked = [...el().querySelectorAll<HTMLInputElement>('[id^="weekend-"]')].filter((c) => c.checked).map((c) => c.id);
    expect(checked).toEqual(['weekend-5', 'weekend-6']);
    expect(el().querySelector('label[for="weekend-5"]')?.textContent?.trim()).toBe('vendredi');
    const month = el().querySelector('#policy-month') as HTMLSelectElement;
    expect(month.selectedOptions[0]?.textContent?.trim()).toBe('juillet');

    for (const day of [4, 7]) {
      const box = el().querySelector(`#weekend-${day}`) as HTMLInputElement;
      box.click();
    }
    el().querySelector('[data-form="policy"]')?.dispatchEvent(new Event('submit'));
    await settle();
    expect(el().querySelector('[data-error="weekend"]')).not.toBeNull();
    http.expectNone('/api/leave/policy');

    (el().querySelector('#weekend-7') as HTMLInputElement).click();
    (el().querySelector('#weekend-4') as HTMLInputElement).click();
    month.value = month.options[0]?.value ?? '';
    month.dispatchEvent(new Event('change'));
    el().querySelector('[data-form="policy"]')?.dispatchEvent(new Event('submit'));
    const put = http.expectOne('/api/leave/policy');
    expect(put.request.body).toEqual({ referenceStartMonth: 1, weekendDays: [5, 6], entitlementDelayMonths: 12 });
    put.flush(put.request.body);
    await settle();
    http.expectOne('/api/leave/policy').flush(put.request.body);
  });
});
