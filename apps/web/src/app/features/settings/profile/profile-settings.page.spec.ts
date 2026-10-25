import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../../testing/auth-fixtures';
import { problem } from '../../../../testing/employee-fixtures';
import { PROFILE_SETTINGS } from '../../../../testing/profile-fixtures';
import { translocoTesting } from '../../../../testing/transloco-testing';
import { Session } from '../../../core/auth/session';
import { apiProblemInterceptor } from '../../../core/http/api-problem.interceptor';
import { SETTINGS_ROUTES } from '../settings.routes';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

describe('ProfileSettingsPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  async function setup(permissions: readonly string[]): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'settings', children: SETTINGS_ROUTES }]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(permissions));
    harness = await RouterTestingHarness.create();
  }

  afterEach(() => http.verify());
  const el = () => harness.routeNativeElement as HTMLElement;

  it('loads the modes, saves a change and shows the tab', async () => {
    await setup(['profile.configure']);
    await harness.navigateByUrl('/settings/profile');
    await settle();
    http.expectOne('/api/profile/settings').flush(PROFILE_SETTINGS);
    await settle();
    expect(el().querySelector('[data-tab="profile"]')?.getAttribute('aria-current')).toBe('page');
    expect(el().querySelector<HTMLInputElement>('#familyMode-approval')?.checked).toBe(true);
    q<HTMLInputElement>(el(), '#familyMode-immediate').click();
    const days = q<HTMLInputElement>(el(), '#profile-retention');
    days.value = '60';
    days.dispatchEvent(new Event('input'));
    q<HTMLButtonElement>(el(), '[data-action="save"]').click();
    await settle();
    const req = http.expectOne('/api/profile/settings');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ ...PROFILE_SETTINGS, familyMode: 'immediate', fileRetentionDays: 60 });
    req.flush({ ...PROFILE_SETTINGS, familyMode: 'immediate', fileRetentionDays: 60 });
    await settle();
    expect(el().querySelector('[role="status"]')?.textContent).toContain('Paramètres enregistrés');
  });

  it('refuses a retention outside 7–365 and maps the API field errors', async () => {
    await setup(['profile.configure']);
    await harness.navigateByUrl('/settings/profile');
    await settle();
    http.expectOne('/api/profile/settings').flush(PROFILE_SETTINGS);
    await settle();
    const days = q<HTMLInputElement>(el(), '#profile-retention');
    days.value = '400';
    days.dispatchEvent(new Event('input'));
    q<HTMLButtonElement>(el(), '[data-action="save"]').click();
    await settle();
    http.expectNone('/api/profile/settings');
    expect(el().querySelector('#profile-retention-error')?.textContent).toContain('entre 7 et 365');
    days.value = '90';
    days.dispatchEvent(new Event('input'));
    q<HTMLButtonElement>(el(), '[data-action="save"]').click();
    await settle();
    http.expectOne('/api/profile/settings').flush(...problem(422, 'validation', [{ field: 'fileRetentionDays', code: 'range', message: 'Hors limites' }]));
    await settle();
    expect(el().querySelector('#profile-retention-error')?.textContent).toContain('Hors limites');
  });

  it('is not reachable without profile.configure', async () => {
    await setup(['settings.branding']);
    await harness.navigateByUrl('/settings/profile');
    await settle();
    http.expectNone('/api/profile/settings');
    expect(el().querySelector('#profile-retention')).toBeNull();
  });
});
