import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { translocoTesting } from '../../../testing/transloco-testing';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LoginPage } from './login.page';

describe('LoginPage', () => {
  let fixture: ComponentFixture<LoginPage>;
  let el: HTMLElement;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LoginPage, translocoTesting()],
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(LoginPage);
    el = fixture.nativeElement as HTMLElement;
    http = TestBed.inject(HttpTestingController);
    await fixture.whenStable();
  });

  afterEach(() => http.verify());

  function input(id: string): HTMLInputElement {
    const found = el.querySelector(`#${id}`);
    if (!(found instanceof HTMLInputElement)) throw new Error(`missing #${id}`);
    return found;
  }

  async function fillAndSubmit(username: string, password: string): Promise<void> {
    input('login-username').value = username;
    input('login-username').dispatchEvent(new Event('input'));
    input('login-password').value = password;
    input('login-password').dispatchEvent(new Event('input'));
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
  }

  it('renders French labels bound to their inputs', () => {
    expect(el.querySelector('label[for="login-username"]')?.textContent?.trim()).toBe("Nom d'utilisateur");
    expect(el.querySelector('label[for="login-password"]')?.textContent?.trim()).toBe('Mot de passe');
  });

  it('shows required errors and sends nothing when empty', async () => {
    await fillAndSubmit('', '');

    expect(el.querySelector('#login-username-error')?.textContent).toContain("Le nom d'utilisateur est obligatoire.");
    expect(input('login-username').getAttribute('aria-invalid')).toBe('true');
    http.expectNone('/api/auth/login');
  });

  it('posts credentials and navigates home on success', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    await fillAndSubmit('alice', 's3cret');
    const req = http.expectOne('/api/auth/login');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ username: 'alice', password: 's3cret' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();

    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('shows invalid-credentials message on 401', async () => {
    await fillAndSubmit('alice', 'wrong');
    http
      .expectOne('/api/auth/login')
      .flush({ type: 'about:blank', title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "Nom d'utilisateur ou mot de passe incorrect.",
    );
  });

  it('shows locked message on 423', async () => {
    await fillAndSubmit('alice', 'x');
    http
      .expectOne('/api/auth/login')
      .flush({ type: 'about:blank', title: 'Locked', status: 423 }, { status: 423, statusText: 'Locked' });
    await fixture.whenStable();

    expect(el.querySelector('[role="alert"]')?.textContent).toContain('verrouillé');
  });

  it('maps 422 field errors onto the controls', async () => {
    await fillAndSubmit('alice', 'x');
    http.expectOne('/api/auth/login').flush(
      {
        type: 'urn:hrforce:problem:validation',
        title: 'Validation failed',
        status: 422,
        errors: [{ field: 'username', code: 'invalid', message: 'Identifiant invalide' }],
      },
      { status: 422, statusText: 'Unprocessable Content' },
    );
    await fixture.whenStable();

    expect(el.querySelector('#login-username-error')?.textContent?.trim()).toBe('Identifiant invalide');
  });
});
