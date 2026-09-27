import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ME_FIXTURE, ME_MFA_ON, ME_MFA_REQUIRED } from '../../../testing/auth-fixtures';
import { CODES, ENROLLMENT } from '../../../testing/security-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import type { Me } from '../../core/auth/auth.models';
import type { MfaStatus } from '../../core/auth/mfa.models';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { SecurityPage } from './security.page';

@Component({ selector: 'app-stub', changeDetection: ChangeDetectionStrategy.OnPush, template: 'employees' })
class StubPage {}

const OFF_REQUIRED: MfaStatus = { enabled: false, required: true, enrolledAt: null, recoveryCodesLeft: null };
const OFF_OPTIONAL: MfaStatus = { enabled: false, required: false, enrolledAt: null, recoveryCodesLeft: null };
const ON_OPTIONAL: MfaStatus = { enabled: true, required: false, enrolledAt: '2026-09-01T08:00:00Z', recoveryCodesLeft: 2 };
const ON_REQUIRED: MfaStatus = { ...ON_OPTIONAL, required: true, recoveryCodesLeft: 10 };

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('SecurityPage (/me/security)', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter(
          [
            { path: 'me/security', component: SecurityPage },
            { path: 'employees', component: StubPage },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    TestBed.inject(LanguageService).use('fr', { remember: false });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
  const click = (action: string) => (el().querySelector(`[data-action="${action}"]`) as HTMLButtonElement).click();

  async function open(me: Me, status: MfaStatus, url = '/me/security'): Promise<void> {
    TestBed.inject(Session).set(me);
    await harness.navigateByUrl(url);
    await settle();
    http.expectOne({ method: 'GET', url: '/api/me/mfa' }).flush(status);
    await settle();
  }

  function typeCode(id: string, value: string): void {
    const input = el().querySelector(`#${id}`) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('required and not enrolled: explains why, opens the wizard without Cancel; after enrolling reloads the session and continues to returnUrl', async () => {
    await open(ME_MFA_REQUIRED, OFF_REQUIRED, '/me/security?enroll=1&returnUrl=%2Femployees');

    expect(text('[data-banner="enroll"]')).toContain('Votre entreprise exige la validation en deux étapes');
    expect(text('[data-status="off"]')).toBe('Désactivée.');
    expect(el().querySelector('app-mfa-enroll-wizard')).not.toBeNull();
    expect(el().querySelector('[data-action="open-wizard"]')).toBeNull();
    expect(el().querySelector('[data-section="disable"]')).toBeNull();

    click('start');
    await settle();
    http.expectOne('/api/me/mfa/enroll/start').flush(ENROLLMENT);
    await settle();
    click('next');
    await settle();
    typeCode('wizard-code', '123456');
    el().querySelector('app-mfa-enroll-wizard form')?.dispatchEvent(new Event('submit'));
    await settle();
    http.expectOne('/api/me/mfa/enroll/confirm').flush({ recoveryCodes: CODES });
    await settle();
    (el().querySelector('#wizard-codes-saved') as HTMLInputElement).click();
    await settle();
    click('finish');
    await settle();

    http.expectOne('/api/me').flush(ME_MFA_ON);
    await settle();
    // The page is left right away: its status re-read is cancelled with it (nothing to flush).

    expect(TestBed.inject(Session).mfaEnrollmentRequired()).toBe(false);
    expect(TestBed.inject(Router).url).toBe('/employees');
  });

  it('ignores an external returnUrl after enrolling and just drops ?enroll=1', async () => {
    await open(ME_MFA_REQUIRED, OFF_REQUIRED, '/me/security?enroll=1&returnUrl=https:%2F%2Fevil.example');
    const page = harness.routeDebugElement?.componentInstance as { onEnrolled(): Promise<void> };
    const done = page.onEnrolled();
    await settle();
    http.expectOne('/api/me').flush(ME_MFA_ON);
    await done;
    await settle();
    http.expectOne({ method: 'GET', url: '/api/me/mfa' }).flush(ON_REQUIRED);
    await settle();

    expect(TestBed.inject(Router).url).toBe('/me/security');
    expect(text('.feedback')).toBe('La validation en deux étapes est activée.');
  });

  it('optional and off: "Turn on" opens the wizard, Cancel closes it', async () => {
    await open(ME_FIXTURE, OFF_OPTIONAL);

    expect(el().querySelector('app-mfa-enroll-wizard')).toBeNull();
    expect(text('[data-status="off"] + p')).toContain('Recommandée');
    click('open-wizard');
    await settle();
    expect(el().querySelector('app-mfa-enroll-wizard')).not.toBeNull();
    const cancel = [...el().querySelectorAll('app-mfa-enroll-wizard button')].find((b) => b.textContent?.trim() === 'Annuler');
    (cancel as HTMLButtonElement).click();
    await settle();
    expect(el().querySelector('app-mfa-enroll-wizard')).toBeNull();
  });

  it('enabled: shows since when, warns about few codes left, and hides "disable" when required', async () => {
    await open(ME_MFA_ON, { ...ON_OPTIONAL, required: true });

    expect(text('[data-status="on"]')).toBe('Activée depuis le 1 sept. 2026.');
    expect(text('[data-codes-left]')).toBe('Codes de secours restants : 2. Générez-en de nouveaux bientôt.');
    expect(el().querySelector('[data-section="regenerate"]')).not.toBeNull();
    expect(el().querySelector('[data-section="disable"]')).toBeNull();
  });

  it('regenerates recovery codes with the current code; Done needs the checkbox', async () => {
    await open(ME_MFA_ON, ON_OPTIONAL);
    typeCode('regenerate-code', '654321');
    el().querySelector('[data-section="regenerate"] form')?.dispatchEvent(new Event('submit'));
    await settle();
    const req = http.expectOne({ method: 'POST', url: '/api/me/mfa/recovery-codes' });
    expect(req.request.body).toEqual({ code: '654321' });
    req.flush({ recoveryCodes: CODES });
    await settle();

    expect([...el().querySelectorAll('[data-codes] li')].map((li) => li.textContent?.trim())).toEqual(CODES);
    const done = el().querySelector('[data-action="codes-done"]') as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    (el().querySelector('#new-codes-saved') as HTMLInputElement).click();
    await settle();
    done.click();
    await settle();
    http.expectOne({ method: 'GET', url: '/api/me/mfa' }).flush({ ...ON_OPTIONAL, recoveryCodesLeft: 10 });
    http.expectOne('/api/me').flush(ME_MFA_ON);
    await settle();

    expect(el().querySelector('[data-codes]')).toBeNull();
    expect(text('.feedback')).toBe('Nouveaux codes de secours enregistrés ; les anciens ne fonctionnent plus.');
  });

  it('maps a wrong code on regenerate to the field', async () => {
    await open(ME_MFA_ON, ON_OPTIONAL);
    typeCode('regenerate-code', '000000');
    el().querySelector('[data-section="regenerate"] form')?.dispatchEvent(new Event('submit'));
    await settle();
    http
      .expectOne('/api/me/mfa/recovery-codes')
      .flush({ type: 'urn:hrforce:problem:mfa-invalid', title: 'x', status: 422 }, { status: 422, statusText: 'x' });
    await settle();

    expect(text('#regenerate-code-error')).toBe('Code incorrect ou expiré. Saisissez le code affiché maintenant.');
  });

  it('disables two-step sign-in when optional, then reloads status and session', async () => {
    await open(ME_MFA_ON, ON_OPTIONAL);
    typeCode('disable-code', '111 222');
    el().querySelector('[data-section="disable"] form')?.dispatchEvent(new Event('submit'));
    await settle();
    const req = http.expectOne({ method: 'POST', url: '/api/me/mfa/disable' });
    expect(req.request.body).toEqual({ code: '111222' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    http.expectOne({ method: 'GET', url: '/api/me/mfa' }).flush(OFF_OPTIONAL);
    http.expectOne('/api/me').flush(ME_FIXTURE);
    await settle();

    expect(text('.feedback')).toBe('La validation en deux étapes est désactivée.');
    expect(text('[data-status="off"]')).toBe('Désactivée.');
  });

  it('shows 409 mfa-required-by-policy on disable as a form message', async () => {
    await open(ME_MFA_ON, ON_OPTIONAL);
    typeCode('disable-code', '111222');
    el().querySelector('[data-section="disable"] form')?.dispatchEvent(new Event('submit'));
    await settle();
    http
      .expectOne('/api/me/mfa/disable')
      .flush({ type: 'urn:hrforce:problem:mfa-required-by-policy', title: 'x', status: 409 }, { status: 409, statusText: 'x' });
    await settle();

    expect(text('[data-section="disable"] [role="alert"]')).toBe(
      'Votre entreprise exige la validation en deux étapes : elle ne peut pas être désactivée.',
    );
  });

  it('renders in Arabic with the code field kept LTR', async () => {
    TestBed.inject(LanguageService).use('ar', { remember: false });
    await open(ME_MFA_ON, ON_OPTIONAL);

    expect(text('h1')).toBe('أمان الحساب');
    expect(el().querySelector('#disable-code')?.getAttribute('dir')).toBe('ltr');
  });
});
