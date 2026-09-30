import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { attendanceProblem, day, punch } from '../../../testing/attendance-fixtures';
import { meWith } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import type { ReceiptView, ScanView } from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { PunchPage, receiptTimeLeft } from './punch.page';

@Component({ template: '<p>other page</p>' })
class OtherPage {}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

const KIOSK = { labels: { fr: 'Agence Annaba — Entrée', ar: 'وكالة عنابة — المدخل' }, site: { code: 'ANNABA', name: 'Annaba' } };
const SCANNED_AT = '2026-09-29T06:52:00.000Z';

function scanView(extra: Partial<ScanView> = {}): ScanView {
  return { kiosk: KIOSK, scannedAt: SCANNED_AT, localTime: '07:52', receiptExpiresAt: '2026-09-29T06:54:00.000Z', ...extra };
}

/** `GET /me/attendance/receipt`: the same scan, 2-minute receipt, the direction the punch would get. */
function receiptView(extra: Partial<ReceiptView> = {}): ReceiptView {
  return {
    kiosk: KIOSK,
    scannedAt: SCANNED_AT,
    localTime: '07:52',
    workDate: '2026-09-29',
    receiptExpiresAt: '2026-09-29T06:54:00.000Z',
    direction: 'in',
    duplicate: false,
    ...extra,
  };
}

const PUNCHED = { punch: punch(), duplicate: false, day: day() };
const RECEIPT = '/api/me/attendance/receipt';
const PUNCHES = '/api/me/attendance/punches';

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
            { path: '', component: OtherPage },
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
  const confirmButton = () => el().querySelector<HTMLButtonElement>('[data-action="confirm-punch"]');

  async function tap(): Promise<void> {
    confirmButton()?.click();
    await settle();
  }

  /** Scans `token` while signed in and answers the receipt read. */
  async function scanAndAsk(token: string, receipt: ReceiptView = receiptView(), scan: ScanView = scanView()): Promise<void> {
    await harness.navigateByUrl(`/punch#${token}`);
    await settle();
    http.expectOne('/api/attendance/scan').flush(scan);
    await settle();
    http.expectOne(RECEIPT).flush(receipt);
    await settle();
  }

  it('reads the token from the fragment, drops it, scans, reads the receipt, then ASKS — only the tap punches', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await harness.navigateByUrl('/punch#tok-123');
    await settle();
    expect(router.url).toBe('/punch');
    const scan = http.expectOne('/api/attendance/scan');
    expect(scan.request.body).toEqual({ token: 'tok-123' });
    scan.flush(scanView());
    await settle();
    const receipt = http.expectOne(RECEIPT);
    expect(receipt.request.method).toBe('GET');
    receipt.flush(receiptView());
    await settle();

    // The link alone recorded nothing: a question and one button, focused.
    http.expectNone(PUNCHES);
    const confirm = el().querySelector('[data-state="confirm"]') as HTMLElement;
    expect(confirm.getAttribute('data-direction')).toBe('in');
    expect(confirm.querySelector('h1')?.textContent).toContain('Enregistrer mon arrivée à');
    expect(confirm.querySelector('h1')?.textContent).toContain('Agence Annaba — Entrée');
    expect(confirm.textContent).toContain('Code scanné à 07:52');
    expect(document.activeElement).toBe(confirmButton());

    await tap();
    http.expectOne(PUNCHES).flush(PUNCHED, { status: 201, statusText: 'Created' });
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

  it('words the question as a departure when the receipt says so (fr / ar)', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await scanAndAsk('tok-evening', receiptView({ direction: 'out', localTime: '16:34' }));
    expect(el().querySelector('[data-state="confirm"] h1')?.textContent).toContain('Enregistrer mon départ à');
    TestBed.inject(LanguageService).use('ar', { remember: false });
    await settle();
    expect(el().querySelector('[data-state="confirm"] h1')?.textContent).toContain('تسجيل المغادرة عند');
    expect(el().querySelector('[data-state="confirm"] h1')?.textContent).toContain('وكالة عنابة — المدخل');
  });

  it('a duplicate receipt says « Déjà enregistré » with no button, and never punches', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await scanAndAsk('tok-again', receiptView({ duplicate: true }));
    const already = el().querySelector('[data-state="already"]');
    expect(already?.querySelector('[data-state="duplicate"]')?.textContent?.trim()).toBe('Déjà enregistré');
    expect(already?.textContent).toContain('07:52');
    expect(confirmButton()).toBeNull();
    http.expectNone(PUNCHES);
  });

  it('a new code opened while the page is still on /punch (only the fragment changes) is scanned and asked again', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await scanAndAsk('tok-morning');
    await tap();
    http.expectOne(PUNCHES).flush(PUNCHED, { status: 201, statusText: 'Created' });
    await settle();
    expect(el().querySelector('[data-state="done"]')?.getAttribute('data-direction')).toBe('in');

    await harness.navigateByUrl('/punch#tok-evening');
    await settle();
    expect(router.url).toBe('/punch');
    const evening = http.expectOne('/api/attendance/scan');
    expect(evening.request.body).toEqual({ token: 'tok-evening' });
    evening.flush(scanView({ localTime: '16:34' }));
    await settle();
    http.expectOne(RECEIPT).flush(receiptView({ localTime: '16:34', direction: 'out' }));
    await settle();
    http.expectNone(PUNCHES);
    expect(el().querySelector('[data-state="confirm"]')?.getAttribute('data-direction')).toBe('out');
    expect(document.activeElement).toBe(confirmButton());
    await tap();
    http.expectOne(PUNCHES).flush({ punch: punch({ direction: 'out', localTime: '16:34' }), duplicate: false, day: day() }, { status: 201, statusText: 'Created' });
    await settle();
    expect(el().querySelector('[data-state="done"]')?.getAttribute('data-direction')).toBe('out');
    expect(el().textContent).toContain('Départ enregistré à 16:34');
  });

  it('signed out: scans first, then sends the visitor to /login?returnUrl=/punch, reading nothing else', async () => {
    await harness.navigateByUrl('/punch#tok-123');
    await settle();
    http.expectOne('/api/attendance/scan').flush(scanView());
    await settle();
    expect(router.url).toBe('/login?returnUrl=%2Fpunch');
    http.expectNone(RECEIPT);
    http.expectNone(PUNCHES);
  });

  it('back from sign-in (no token): reads the receipt, asks with its entrance, then redeems on the tap', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await harness.navigateByUrl('/punch');
    await settle();
    http.expectNone('/api/attendance/scan');
    http.expectOne(RECEIPT).flush(receiptView({ receiptExpiresAt: new Date(Date.now() + 60_000).toISOString() }));
    await settle();
    http.expectNone(PUNCHES);
    expect(el().querySelector('[data-state="confirm"] h1')?.textContent).toContain('Agence Annaba — Entrée');
    await tap();
    http.expectOne(PUNCHES).flush({ punch: punch({ direction: 'in' }), duplicate: false, day: day() }, { status: 201, statusText: 'Created' });
    await settle();
    expect(el().querySelector('[data-state="done"]')).not.toBeNull();
  });

  it('back from sign-in without any scan: « aucun scan », nothing to confirm', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await harness.navigateByUrl('/punch');
    await settle();
    const { body, options } = attendanceProblem(409, 'attendance-no-scan');
    http.expectOne(RECEIPT).flush(body, options);
    await settle();
    expect(el().querySelector('[data-problem="noScan"]')?.textContent).toContain('Veuillez scanner à nouveau');
    expect(confirmButton()).toBeNull();
  });

  it('a tap after the 2-minute receipt ended shows "code expiré" (from the API)', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await scanAndAsk('tok-1');
    await tap();
    const { body, options } = attendanceProblem(409, 'attendance-no-scan');
    http.expectOne(PUNCHES).flush(body, options);
    await settle();
    const problem = el().querySelector('[data-problem="expired"]');
    expect(problem?.querySelector('h1')?.textContent).toContain('Code expiré');
    expect(problem?.textContent).toContain('Veuillez scanner à nouveau');
  });

  it('switches to "code expiré" by itself when the receipt ends before the tap, and never punches', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    // A receipt that ends 500 ms after the scan (the timer counts the receipt's own lifetime on this device's clock).
    const short = { receiptExpiresAt: '2026-09-29T06:52:00.500Z' };
    await scanAndAsk('tok-1', receiptView(short), scanView(short));
    expect(el().querySelector('[data-state="confirm"]')).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await settle();
    expect(el().querySelector('[data-problem="expired"]')).not.toBeNull();
    expect(confirmButton()).toBeNull();
    http.expectNone(PUNCHES);
  });

  it('receiptTimeLeft: the scan answered here counts from its arrival; else the device clock, capped at 2 minutes', () => {
    const receipt = receiptView();
    expect(receiptTimeLeft(receipt, { view: scanView(), at: 1_000 }, 31_000)).toBe(90_000);
    const now = Date.parse('2026-09-29T06:53:00.000Z');
    expect(receiptTimeLeft(receipt, null, now)).toBe(60_000);
    expect(receiptTimeLeft(receipt, null, now - 3_600_000)).toBe(120_000); // device clock an hour behind: capped
    expect(receiptTimeLeft(receipt, null, now + 3_600_000)).toBeNull(); // device clock ahead: let the API decide
  });

  it('an expired code at the scan says to scan again, and nothing is read or punched', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await harness.navigateByUrl('/punch#old');
    await settle();
    const { body, options } = attendanceProblem(410, 'attendance-qr-expired');
    http.expectOne('/api/attendance/scan').flush(body, options);
    await settle();
    expect(el().querySelector('[data-problem="expired"]')?.textContent).toContain('Veuillez scanner à nouveau le code affiché à l’entrée.');
    http.expectNone(RECEIPT);
    http.expectNone(PUNCHES);
  });

  it.each([
    ['attendance-not-linked', 409, 'notLinked'],
    ['attendance-not-employed', 409, 'notEmployed'],
    [null, 403, 'forbidden'],
  ] as const)('explains a %s refusal of the receipt', async (slug, status, problem) => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await harness.navigateByUrl('/punch');
    await settle();
    const { body, options } = attendanceProblem(status, slug);
    http.expectOne(RECEIPT).flush(body, options);
    await settle();
    expect(el().querySelector(`[data-problem="${problem}"]`)).not.toBeNull();
    expect(el().querySelector('[data-action="retry"]')).toBeNull();
  });

  it('offers a retry after a network failure of the punch (the receipt may still be valid)', async () => {
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    await scanAndAsk('tok-1');
    await tap();
    http.expectOne(PUNCHES).error(new ProgressEvent('error'));
    await settle();
    expect(el().textContent).toContain('2 minutes');
    el().querySelector<HTMLButtonElement>('[data-action="retry"]')?.click();
    await settle();
    http.expectOne(PUNCHES).flush(PUNCHED);
    await settle();
    expect(el().querySelector('[data-state="done"]')).not.toBeNull();
  });
});
