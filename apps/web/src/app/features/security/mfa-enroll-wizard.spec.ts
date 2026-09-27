import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { CODES, ENROLLMENT } from '../../../testing/security-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { groupSecret, MfaEnrollWizard } from './mfa-enroll-wizard';
import { RECOVERY_CODES_FILE } from './recovery-codes';


describe('MfaEnrollWizard', () => {
  let fixture: ComponentFixture<MfaEnrollWizard>;
  let el: HTMLElement;
  let http: HttpTestingController;
  let finished: number;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MfaEnrollWizard, translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(LanguageService).use('fr', { remember: false });
    fixture = TestBed.createComponent(MfaEnrollWizard);
    el = fixture.nativeElement as HTMLElement;
    http = TestBed.inject(HttpTestingController);
    finished = 0;
    fixture.componentInstance.finished.subscribe(() => finished++);
    await fixture.whenStable();
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }
  const click = (action: string) => (el.querySelector(`[data-action="${action}"]`) as HTMLButtonElement).click();
  const state = () => el.querySelector('section')?.getAttribute('data-state');
  const current = () => el.querySelector('[aria-current="step"]')?.textContent?.replace(/\s+/g, ' ').trim();

  async function toScan(): Promise<void> {
    click('start');
    await settle();
    http.expectOne({ method: 'POST', url: '/api/me/mfa/enroll/start' }).flush(ENROLLMENT);
    await settle();
  }

  async function toCodes(): Promise<void> {
    await toScan();
    click('next');
    await settle();
    const code = el.querySelector('#wizard-code') as HTMLInputElement;
    code.value = '123456';
    code.dispatchEvent(new Event('input'));
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
    http.expectOne('/api/me/mfa/enroll/confirm').flush({ recoveryCodes: CODES });
    await settle();
  }

  it('groups the secret in fours', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(groupSecret('ABCDEF')).toBe('ABCD EF');
  });

  it('intro → scan: shows the QR as an <img> from the PNG data URL and the grouped secret (LTR); heading focused', async () => {
    expect(state()).toBe('intro');
    await toScan();

    expect(state()).toBe('scan');
    expect(current()).toBe('1 Scanner le code');
    const img = el.querySelector('img.qr') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(ENROLLMENT.qrPng); // not rewritten to "unsafe:" by the sanitizer
    expect(img.alt).toContain('Code QR');
    const secret = el.querySelector('[data-secret]');
    expect(secret?.textContent?.trim()).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP');
    expect(secret?.getAttribute('dir')).toBe('ltr');
    expect(document.activeElement?.tagName).toBe('H3');
  });

  it('does not render a QR that is not a PNG data URL', async () => {
    click('start');
    await settle();
    http.expectOne('/api/me/mfa/enroll/start').flush({ ...ENROLLMENT, qrPng: 'https://evil.example/qr.png' });
    await settle();

    expect(el.querySelector('img.qr')).toBeNull();
    expect(el.querySelector('[data-secret]')).not.toBeNull();
  });

  it('copies the secret (ungrouped) and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await toScan();
    click('copy-secret');
    await settle();

    expect(writeText).toHaveBeenCalledWith(ENROLLMENT.secret);
    expect(el.querySelector('.secret-row [role="status"]')?.textContent?.trim()).toBe('Copié.');
  });

  it('scan → confirm focuses the code field; Back returns to scan without a new request', async () => {
    await toScan();
    click('next');
    await settle();

    expect(state()).toBe('confirm');
    expect(document.activeElement?.id).toBe('wizard-code');
    expect(el.querySelector('#wizard-code')?.getAttribute('autocomplete')).toBe('one-time-code');
    click('back');
    await settle();
    expect(state()).toBe('scan');
  });

  it('maps 422 mfa-invalid onto the code field and stays on confirm', async () => {
    await toScan();
    click('next');
    await settle();
    const code = el.querySelector('#wizard-code') as HTMLInputElement;
    code.value = '000000';
    code.dispatchEvent(new Event('input'));
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
    const req = http.expectOne('/api/me/mfa/enroll/confirm');
    expect(req.request.body).toEqual({ code: '000000' });
    req.flush(
      {
        type: 'urn:hrforce:problem:mfa-invalid',
        title: 'x',
        status: 422,
        errors: [{ field: 'code', code: 'mfa-invalid', message: 'Invalid code' }],
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    await settle();

    expect(state()).toBe('confirm');
    expect(el.querySelector('#wizard-code-error')?.textContent?.trim()).toBe(
      'Code incorrect ou expiré. Saisissez le code affiché maintenant.',
    );
  });

  it('does not send an incomplete code', async () => {
    await toScan();
    click('next');
    await settle();
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();

    http.expectNone('/api/me/mfa/enroll/confirm');
    expect(el.querySelector('#wizard-code-error')).not.toBeNull();
  });

  it('codes step: Finish is disabled until "I have saved them" is ticked', async () => {
    await toCodes();

    expect(state()).toBe('codes');
    expect(current()).toBe('3 Codes de secours');
    const items = [...el.querySelectorAll('[data-codes] li')].map((li) => li.textContent?.trim());
    expect(items).toEqual(CODES);
    expect(el.querySelector('[data-codes]')?.getAttribute('dir')).toBe('ltr');
    const finish = el.querySelector('[data-action="finish"]') as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    finish.click();
    expect(finished).toBe(0);

    const check = el.querySelector('#wizard-codes-saved') as HTMLInputElement;
    check.click();
    await settle();
    expect(finish.disabled).toBe(false);
    finish.click();
    expect(finished).toBe(1);
  });

  it('Copy all puts every code on the clipboard, one per line', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await toCodes();
    click('copy-codes');
    await settle();

    expect(writeText).toHaveBeenCalledWith(CODES.join('\n'));
  });

  it('Download creates a text/plain Blob with the codes and clicks an <a download>', async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:http://localhost/codes';
    });
    URL.revokeObjectURL = vi.fn();
    let downloaded = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    await toCodes();
    click('download-codes');

    expect(downloaded).toBe(RECOVERY_CODES_FILE);
    expect(blobs[0]?.type).toContain('text/plain');
    const text = (await blobs[0]?.text()) ?? '';
    expect(text).toContain('HRForce — codes de secours');
    for (const code of CODES) expect(text).toContain(code);
  });

  it('hides Cancel when not cancellable (enrollment required)', async () => {
    fixture.componentRef.setInput('cancellable', false);
    await fixture.whenStable();

    expect([...el.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Commencer']);
  });
});
