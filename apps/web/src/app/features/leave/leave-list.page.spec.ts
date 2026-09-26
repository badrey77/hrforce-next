import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { flushLeaveTypes, leaveSummary } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LEAVE_ROUTES } from './leave.routes';
import { LEAVE_SEARCH_DEBOUNCE_MS } from './leave-list.page';
import { resolveLeaveQuery, toLeaveQueryParams } from './leave-list-state';

const isList = (r: { url: string }) => r.url === '/api/leave/requests';
const url = () => TestBed.inject(Router).url;

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('leave list URL state', () => {
  it('parses defensively and writes only what differs from the default', () => {
    expect(resolveLeaveQuery({ status: 'bogus', page: '-2', pageSize: '500', from: '2026-02-30' })).toMatchObject({
      status: 'all',
      page: 1,
      pageSize: 25,
      from: null,
    });
    expect(resolveLeaveQuery({ status: 'pending', includeSubUnits: 'false', unitId: 'u' })).toMatchObject({
      status: 'pending',
      includeSubUnits: false,
      unitId: 'u',
    });
    expect(toLeaveQueryParams({ status: 'all', page: 1, typeId: 't-sick', q: '' })).toEqual({ status: null, page: null, typeId: 't-sick', q: null });
  });
});

describe('LeaveListPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'leave', children: LEAVE_ROUTES }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['leave.read', 'leave.configure']));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;

  async function open(path = '/leave'): Promise<void> {
    await harness.navigateByUrl(path);
    await settle();
    flushLeaveTypes(http);
  }

  it('reads the filters from the URL and shows the scoped list', async () => {
    await open('/leave?status=pending&typeId=t-annual&page=2');
    const req = http.expectOne(isList);
    expect(req.request.params.get('status')).toBe('pending');
    expect(req.request.params.get('typeId')).toBe('t-annual');
    expect(req.request.params.get('page')).toBe('2');
    req.flush({ items: [leaveSummary()], total: 30, page: 2, pageSize: 25 });
    await settle();
    expect((el().querySelector('#leave-status') as HTMLSelectElement).value).toBe('pending');
    expect((el().querySelector('#leave-type') as HTMLSelectElement).value).toBe('t-annual');
    const row = el().querySelector('[data-request="r-1"]');
    expect(row?.querySelector('a')?.getAttribute('href')).toBe('/leave/requests/r-1');
    expect(row?.textContent).toContain('Congé annuel');
    expect(row?.textContent).toContain('RH régionales');
    expect(el().querySelector('[data-action="settings"]')).not.toBeNull();
  });

  it('writes filter changes to the URL (page back to 1), search debounced with replaceUrl', async () => {
    await open('/leave?page=3');
    http.expectOne(isList).flush({ items: [leaveSummary()], total: 80, page: 3, pageSize: 25 });
    await settle();

    const status = el().querySelector('#leave-status') as HTMLSelectElement;
    status.value = 'approved';
    status.dispatchEvent(new Event('change'));
    await settle();
    expect(url()).toBe('/leave?status=approved');
    http.expectOne(isList).flush({ items: [], total: 0, page: 1, pageSize: 25 });
    await settle();
    expect(el().querySelector('[data-state="no-match"]')).not.toBeNull();

    const replace = vi.spyOn(TestBed.inject(Router), 'navigate');
    const q = el().querySelector('#leave-q') as HTMLInputElement;
    q.value = 'benali';
    q.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, LEAVE_SEARCH_DEBOUNCE_MS + 20));
    await settle();
    expect(url()).toBe('/leave?status=approved&q=benali');
    expect(replace.mock.calls.at(-1)?.[1]).toMatchObject({ replaceUrl: true });
    http.expectOne(isList).flush({ items: [], total: 0, page: 1, pageSize: 25 });
    await settle();

    (el().querySelector('[data-action="clear"]') as HTMLButtonElement).click();
    await settle();
    expect(url()).toBe('/leave');
    http.expectOne(isList).flush({ items: [], total: 0, page: 1, pageSize: 25 });
  });

  it('the list does not exist without leave.read', async () => {
    TestBed.inject(Session).set(meWith(['leave.configure']));
    await harness.navigateByUrl('/leave').catch(() => undefined);
    await settle();
    http.expectNone(isList);
  });
});
