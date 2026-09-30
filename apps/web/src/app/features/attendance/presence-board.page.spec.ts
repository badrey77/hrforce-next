import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { board, day } from '../../../testing/attendance-fixtures';
import { meWith } from '../../../testing/auth-fixtures';
import { SITES } from '../../../testing/org-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { addDays, algiersToday } from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { PresenceBoardPage, PRESENCE_REFRESH_MS } from './presence-board.page';

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

const isBoard = (url: string) => url === '/api/attendance/presence';

describe('PresenceBoardPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'attendance', component: PresenceBoardPage }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    TestBed.inject(Session).set(meWith(['attendance.read', 'site.read', 'employee.read']));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    vi.useRealTimers();
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;

  async function open(url: string, view = board([day(), day({ employee: { ...day().employee, id: 'e-31', matricule: 'EMP-0031' }, status: 'absent', arrival: null, flags: [] })])) {
    await harness.navigateByUrl(url);
    await settle();
    http.expectOne((r) => r.url === '/api/org/sites').flush({ items: SITES });
    const req = http.expectOne((r) => isBoard(r.url));
    req.flush(view);
    await settle();
    return req.request.params;
  }

  it('reads its filters from the URL and sends them to the API', async () => {
    const params = await open('/attendance?date=2026-09-28&siteId=s-cne&status=late&q=saidi&sort=arrival&page=2');
    expect(params.get('date')).toBe('2026-09-28');
    expect(params.get('siteId')).toBe('s-cne');
    expect(params.get('status')).toBe('late');
    expect(params.get('q')).toBe('saidi');
    expect(params.get('sort')).toBe('arrival');
    expect(params.get('page')).toBe('2');
    expect(el().querySelector<HTMLInputElement>('#board-date')?.value).toBe('2026-09-28');
    expect(el().querySelector('[data-status="late"][aria-pressed="true"]')).not.toBeNull();
  });

  it('shows counts and rows, each linking to the employee Présence tab at that date', async () => {
    await open('/attendance');
    expect(el().querySelector('[data-count="total"]')?.textContent).toContain('19');
    const rows = el().querySelectorAll('[data-table="presence"] tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/employees/e-30?tab=attendance&date=2026-09-29');
    expect(rows[0]?.querySelector('[data-flag="open"]')).not.toBeNull();
    expect(rows[1]?.querySelector('app-day-status')?.textContent?.trim()).toBe('Absent');
  });

  it('writes a status chip click and the day buttons to the URL (today = no date param)', async () => {
    await open('/attendance');
    (el().querySelector<HTMLButtonElement>('button[data-status="absent"]') as HTMLButtonElement).click();
    await settle();
    expect(router.url).toBe('/attendance?status=absent');
    http.expectOne((r) => isBoard(r.url)).flush(board([]));
    await settle();

    (el().querySelector<HTMLButtonElement>('[data-action="prev-day"]') as HTMLButtonElement).click();
    await settle();
    expect(router.url).toBe(`/attendance?status=absent&date=${addDays(algiersToday(), -1)}`);
    http.expectOne((r) => isBoard(r.url)).flush(board([], { final: true }));
    await settle();
    (el().querySelector<HTMLButtonElement>('[data-action="next-day"]') as HTMLButtonElement).click();
    await settle();
    expect(router.url).toBe('/attendance?status=absent');
    http.expectOne((r) => isBoard(r.url)).flush(board([]));
  });

  it('reloads today every minute while visible, never a final day', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await open('/attendance');
    vi.advanceTimersByTime(PRESENCE_REFRESH_MS);
    await settle();
    http.expectOne((r) => isBoard(r.url)).flush(board([], { final: true }));
    await settle();
    vi.advanceTimersByTime(PRESENCE_REFRESH_MS);
    await settle();
    http.expectNone((r) => isBoard(r.url));
  });
});
