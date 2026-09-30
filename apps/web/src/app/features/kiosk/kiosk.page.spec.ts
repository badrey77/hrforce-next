import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { attendanceProblem, kioskQr, kioskSession } from '../../../testing/attendance-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { authRefreshInterceptor } from '../../core/auth/auth-refresh.interceptor';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { KIOSK_RELOAD, KioskPage } from './kiosk.page';

const NOW = Date.parse('2026-09-29T07:00:10Z'); // 08:00:10 in Algiers

describe('KioskPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<KioskPage>;
  let reload: ReturnType<typeof vi.fn>;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // jsdom has no 2D canvas: the QR drawing is tested in qr-canvas.spec.ts.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    reload = vi.fn();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        // The real interceptor order of the app: the refresh interceptor must stay out of /api/kiosk/*.
        provideHttpClient(withInterceptors([apiProblemInterceptor, authRefreshInterceptor])),
        provideHttpClientTesting(),
        { provide: KIOSK_RELOAD, useValue: reload },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(KioskPage);
    TestBed.tick();
  });

  afterEach(() => {
    fixture.destroy();
    http.verify();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function running(serverTime = new Date(NOW).toISOString()): void {
    http.expectOne('/api/kiosk/session').flush(kioskSession(serverTime));
    TestBed.tick();
    http.expectOne('/api/kiosk/qr').flush(kioskQr(serverTime));
    TestBed.tick();
  }

  it('pairs an unpaired tablet with a normalised code, then shows the entrance in both languages, the clock and the code', () => {
    const { body, options } = attendanceProblem(401, 'kiosk-unpaired');
    http.expectOne('/api/kiosk/session').flush(body, options);
    http.expectNone('/api/auth/refresh');
    TestBed.tick();
    expect(el().querySelector('[data-state="unpaired"]')).not.toBeNull();
    expect(el().querySelector('[data-state="revoked"]')).toBeNull();

    const input = (el().querySelector<HTMLInputElement>('#kiosk-code') as HTMLInputElement);
    input.value = 'k7m2-9qxa';
    input.dispatchEvent(new Event('input'));
    (el().querySelector<HTMLButtonElement>('[data-action="pair"]') as HTMLButtonElement).click();
    TestBed.tick();
    const pair = http.expectOne('/api/kiosk/pair');
    expect(pair.request.body).toEqual({ code: 'K7M29QXA' });
    pair.flush(kioskSession(new Date(NOW).toISOString()));
    TestBed.tick();
    http.expectOne('/api/kiosk/qr').flush(kioskQr(new Date(NOW).toISOString()));
    TestBed.tick();

    expect(el().querySelector('[data-field="label-fr"]')?.textContent).toBe('Siège — Entrée principale');
    expect(el().querySelector('[data-field="label-ar"]')?.getAttribute('dir')).toBe('rtl');
    expect(el().querySelector('[data-field="clock"]')?.textContent?.trim()).toBe('08:00:10');
    expect(el().querySelector('app-qr-canvas')?.getAttribute('data-window')).toBe(String(Math.floor(NOW / 30_000)));
    const instruction = [...el().querySelectorAll('.instruction p')].map((p) => p.textContent?.trim());
    expect(instruction).toEqual(['Scannez ce code avec l’appareil photo de votre téléphone', 'يرجى مسح هذا الرمز بكاميرا الهاتف']);
  });

  it('says the code is invalid or expired on a 410', () => {
    const { body, options } = attendanceProblem(401, 'kiosk-unpaired');
    http.expectOne('/api/kiosk/session').flush(body, options);
    TestBed.tick();
    const input = (el().querySelector<HTMLInputElement>('#kiosk-code') as HTMLInputElement);
    input.value = 'DEMK-2026';
    input.dispatchEvent(new Event('input'));
    (el().querySelector<HTMLButtonElement>('[data-action="pair"]') as HTMLButtonElement).click();
    const gone = attendanceProblem(410, 'kiosk-pairing-invalid');
    http.expectOne('/api/kiosk/pair').flush(gone.body, gone.options);
    TestBed.tick();
    expect(el().querySelector('.form-error')?.textContent).toContain('Code invalide ou expiré.');
  });

  it('corrects the clock with the server offset and moves to the next window by itself', () => {
    running(new Date(NOW + 5_000).toISOString()); // the tablet is 5 s late
    expect(el().querySelector('[data-field="clock"]')?.textContent?.trim()).toBe('08:00:15');
    const first = el().querySelector('app-qr-canvas')?.getAttribute('data-window');
    vi.advanceTimersByTime(15_000); // 08:00:30 corrected: next window
    TestBed.tick();
    expect(el().querySelector('app-qr-canvas')?.getAttribute('data-window')).toBe(String(Number(first) + 1));
    // The next fetch is due at the window start + the 1 s jitter.
    vi.advanceTimersByTime(1_000);
    http.expectOne('/api/kiosk/qr').flush(kioskQr(new Date(Date.now() + 5_000).toISOString()));
  });

  it('hides the code and shows the bilingual offline message when no held window covers now', () => {
    http.expectOne('/api/kiosk/session').flush(kioskSession(new Date(NOW).toISOString()));
    TestBed.tick();
    const stale = kioskQr(new Date(NOW - 180_000).toISOString());
    http.expectOne('/api/kiosk/qr').flush({ ...stale, serverTime: new Date(NOW).toISOString() });
    TestBed.tick();
    expect(el().querySelector('app-qr-canvas')).toBeNull();
    const offline = [...el().querySelectorAll('[data-state="offline"] p')].map((p) => p.getAttribute('lang'));
    expect(offline).toEqual(['fr', 'ar']);
    // Retries every 5 s.
    vi.advanceTimersByTime(5_000);
    http.expectOne('/api/kiosk/qr').flush(kioskQr(new Date(Date.now()).toISOString()));
    TestBed.tick();
    expect(el().querySelector('app-qr-canvas')).not.toBeNull();
  });

  it('keeps the held codes through a network failure and goes back to pairing on a 401 (revoked)', () => {
    running();
    vi.advanceTimersByTime(21_000);
    http.expectOne('/api/kiosk/qr').error(new ProgressEvent('error'));
    TestBed.tick();
    expect(el().querySelector('app-qr-canvas')).not.toBeNull();
    vi.advanceTimersByTime(5_000);
    const { body, options } = attendanceProblem(401, 'kiosk-unpaired');
    http.expectOne('/api/kiosk/qr').flush(body, options);
    TestBed.tick();
    expect(el().querySelector('[data-state="revoked"]')?.textContent).toContain('Borne désactivée');
  });

  it('reloads the page once a day between 03:00 and 03:05 Algiers', () => {
    fixture.destroy();
    // Destroying the page cancelled its pending session request (takeUntilDestroyed).
    vi.setSystemTime(Date.parse('2026-09-29T01:40:00Z')); // 02:40 Algiers
    fixture = TestBed.createComponent(KioskPage);
    TestBed.tick();
    const { body, options } = attendanceProblem(401, 'kiosk-unpaired');
    http.match('/api/kiosk/session').find((req) => !req.cancelled)?.flush(body, options);
    vi.advanceTimersByTime(19 * 60_000 + 59_000);
    expect(reload).not.toHaveBeenCalled(); // 02:59:59
    vi.advanceTimersByTime(1_000);
    expect(reload).toHaveBeenCalledTimes(1); // 03:00:00, up for 20 minutes
  });
});
