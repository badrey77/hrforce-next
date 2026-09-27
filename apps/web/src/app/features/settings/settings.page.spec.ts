import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { translocoTesting } from '../../../testing/transloco-testing';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { NotificationPreference } from '../../core/notifications/notifications.models';
import { SettingsPage } from './settings.page';

const PREFS: NotificationPreference[] = [
  { type: 'task.assigned', email: true, default: true },
  { type: 'leave.approved', email: true, default: true },
  { type: 'leave.cancelled', email: false, default: false },
];

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('SettingsPage › Notifications', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'settings', component: SettingsPage }]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/settings');
    await settle();
    http.expectOne('/api/me/notification-preferences').flush(PREFS);
    await settle();
  });

  afterEach(() => http.verify());


  const el = () => harness.routeNativeElement as HTMLElement;
  const box = (type: string) => el().querySelector(`[data-pref="${type}"] input`) as HTMLInputElement;
  const save = () => el().querySelector('[data-action="save"]') as HTMLButtonElement;
  async function toggle(type: string): Promise<void> {
    box(type).click();
    await settle();
  }

  it('shows one email switch per type with its label and default; Save is off until something changes', () => {
    expect(el().querySelector('[data-pref="task.assigned"]')?.textContent).toContain('Une demande attend mon approbation');
    expect(el().querySelector('[data-pref="task.assigned"]')?.textContent).toContain('par défaut : oui');
    expect(el().querySelector('[data-pref="leave.cancelled"]')?.textContent).toContain('par défaut : non');
    expect(box('task.assigned').checked).toBe(true);
    expect(box('leave.cancelled').checked).toBe(false);
    expect(save().disabled).toBe(true);
  });

  it('saves every type with its new value (PUT), then is clean again', async () => {
    await toggle('task.assigned');
    expect(save().disabled).toBe(false);
    expect(el().querySelector('[data-state="feedback"]')?.textContent).toContain('Modifications non enregistrées');
    // Flipping back makes the page clean again (dirty is computed, not a sticky flag).
    await toggle('task.assigned');
    expect(save().disabled).toBe(true);

    await toggle('leave.cancelled');
    save().click();
    await settle();
    expect(save().disabled).toBe(true); // saving
    const put = http.expectOne('/api/me/notification-preferences');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual([
      { type: 'task.assigned', email: true },
      { type: 'leave.approved', email: true },
      { type: 'leave.cancelled', email: true },
    ]);
    put.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(el().querySelector('[data-state="feedback"]')?.textContent).toContain('Préférences enregistrées');
    expect(box('leave.cancelled').checked).toBe(true);
    expect(save().disabled).toBe(true);
  });

  it('keeps the edits and explains a refused save (422) or a generic failure', async () => {
    await toggle('leave.approved');
    save().click();
    await settle();
    http
      .expectOne('/api/me/notification-preferences')
      .flush({ type: 'urn:hrforce:problem:validation', title: 'Invalid', status: 422, errors: [] }, { status: 422, statusText: 'Unprocessable' });
    await settle();
    expect(el().querySelector('[data-error="save"]')?.textContent).toContain('Le serveur a refusé ces préférences');
    expect(box('leave.approved').checked).toBe(false);
    expect(save().disabled).toBe(false);

    save().click();
    await settle();
    http.expectOne('/api/me/notification-preferences').flush({ type: 'about:blank', title: 'Error', status: 500 }, { status: 500, statusText: 'Error' });
    await settle();
    expect(el().querySelector('[data-error="save"]')?.textContent).toContain('Impossible d’enregistrer vos préférences');
  });

  it('"restore defaults" sets every switch to its default', async () => {
    await toggle('task.assigned');
    await toggle('leave.cancelled');
    (el().querySelector('[data-action="defaults"]') as HTMLButtonElement).click();
    await settle();
    expect(box('task.assigned').checked).toBe(true);
    expect(box('leave.cancelled').checked).toBe(false);
    expect(save().disabled).toBe(true);
  });
});
