import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { meWith } from '../../../testing/auth-fixtures';
import { SUMMARY } from '../../../testing/deadline-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { HomePage } from './home.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('HomePage — deadlines tile (docs/contracts/contracts-deadlines.md › Web)', () => {
  let fixture: ComponentFixture<HomePage>;
  let http: HttpTestingController;

  async function create(permissions: readonly string[]): Promise<HTMLElement> {
    await TestBed.configureTestingModule({
      imports: [HomePage, translocoTesting()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(permissions));
    fixture = TestBed.createComponent(HomePage);
    await settle();
    http.expectOne((req) => req.url === '/api/tasks').flush({ items: [] });
    http.match((req) => req.url === '/api/me/recruitment/summary').forEach((req) => req.flush({ canRequestOpening: false, openings: 0, pendingOpenings: 0 }));
    await settle();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => http.verify());

  it('with deadline.read: overdue, critical and the next 30 days, each opening the board', async () => {
    const el = await create(['deadline.read']);
    http.expectOne('/api/deadlines/summary').flush(SUMMARY);
    await settle();
    const tile = (name: string) => el.querySelector(`[data-count="${name}"]`) as HTMLAnchorElement;
    expect(tile('deadlines-overdue').textContent).toContain('4');
    expect(tile('deadlines-overdue').getAttribute('href')).toBe('/deadlines');
    expect(tile('deadlines-critical').textContent).toContain('1');
    expect(tile('deadlines-next30').getAttribute('href')).toBe('/deadlines?within=30');
  });

  it('without it: nothing asked, nothing shown', async () => {
    const el = await create(['employee.read']);
    http.match((req) => req.url === '/api/employees').forEach((req) => req.flush({ items: [], total: 0, page: 1, pageSize: 1 }));
    http.expectNone('/api/deadlines/summary');
    await settle();
    expect(el.querySelector('[data-card="deadlines"]')).toBeNull();
  });
});
