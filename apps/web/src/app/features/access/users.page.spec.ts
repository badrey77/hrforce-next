import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { flushAccessCatalog, grant, USER_NEW, USER_SAMIR, USERS } from '../../../testing/access-fixtures';
import { ME_FIXTURE } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { ACCESS_ROUTES } from './access.routes';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const isUsers = (r: { url: string }) => r.url === '/api/access/users';

describe('Access › Users list', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    // Fake only Date ("today"), and let it advance with real time: RxJS debounceTime compares scheduler.now().
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 8, 26, 10));
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'access', children: ACCESS_ROUTES }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(ME_FIXTURE);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    vi.useRealTimers();
    http.verify();
    TestBed.inject(LanguageService).use('fr');
  });

  const el = () => harness.routeNativeElement as HTMLElement;

  async function open(url: string, items = USERS): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
    http.expectOne(isUsers).flush({ items });
    flushAccessCatalog(http);
    await settle();
  }

  it('/access redirects to the users tab', async () => {
    await open('/access');
    expect(TestBed.inject(Router).url).toBe('/access/users');
    expect(el().querySelector('app-access-nav a[aria-current="page"]')?.textContent?.trim()).toBe('Utilisateurs');
  });

  it('lists members with status and current/future grants as chips (role names in the active language)', async () => {
    const future = grant({ id: 'g-future', userId: 'u-samir', validFrom: '2026-12-01', role: { id: 'role-paie', code: 'GEST-PAIE', names: { fr: 'Gestionnaire paie', ar: 'مسير الأجور', en: 'Payroll officer' } } });
    await open('/access/users', [{ ...USER_SAMIR, grants: [...USER_SAMIR.grants, future] }, USER_NEW]);

    const rows = [...el().querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    const cells = [...(rows[0]?.querySelectorAll('td') ?? [])].map((td) => td.textContent?.replace(/\s+/g, ' ').trim());
    expect(cells.slice(0, 3)).toEqual(['Samir Belkacem', 'lecture.ouest@demo.dz', 'Actif']);
    expect([...(rows[0]?.querySelectorAll('.chips li') ?? [])].map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Lecture · Région Ouest',
      'Gestionnaire paie · Région Ouest (à partir du 2026-12-01)',
    ]);
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/access/users/u-samir');
    expect(rows[1]?.textContent).toContain('Invité');
    expect(rows[1]?.textContent).toContain('Aucun rôle');

    TestBed.inject(LanguageService).use('ar');
    await settle();
    expect(rows[0]?.querySelector('.chips li')?.textContent).toContain('قراءة');
  });

  it('searches through the URL (?q=) and shows "no match"', async () => {
    await open('/access/users');
    const input = el().querySelector('#access-users-q') as HTMLInputElement;
    input.value = ' samir ';
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();

    expect(TestBed.inject(Router).url).toBe('/access/users?q=samir');
    const req = http.expectOne(isUsers);
    expect(req.request.params.get('q')).toBe('samir');
    req.flush({ items: [] });
    await settle();
    expect(el().querySelector('tbody')?.textContent).toContain('Aucun utilisateur ne correspond à « samir ».');
  });

  it('shows a load error with retry', async () => {
    await harness.navigateByUrl('/access/users');
    await settle();
    http.expectOne(isUsers).flush({ type: 'about:blank', title: 'Boom', status: 500 }, { status: 500, statusText: 'Error' });
    flushAccessCatalog(http);
    await settle();

    expect(el().querySelector('[role="alert"]')?.textContent).toContain('Impossible de charger les utilisateurs.');
    (el().querySelector('[role="alert"] button') as HTMLButtonElement).click();
    await settle();
    http.expectOne(isUsers).flush({ items: USERS });
  });
});
