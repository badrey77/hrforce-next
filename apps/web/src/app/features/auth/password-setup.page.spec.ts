import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, FormGroup } from '@angular/forms';
import { provideRouter } from '@angular/router';
import { ME_FIXTURE } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { passwordsMatch } from './password-rules';
import { PasswordSetupPage } from './password-setup.page';

const GOOD = 'correct horse battery';

describe('PasswordSetupPage', () => {
  let fixture: ComponentFixture<PasswordSetupPage>;
  let el: HTMLElement;
  let http: HttpTestingController;

  async function create(token: string | undefined): Promise<void> {
    fixture = TestBed.createComponent(PasswordSetupPage);
    if (token !== undefined) fixture.componentRef.setInput('token', token);
    el = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PasswordSetupPage, translocoTesting()],
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  function type(id: string, value: string): void {
    const input = el.querySelector(`#${id}`);
    if (!(input instanceof HTMLInputElement)) throw new Error(`missing #${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
  }

  async function submit(password: string, confirm: string): Promise<void> {
    type('setup-password', password);
    type('setup-confirm', confirm);
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
  }

  const text = (selector: string): string => el.querySelector(selector)?.textContent?.trim() ?? '';

  it('uses the one wording "Choose your password" and shows the server rules as hints', async () => {
    await create('tok');

    expect(text('h1')).toBe('Choisissez votre mot de passe');
    expect(text('#setup-hints')).toContain('Entre 12 et 128 caractères');
  });

  it('flags a mismatching confirmation (group-level validator) and sends nothing', async () => {
    await create('tok');
    await submit(GOOD, `${GOOD}!`);

    expect(text('#setup-confirm-error')).toBe('Les deux mots de passe ne sont pas identiques.');
    expect(el.querySelector('#setup-confirm')?.getAttribute('aria-invalid')).toBe('true');
    http.expectNone('/api/auth/password/setup');
  });

  it('checks the 12-character minimum client-side', async () => {
    await create('tok');
    await submit('short', 'short');

    expect(text('#setup-password-error')).toBe('Au moins 12 caractères.');
    http.expectNone('/api/auth/password/setup');
  });

  it('posts token + password, clears the session and confirms', async () => {
    TestBed.inject(Session).set(ME_FIXTURE);
    await create('tok-123');
    await submit(GOOD, GOOD);
    const req = http.expectOne('/api/auth/password/setup');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ token: 'tok-123', password: GOOD });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await settle();

    expect(text('[role="status"]')).toContain('Votre mot de passe est enregistré.');
    expect(el.querySelector('a[href="/login"]')).not.toBeNull();
    expect(TestBed.inject(Session).isAuthenticated()).toBe(false);
  });

  it.each([
    ['contains_email', 'Le mot de passe ne doit pas contenir votre adresse e-mail.'],
    ['common', 'Ce mot de passe est trop courant. Choisissez-en un autre.'],
    ['too_short', 'Ce mot de passe est trop court.'],
    ['too_long', 'Ce mot de passe est trop long.'],
    ['brand_new_rule', 'Server says no'],
  ])('translates the server 422 code %s', async (code, expected) => {
    await create('tok');
    await submit(GOOD, GOOD);
    http.expectOne('/api/auth/password/setup').flush(
      {
        type: 'urn:hrforce:problem:validation',
        title: 'Validation failed',
        status: 422,
        errors: [{ field: 'password', code, message: 'Server says no' }],
      },
      { status: 422, statusText: 'Unprocessable Content' },
    );
    await settle();

    expect(text('#setup-password-error')).toBe(expected);
  });

  it('410 → "link invalid or expired" with a link to /password/forgot', async () => {
    await create('used-token');
    await submit(GOOD, GOOD);
    http
      .expectOne('/api/auth/password/setup')
      .flush(
        { type: 'urn:hrforce:problem:token-invalid', title: 'Gone', status: 410 },
        { status: 410, statusText: 'Gone' },
      );
    await settle();

    expect(text('[role="alert"]')).toBe('Ce lien est invalide ou a expiré.');
    expect(el.querySelector('a[href="/password/forgot"]')?.textContent?.trim()).toBe('Demander un nouveau lien');
    expect(el.querySelector('form')).toBeNull();
  });

  it('shows the invalid-link state straight away when the URL has no token', async () => {
    await create(undefined);

    expect(text('[role="alert"]')).toBe('Ce lien est invalide ou a expiré.');
    expect(el.querySelector('form')).toBeNull();
  });
});

function group(password: string, confirm: string) {
  return new FormGroup(
    { password: new FormControl(password), confirm: new FormControl(confirm) },
    { validators: [passwordsMatch] },
  );
}

describe('passwordsMatch (FormGroup validator)', () => {
  it('puts the error on the GROUP, not on a control', () => {
    const form = group('a', 'b');

    expect(form.errors).toEqual({ passwordMismatch: true });
    expect(form.controls.confirm.errors).toBeNull();
  });

  it('passes when equal, and leaves an empty confirm to `required`', () => {
    expect(group('a', 'a').errors).toBeNull();
    expect(group('a', '').errors).toBeNull();
  });

  it('re-runs when either field changes', () => {
    const form = group('a', 'a');
    form.controls.password.setValue('changed');

    expect(form.hasError('passwordMismatch')).toBe(true);
  });
});
