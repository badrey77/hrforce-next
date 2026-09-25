import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { translocoTesting } from '../../../testing/transloco-testing';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { PasswordForgotPage } from './password-forgot.page';

const SENT =
  "Si cette adresse correspond à un compte, un lien pour choisir un nouveau mot de passe vient d'être envoyé. Il est valable une heure.";

describe('PasswordForgotPage', () => {
  let fixture: ComponentFixture<PasswordForgotPage>;
  let el: HTMLElement;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PasswordForgotPage, translocoTesting()],
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PasswordForgotPage);
    el = fixture.nativeElement as HTMLElement;
    http = TestBed.inject(HttpTestingController);
    await fixture.whenStable();
  });

  afterEach(() => http.verify());

  async function submit(email: string): Promise<void> {
    const input = el.querySelector('#forgot-email');
    if (!(input instanceof HTMLInputElement)) throw new Error('missing #forgot-email');
    input.value = email;
    input.dispatchEvent(new Event('input'));
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  const status = (): string => el.querySelector('[role="status"]')?.textContent?.trim() ?? '';

  it('validates the address before sending', async () => {
    await submit('not-an-email');

    expect(el.querySelector('#forgot-email-error')?.textContent?.trim()).toBe('Saisissez une adresse e-mail valide.');
    http.expectNone('/api/auth/password/forgot');
  });

  it('posts the email and shows the neutral confirmation on 202', async () => {
    await submit('rh.admin@demo.dz');
    const req = http.expectOne('/api/auth/password/forgot');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: 'rh.admin@demo.dz' });
    req.flush(null, { status: 202, statusText: 'Accepted' });
    await settle();

    expect(status()).toBe(SENT);
    expect(el.querySelector('form')).toBeNull();
  });

  it('shows the SAME confirmation when the server refuses (no account enumeration)', async () => {
    await submit('nobody@demo.dz');
    http
      .expectOne('/api/auth/password/forgot')
      .flush({ type: 't', title: 'Too Many Requests', status: 429 }, { status: 429, statusText: 'Too Many Requests' });
    await settle();

    expect(status()).toBe(SENT);
  });

  it('asks to retry only when no server answered (network)', async () => {
    await submit('rh.admin@demo.dz');
    http.expectOne('/api/auth/password/forgot').error(new ProgressEvent('error'), { status: 0, statusText: '' });
    await settle();

    expect(el.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      'Impossible de joindre le serveur. Vérifiez votre connexion.',
    );
    expect(el.querySelector('form')).not.toBeNull();
  });
});
