import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { installIntersectionObserver, untilDeferredRequest } from '../../../testing/intersection-observer';
import { flushLeaveTypes, leaveDetail } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LeaveRequestPage } from './leave-request.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('LeaveRequestPage › History', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;


  async function open(permissions: readonly string[]): Promise<void> {
    installIntersectionObserver();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'leave/requests/:id', component: LeaveRequestPage }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(permissions));
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/leave/requests/r-1');
    await settle();
    flushLeaveTypes(http);
    http.expectOne('/api/leave/requests/r-1').flush(leaveDetail({ id: 'r-1' }));
    await settle();
  }

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;

  it('with audit.read: a History section loads the leave_request timeline when it scrolls into view', async () => {
    await open(['leave.read', 'audit.read']);
    expect(el().querySelector('[data-section="history"] h2')?.textContent).toContain('Historique');
    const req = await untilDeferredRequest(http, (r) => r.url === '/api/audit/timeline', settle);
    expect(req.request.params.get('subject')).toBe('leave_request:r-1');
    req.flush({ items: [], nextCursor: null });
    await settle();
  });

  it('without audit.read: no History section, no timeline request', async () => {
    await open(['leave.read']);
    expect(el().querySelector('[data-section="history"]')).toBeNull();
    http.expectNone((r) => r.url === '/api/audit/timeline');
  });
});
