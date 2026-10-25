import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { meWith } from '../../../testing/auth-fixtures';
import { myProfile } from '../../../testing/profile-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { HomePage } from './home.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('HomePage — « Mon profil » link (docs/contracts/profile-changes.md › Web)', () => {
  let http: HttpTestingController;

  async function create(permissions: readonly string[], linked: boolean): Promise<HTMLElement> {
    await TestBed.configureTestingModule({
      imports: [HomePage, translocoTesting()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(permissions));
    const fixture = TestBed.createComponent(HomePage);
    await settle();
    http.expectOne((req) => req.url === '/api/tasks').flush({ items: [] });
    http.match((req) => req.url === '/api/me/recruitment/summary').forEach((req) => req.flush({ canRequestOpening: false, openings: 0, pendingOpenings: 0 }));
    for (const req of http.match('/api/me/employment')) {
      if (linked) req.flush(myProfile().employee);
      else req.flush({ type: 'urn:hrforce:problem:not-linked', title: 'Not linked', status: 404 }, { status: 404, statusText: 'Not Found' });
    }
    await settle();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => http.verify());

  it('a linked employee with profile.request_self gets the link in « Mon espace »', async () => {
    const el = await create(['profile.request_self'], true);
    const link = el.querySelector<HTMLAnchorElement>('[data-link="my-profile"]');
    expect(link?.getAttribute('href')).toBe('/me/profile');
    expect(link?.textContent).toContain('Mon profil');
  });

  it('no link without a linked employment', async () => {
    const el = await create(['profile.request_self'], false);
    expect(el.querySelector('[data-link="my-profile"]')).toBeNull();
  });
});
