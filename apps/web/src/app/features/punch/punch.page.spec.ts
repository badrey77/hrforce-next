import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { attendanceProblem, day, punch } from '../../../testing/attendance-fixtures';
import { meWith } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { PunchPage } from './punch.page';

@Component({ template: '<p>other page</p>' })
class OtherPage {}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

const SCAN = {
  kiosk: { labels: { fr: 'Agence Annaba — Entrée', ar: 'وكالة عنابة — المدخل' }, site: { code: 'ANNABA', name: 'Annaba' } },
  scannedAt: '2026-09-29T06:52:00Z',
  localTime: '07:52',
  receiptExpiresAt: '2026-09-29T06:57:00Z',
};

describe('PunchPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter(
          [
            { path: 'punch', component: PunchPage },
            { path: 'login', component: OtherPage },
            { path: 'me/attendance', component: OtherPage },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;

  it('reads the token from the fragment, drops it from the URL, scans, then punches (signed in)', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await harness.navigateByUrl('/punch#tok-123');
    await settle();
    expect(router.url).toBe('/punch');
    const scan = http.expectOne('/api/attendance/scan');
    expect(scan.request.body).toEqual({ token: 'tok-123' });
    scan.flush(SCAN);
    await settle();
    expect(el().textContent).toContain('Agence Annaba — Entrée');
    http.expectOne('/api/me/attendance/punches').flush({ punch: punch(), duplicate: false, day: day() }, { status: 201, statusText: 'Created' });
    await settle();

    const done = el().querySelector('[data-state="done"]');
    expect(done?.getAttribute('data-direction')).toBe('in');
    expect(done?.querySelector('h1')?.textContent?.trim()).toBe('Arrivée');
    expect(done?.textContent).toContain('Arrivée enregistrée à 07:52');
    expect(done?.querySelector('[data-state="duplicate"]')).toBeNull();
    expect(done?.querySelector('a')?.getAttribute('href')).toBe('/me/attendance');

    TestBed.inject(LanguageService).use('ar', { remember: false });
    await settle();
    expect(el().querySelector('[data-state="done"] h1')?.textContent?.trim()).toBe('دخول');
    expect(el().textContent).toContain('وكالة عنابة — المدخل');
  });

  it('a new code opened while the page is still on /punch (only the fragment changes) is scanned and punched too', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await harness.navigateByUrl('/punch#tok-morning');
    await settle();
    http.expectOne('/api/attendance/scan').flush(SCAN);
    await settle();
    http.expectOne('/api/me/attendance/punches').flush({ punch: punch(), duplicate: false, day: day() }, { status: 201, statusText: 'Created' });
    await settle();
    expect(el().querySelector('[data-state="done"]')?.getAttribute('data-direction')).toBe('in');

    await harness.navigateByUrl('/punch#tok-evening');
    await settle();
    expect(router.url).toBe('/punch');
    const evening = http.expectOne('/api/attendance/scan');
    expect(evening.request.body).toEqual({ token: 'tok-evening' });
    evening.flush(SCAN);
    await settle();
    http
      .expectOne('/api/me/attendance/punches')
      .flush({ punch: punch({ direction: 'out', localTime: '16:34' }), duplicate: false, day: day() }, { status: 201, statusText: 'Created' });
    await settle();
    expect(el().querySelector('[data-state="done"]')?.getAttribute('data-direction')).toBe('out');
    expect(el().textContent).toContain('Départ enregistré à 16:34');
  });

  it('signed out: scans first, then sends the visitor to /login?returnUrl=/punch without punching', async () => {
    await harness.navigateByUrl('/punch#tok-123');
    await settle();
    http.expectOne('/api/attendance/scan').flush(SCAN);
    await settle();
    expect(router.url).toBe('/login?returnUrl=%2Fpunch');
    http.expectNone('/api/me/attendance/punches');
  });

  it('back from sign-in (no token): redeems the receipt directly and shows a duplicate as already recorded', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await harness.navigateByUrl('/punch');
    await settle();
    http.expectNone('/api/attendance/scan');
    http
      .expectOne('/api/me/attendance/punches')
      .flush({ punch: punch({ direction: 'out', localTime: '16:34' }), duplicate: true, day: day() });
    await settle();
    expect(el().querySelector('[data-state="done"]')?.getAttribute('data-direction')).toBe('out');
    expect(el().textContent).toContain('Départ enregistré à 16:34');
    expect(el().querySelector('[data-state="duplicate"]')?.textContent?.trim()).toBe('Déjà enregistré');
  });

  it('an expired code says to scan again, and nothing is punched', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await harness.navigateByUrl('/punch#old');
    await settle();
    const { body, options } = attendanceProblem(410, 'attendance-qr-expired');
    http.expectOne('/api/attendance/scan').flush(body, options);
    await settle();
    expect(el().querySelector('[data-problem="expired"]')?.textContent).toContain('Veuillez scanner à nouveau le code affiché à l’entrée.');
    http.expectNone('/api/me/attendance/punches');
  });

  it.each([
    ['attendance-no-scan', 409, 'noScan'],
    ['attendance-not-linked', 409, 'notLinked'],
    [null, 403, 'forbidden'],
  ] as const)('explains a %s punch refusal', async (slug, status, problem) => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await harness.navigateByUrl('/punch');
    await settle();
    const { body, options } = attendanceProblem(status, slug);
    http.expectOne('/api/me/attendance/punches').flush(body, options);
    await settle();
    expect(el().querySelector(`[data-problem="${problem}"]`)).not.toBeNull();
    expect(el().querySelector('[data-action="retry"]')).toBeNull();
  });

  it('offers a retry after a network failure (the receipt is still valid)', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await harness.navigateByUrl('/punch');
    await settle();
    http.expectOne('/api/me/attendance/punches').error(new ProgressEvent('error'));
    await settle();
    el().querySelector<HTMLButtonElement>('[data-action="retry"]')?.click();
    await settle();
    http.expectOne('/api/me/attendance/punches').flush({ punch: punch(), duplicate: false, day: day() });
    await settle();
    expect(el().querySelector('[data-state="done"]')).not.toBeNull();
  });
});
