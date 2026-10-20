import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { meWith } from '../../../testing/auth-fixtures';
import { POLICY } from '../../../testing/deadline-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { DeadlineSettingsPage } from './deadline-settings.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await Promise.resolve();
  TestBed.tick();
}

describe('DeadlineSettingsPage', () => {
  let fixture: ComponentFixture<DeadlineSettingsPage>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideRouter([]), provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['deadline.configure']));
    fixture = TestBed.createComponent(DeadlineSettingsPage);
    TestBed.tick();
    http.expectOne('/api/deadlines/settings').flush({ ...POLICY, contractNoticeDays: 40 });
    await settle();
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    fixture.destroy();
    http.verify();
  });

  function enter(id: string, value: string): void {
    const input = el().querySelector<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(id);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    TestBed.tick();
  }

  it('shows the stored policy and checks the API bounds before sending', () => {
    expect(el().querySelector<HTMLInputElement>('#dl-contractNoticeDays')?.value).toBe('40');
    enter('dl-retirementAge', '75');
    expect(el().querySelector('#dl-retirementAge-error')?.textContent).toContain('Entrez un nombre entier entre 50 et 70.');
    enter('dl-decisionNoticeDays', '0');
    expect(el().querySelector('#dl-decisionNoticeDays-error')).toBeNull();
    el().querySelector<HTMLButtonElement>('[data-action="save-policy"]')?.click();
    TestBed.tick();
    http.expectNone('/api/deadlines/settings');
  });

  it('saves every field as numbers', async () => {
    enter('dl-decisionNoticeDays', '0');
    el().querySelector<HTMLButtonElement>('[data-action="save-policy"]')?.click();
    TestBed.tick();
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/deadlines/settings');
    expect(put.request.body).toEqual({ ...POLICY, contractNoticeDays: 40, decisionNoticeDays: 0 });
    put.flush({ ...POLICY, decisionNoticeDays: 0 });
    await settle();
    http.expectOne('/api/deadlines/settings').flush({ ...POLICY, decisionNoticeDays: 0 });
    await settle();
    expect(el().querySelector('[data-feedback]')?.textContent).toContain('Paramètres enregistrés.');
  });

  it('a regional holder learns the settings are company-wide', async () => {
    el().querySelector<HTMLButtonElement>('[data-action="save-policy"]')?.click();
    TestBed.tick();
    http
      .expectOne((r) => r.method === 'PUT')
      .flush({ type: 'urn:hrforce:problem:forbidden-scope', title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await settle();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('droit sur toute l’entreprise');
  });

  it('in Arabic', () => {
    TestBed.inject(LanguageService).use('ar', { remember: false });
    TestBed.tick();
    enter('dl-retirementAge', '20');
    expect(el().querySelector('#dl-retirementAge-error')?.textContent).toContain('يجب إدخال عدد صحيح بين 50 و70.');
  });
});
