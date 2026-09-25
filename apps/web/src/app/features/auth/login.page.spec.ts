import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ME_AR, ME_FIXTURE } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { authRefreshInterceptor } from '../../core/auth/auth-refresh.interceptor';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LANGUAGE_STORAGE_KEY, LanguageService } from '../../core/i18n/language.service';
import { LoginPage } from './login.page';

describe('LoginPage', () => {
  let fixture: ComponentFixture<LoginPage>;
  let el: HTMLElement;
  let http: HttpTestingController;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [LoginPage, translocoTesting()],
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([apiProblemInterceptor, authRefreshInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    TestBed.inject(LanguageService).use('fr', { remember: false });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fixture = TestBed.createComponent(LoginPage);
    el = fixture.nativeElement as HTMLElement;
    http = TestBed.inject(HttpTestingController);
    await fixture.whenStable();
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  /** `submit()` is async: let its awaited steps run, then let the view catch up. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  function input(id: string): HTMLInputElement {
    const found = el.querySelector(`#${id}`);
    if (!(found instanceof HTMLInputElement)) throw new Error(`missing #${id}`);
    return found;
  }

  async function fillAndSubmit(email: string, password: string): Promise<void> {
    input('login-email').value = email;
    input('login-email').dispatchEvent(new Event('input'));
    input('login-password').value = password;
    input('login-password').dispatchEvent(new Event('input'));
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
  }

  /** Answers the login POST with an error and returns the form-level alert text. */
  async function failLogin(status: number, type: string, headers: Record<string, string> = {}): Promise<string> {
    await fillAndSubmit('rh.admin@demo.dz', 'wrong-password');
    http
      .expectOne('/api/auth/login')
      .flush({ type, title: 'x', status }, { status, statusText: 'Error', headers });
    await settle();
    return el.querySelector('[role="alert"]')?.textContent?.trim() ?? '';
  }

  /** Login succeeds, then GET /api/me answers `me`. */
  async function succeed(me = ME_FIXTURE): Promise<void> {
    await fillAndSubmit('rh.admin@demo.dz', 'demo-password-2026');
    const login = http.expectOne('/api/auth/login');
    expect(login.request.method).toBe('POST');
    expect(login.request.body).toEqual({ email: 'rh.admin@demo.dz', password: 'demo-password-2026' });
    login.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    http.expectOne('/api/me').flush(me);
    await settle();
  }

  it('renders French labels bound to their inputs and a forgot-password link', () => {
    expect(el.querySelector('label[for="login-email"]')?.textContent?.trim()).toBe('Adresse e-mail');
    expect(el.querySelector('label[for="login-password"]')?.textContent?.trim()).toBe('Mot de passe');
    expect(el.querySelector('a[href="/password/forgot"]')?.textContent?.trim()).toBe('Mot de passe oublié ?');
  });

  it('shows required errors and sends nothing when empty', async () => {
    await fillAndSubmit('', '');

    expect(el.querySelector('#login-email-error')?.textContent).toContain("L'adresse e-mail est obligatoire.");
    expect(input('login-email').getAttribute('aria-invalid')).toBe('true');
    http.expectNone('/api/auth/login');
  });

  it('signs in, loads the session and goes home when there is no returnUrl', async () => {
    await succeed();

    expect(TestBed.inject(Session).user()?.displayName).toBe('Amina Benali');
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('goes to a valid internal returnUrl', async () => {
    fixture.componentRef.setInput('returnUrl', '/organization?asOf=2025-01-31');
    await succeed();

    expect(navigate).toHaveBeenCalledWith('/organization?asOf=2025-01-31');
  });

  it.each(['https://evil.example/', '//evil.example', '/\\evil.example'])(
    'ignores the external returnUrl %s and goes home (open redirect)',
    async (returnUrl) => {
      fixture.componentRef.setInput('returnUrl', returnUrl);
      await succeed();

      expect(navigate).toHaveBeenCalledWith('/');
    },
  );

  it("switches to the account's locale when no language was chosen on this device", async () => {
    await succeed(ME_AR);

    expect(TestBed.inject(LanguageService).current()).toBe('ar');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });

  it('keeps the language chosen on this device', async () => {
    TestBed.inject(LanguageService).use('en'); // stored, as the language switcher does
    await succeed(ME_AR);

    expect(TestBed.inject(LanguageService).current()).toBe('en');
  });

  it('shows invalid credentials on 401 (no refresh attempted for /api/auth/*)', async () => {
    const text = await failLogin(401, 'urn:hrforce:problem:invalid-credentials');

    expect(text).toBe('Adresse e-mail ou mot de passe incorrect.');
    http.expectNone('/api/auth/refresh');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the lock with minutes from Retry-After on 423', async () => {
    const text = await failLogin(423, 'urn:hrforce:problem:account-locked', { 'Retry-After': '540' });

    expect(text).toBe('Trop de tentatives échouées pour ce compte. Réessayez dans 9 min.');
  });

  it('rounds Retry-After up to whole minutes on 429', async () => {
    const text = await failLogin(429, 'urn:hrforce:problem:too-many-attempts', { 'Retry-After': '61' });

    expect(text).toBe('Trop de tentatives de connexion depuis ce réseau. Réessayez dans 2 min.');
  });

  it('falls back to the 15-minute window when Retry-After is missing', async () => {
    const text = await failLogin(423, 'urn:hrforce:problem:account-locked');

    expect(text).toContain('15 min');
  });

  it('shows the disabled-account message on 403 account-disabled', async () => {
    const text = await failLogin(403, 'urn:hrforce:problem:account-disabled');

    expect(text).toBe('Ce compte est désactivé. Contactez votre administrateur.');
  });

  it('does not call an XSRF 403 a disabled account', async () => {
    const text = await failLogin(403, 'urn:hrforce:problem:xsrf');

    expect(text).toBe("Une erreur inattendue s'est produite. Veuillez réessayer.");
  });

  it('shows the locked message in Arabic with the same minutes', async () => {
    TestBed.inject(LanguageService).use('ar', { remember: false });
    const text = await failLogin(423, 'urn:hrforce:problem:account-locked', { 'Retry-After': '900' });

    expect(text).toBe('محاولات فاشلة كثيرة لهذا الحساب. أعد المحاولة بعد 15 دقيقة.');
  });

  it('maps 422 field errors onto the controls', async () => {
    await fillAndSubmit('rh.admin@demo.dz', 'x');
    http.expectOne('/api/auth/login').flush(
      {
        type: 'urn:hrforce:problem:validation',
        title: 'Validation failed',
        status: 422,
        errors: [{ field: 'email', code: 'invalid', message: 'Adresse invalide' }],
      },
      { status: 422, statusText: 'Unprocessable Content' },
    );
    await settle();

    expect(el.querySelector('#login-email-error')?.textContent?.trim()).toBe('Adresse invalide');
  });
});
