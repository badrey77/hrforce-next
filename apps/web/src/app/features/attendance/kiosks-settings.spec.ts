import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { attendanceProblem, kioskView } from '../../../testing/attendance-fixtures';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { SITES } from '../../../testing/org-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { countdown, KiosksSettings, networksOf } from './kiosks-settings';

const NOW = Date.parse('2026-09-29T08:00:00Z');

describe('KiosksSettings', () => {
  let fixture: ComponentFixture<KiosksSettings>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setInterval', 'clearInterval', 'Date'] });
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['attendance.configure', 'site.read', 'audit.read']));
    fixture = TestBed.createComponent(KiosksSettings);
    TestBed.tick();
    http.expectOne('/api/org/sites').flush({ items: SITES });
    http.expectOne('/api/attendance/kiosks').flush({
      items: [kioskView(), kioskView({ id: 'k-oran', status: 'revoked', revoked: { at: 'x', by: null, reason: 'Tablette remplacée' }, _actions: [] })],
    });
    TestBed.tick();
    await Promise.resolve(); // the resource publishes its value after a microtask
    TestBed.tick();
  });

  afterEach(() => {
    fixture.destroy();
    http.verify();
    vi.useRealTimers();
  });

  it('parses networks and formats the countdown', () => {
    expect(networksOf(' 41.200.10.0/24 \n\n10.0.0.1, 10.0.0.2')).toEqual(['41.200.10.0/24', '10.0.0.1', '10.0.0.2']);
    expect(countdown(9 * 60_000 + 41_000)).toBe('9:41');
    expect(countdown(-5)).toBe('0:00');
  });

  it('lists kiosks with their state and only the actions the API allows', () => {
    const active = el().querySelector('[data-kiosk="k-hq"]') as HTMLElement;
    expect(active.textContent).toContain('Siège — Entrée principale');
    expect(active.querySelector('[data-action="new-code"]')).not.toBeNull();
    const revoked = el().querySelector('[data-kiosk="k-oran"]') as HTMLElement;
    expect(revoked.textContent).toContain('Tablette remplacée');
    expect(revoked.querySelector('[data-action="revoke"]')).toBeNull();
    expect(revoked.querySelector('[data-action="history"]')).not.toBeNull(); // audit.read
  });

  it('creates a kiosk and shows its one-time pairing code with a live countdown', () => {
    (el().querySelector<HTMLButtonElement>('[data-action="new-kiosk"]') as HTMLButtonElement).click();
    TestBed.tick();
    const set = (id: string, value: string) => {
      const input = el().querySelector<HTMLInputElement | HTMLTextAreaElement>(id) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    set('#kiosk-fr', 'Oran — Entrée');
    set('#kiosk-ar', 'وهران — المدخل');
    set('#kiosk-networks', '41.200.10.0/24');
    (el().querySelector<HTMLButtonElement>('[data-form="kiosk"] button[type="submit"]') as HTMLButtonElement).click();
    TestBed.tick();
    const create = http.expectOne('/api/attendance/kiosks');
    expect(create.request.body).toEqual({ siteId: 's-hq', labels: { fr: 'Oran — Entrée', ar: 'وهران — المدخل' }, allowedNetworks: ['41.200.10.0/24'] });
    create.flush(
      { kiosk: kioskView({ id: 'k-new', status: 'pending', labels: { fr: 'Oran — Entrée', ar: 'وهران — المدخل' } }), pairing: { code: 'K7M29QXA', expiresAt: new Date(NOW + 600_000).toISOString() } },
      { status: 201, statusText: 'Created' },
    );
    TestBed.tick();
    http.expectOne('/api/attendance/kiosks').flush({ items: [] });
    TestBed.tick();
    expect(el().querySelector('[data-field="pairing-code"]')?.textContent?.trim()).toBe('K7M2-9QXA');
    expect(el().querySelector('[data-field="countdown"]')?.textContent).toContain('10:00');
    vi.advanceTimersByTime(19_000);
    TestBed.tick();
    expect(el().querySelector('[data-field="countdown"]')?.textContent).toContain('9:41');
    expect(el().querySelector('[data-panel="pairing"]')?.textContent).toContain('/kiosk');
    vi.advanceTimersByTime(600_000);
    TestBed.tick();
    expect(el().querySelector('[data-field="pairing-code"]')).toBeNull();
    expect(el().querySelector('[data-state="code-expired"]')).not.toBeNull();
  });

  it('revokes with a required reason; an already revoked kiosk is explained', () => {
    (el().querySelector<HTMLButtonElement>('[data-kiosk="k-hq"] [data-action="revoke"]') as HTMLButtonElement).click();
    TestBed.tick();
    const dialog = (el().querySelector<HTMLDialogElement>('dialog') as HTMLDialogElement);
    expect(dialog.open).toBe(true);
    const reason = (dialog.querySelector<HTMLTextAreaElement>('#revoke-reason') as HTMLTextAreaElement);
    reason.value = 'Tablette volée';
    reason.dispatchEvent(new Event('input'));
    (dialog.querySelector<HTMLButtonElement>('[data-action="confirm-revoke"]') as HTMLButtonElement).click();
    TestBed.tick();
    const req = http.expectOne('/api/attendance/kiosks/k-hq/revoke');
    expect(req.request.body).toEqual({ reason: 'Tablette volée' });
    const { body, options } = attendanceProblem(409, 'kiosk-revoked');
    req.flush(body, options);
    TestBed.tick();
    expect(dialog.querySelector('.form-error')?.textContent).toContain('Cette borne est déjà révoquée.');
    http.expectOne('/api/attendance/kiosks').flush({ items: [] });
  });
});
