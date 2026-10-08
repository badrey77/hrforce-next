import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { meWith } from '../../../testing/auth-fixtures';
import { SUMMARY } from '../../../testing/recruitment-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { HomePage } from './home.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('HomePage — recruitment counts (docs/contracts/recruitment.md › Web › Home)', () => {
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
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => http.verify());

  it('HR: openings pending / open and applications per active stage, each a link to the filtered list', async () => {
    const el = await create(['recruitment.read']);
    http.expectOne('/api/recruitment/summary').flush(SUMMARY);
    http.expectOne('/api/me/recruitment/summary').flush({ canRequestOpening: true, openings: 0, pendingOpenings: 0 });
    await settle();
    const link = (name: string) => el.querySelector(`[data-count="${name}"]`) as HTMLAnchorElement;
    expect(link('pending').getAttribute('href')).toBe('/recruitment?status=pending');
    expect(link('pending').textContent).toContain('1');
    expect(link('open').getAttribute('href')).toBe('/recruitment?status=open');
    expect(link('open').textContent).toContain('2');
    expect(link('received').getAttribute('href')).toBe('/recruitment/candidates?stage=received');
    expect(link('received').textContent).toContain('4');
    expect(link('interview').textContent).toContain('2');
    // HR uses « Recrutement »: no personal line.
    expect(el.querySelector('[data-card="my-recruitment"]')).toBeNull();
  });

  it('a unit head: the « Mes recrutements » line with the pending requests; the HR counts are not even asked', async () => {
    const el = await create([]);
    http.expectNone('/api/recruitment/summary');
    http.expectOne('/api/me/recruitment/summary').flush({ canRequestOpening: true, openings: 3, pendingOpenings: 2 });
    await settle();
    const line = el.querySelector('[data-card="my-recruitment"]') as HTMLElement;
    expect(line.querySelector('a')?.getAttribute('href')).toBe('/me/recruitment');
    expect(line.textContent).toContain('2 demande(s) en attente');
    expect(el.querySelector('[data-card="recruitment"]')).toBeNull();
  });

  it('a user with nothing sees neither', async () => {
    const el = await create([]);
    http.expectOne('/api/me/recruitment/summary').flush({ canRequestOpening: false, openings: 0, pendingOpenings: 0 });
    await settle();
    expect(el.querySelector('[data-card="my-recruitment"]')).toBeNull();
    expect(el.querySelector('[data-card="recruitment"]')).toBeNull();
  });
});
