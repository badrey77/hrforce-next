import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { meWith } from '../../../testing/auth-fixtures';
import { CLOSED_PERIOD_SUMMARY, OPEN_PERIOD_SUMMARY } from '../../../testing/payroll-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { focusPeriod, HomePayrollTile, previousMonth } from './payroll-tile';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('payroll tile helpers', () => {
  it('goes back one month across a year', () => {
    expect(previousMonth('2026-10')).toBe('2026-09');
    expect(previousMonth('2027-01')).toBe('2026-12');
  });

  it('shows the previous month while it is open, else the current one', () => {
    const septemberOpen = { ...CLOSED_PERIOD_SUMMARY, status: 'open' as const, version: null, closedAt: null, closedBy: null };
    expect(focusPeriod([septemberOpen, OPEN_PERIOD_SUMMARY], '2026-10').month).toBe('2026-09');
    expect(focusPeriod([CLOSED_PERIOD_SUMMARY, OPEN_PERIOD_SUMMARY], '2026-10')).toBe(OPEN_PERIOD_SUMMARY);
    expect(focusPeriod([], '2026-10')).toMatchObject({ month: '2026-10', status: 'open', cutoffDate: '2026-10-20' });
  });
});

describe('HomePayrollTile (docs/contracts/payroll-variables.md › Web)', () => {
  let fixture: ComponentFixture<HomePayrollTile>;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-24T08:00:00Z'), toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    http.verify();
  });

  async function create(permissions: readonly string[]): Promise<HTMLElement> {
    TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(permissions));
    fixture = TestBed.createComponent(HomePayrollTile);
    await settle();
    return fixture.nativeElement as HTMLElement;
  }

  it('with payroll.read: the open month, its cut-off, a link to it', async () => {
    const el = await create(['payroll.read']);
    http.expectOne((r) => r.url === '/api/payroll/periods' && r.params.get('year') === '2026').flush({ items: [CLOSED_PERIOD_SUMMARY, OPEN_PERIOD_SUMMARY] });
    await settle();
    const link = el.querySelector('[data-link="payroll"]');
    expect(link?.getAttribute('href')).toBe('/payroll?month=2026-10');
    expect(link?.textContent).toContain('octobre 2026');
    expect(el.querySelector('[data-status-text]')?.textContent).toContain('clôture possible depuis le 20/10');
  });

  it('a closed month says when', async () => {
    const el = await create(['payroll.read']);
    http.expectOne((r) => r.url === '/api/payroll/periods').flush({
      items: [CLOSED_PERIOD_SUMMARY, { ...OPEN_PERIOD_SUMMARY, status: 'closed', version: 1, closedAt: '2026-10-22T10:00:00Z' }],
    });
    await settle();
    expect(el.querySelector('[data-status-text]')?.textContent).toContain('Clôturée le 22/10/2026');
  });

  it('before the cut-off: « clôture à partir du »', async () => {
    const el = await create(['payroll.read']);
    http.expectOne((r) => r.url === '/api/payroll/periods').flush({ items: [CLOSED_PERIOD_SUMMARY, { ...OPEN_PERIOD_SUMMARY, cutoffDate: '2026-10-28' }] });
    await settle();
    expect(el.querySelector('[data-status-text]')?.textContent).toContain('clôture à partir du 28/10');
  });

  it('without it: nothing asked, nothing shown', async () => {
    const el = await create(['employee.read']);
    http.expectNone((r) => r.url.startsWith('/api/payroll'));
    expect(el.querySelector('[data-card="payroll"]')).toBeNull();
  });
});
