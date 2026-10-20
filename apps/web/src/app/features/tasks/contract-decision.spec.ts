import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { decisionTask } from '../../../testing/deadline-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { flushLeaveTypes } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import type { OpenTask } from '../../core/tasks/tasks.models';
import { TasksPage } from './tasks.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('TasksPage › contract decisions', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'tasks', component: TasksPage }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    // A unit head: no permission at all is needed to propose at the manager step.
    TestBed.inject(Session).set(meWith([]));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;
  const click = (selector: string) => {
    const target = el().querySelector<HTMLElement>(selector);
    if (!target) throw new Error(selector);
    target.click();
  };

  async function answerTasks(items: readonly OpenTask[]): Promise<void> {
    await settle();
    for (const req of http.match((r) => r.url === '/api/tasks')) if (!req.cancelled) req.flush({ items });
    await settle();
  }

  async function open(task: OpenTask): Promise<void> {
    await harness.navigateByUrl(`/tasks?task=${task.id}`);
    await settle();
    flushLeaveTypes(http);
    await answerTasks([task]);
  }

  function set(id: string, value: string): void {
    const input = el().querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
    if (!input) throw new Error(id);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
  }

  it('lists the decision and shows the ending contract; Approve waits for a saved proposal', async () => {
    await open(decisionTask());
    const row = el().querySelector('[data-task="t-decision"]')?.textContent?.replace(/\s+/g, ' ');
    expect(row).toContain('Décision de fin de contrat');
    expect(row).toContain('CDD');
    expect(el().querySelector('[data-field="contract"]')?.textContent).toContain('CDD');
    expect(el().querySelector('[data-field="proposal"]')?.textContent).toContain('Aucune proposition');
    expect(el().querySelector<HTMLButtonElement>('[data-action="approve"]')?.disabled).toBe(true);
    expect(el().querySelector('[data-hint="approve"]')?.textContent).toContain('Enregistrez une proposition');
  });

  it('a renewal needs an end date after the start; saving PUTs the proposal and refreshes the task', async () => {
    await open(decisionTask());
    click('[data-proposal="renew"]');
    await settle();
    expect(el().querySelector<HTMLInputElement>('#decision-start')?.value).toBe('2026-12-01');
    click('[data-action="save-proposal"]');
    await settle();
    expect(el().querySelector('[data-error="end"]')?.textContent).toContain('Indiquez la fin du nouveau contrat.');
    set('decision-end', '2026-11-01');
    await settle();
    expect(el().querySelector('[data-error="end"]')?.textContent).toContain('La fin doit être après le début.');
    http.expectNone('/api/contract-decisions/dec-1/proposal');

    set('decision-end', '2027-11-30');
    set('decision-comment', ' Bon élément ');
    await settle();
    // unsaved changes: approving now would apply the old (empty) proposal
    expect(el().querySelector<HTMLButtonElement>('[data-action="approve"]')?.disabled).toBe(true);
    click('[data-action="save-proposal"]');
    await settle();
    const put = http.expectOne('/api/contract-decisions/dec-1/proposal');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ proposal: 'renew', proposedStartDate: '2026-12-01', proposedEndDate: '2027-11-30', comment: 'Bon élément' });
    put.flush({});
    const saved = decisionTask({ proposal: 'renew', proposedStartDate: '2026-12-01', proposedEndDate: '2027-11-30', comment: 'Bon élément' });
    await answerTasks([saved]);
    expect(el().querySelector('[data-field="proposal"]')?.textContent).toContain('renouvellement du');
    expect(el().querySelector<HTMLButtonElement>('[data-action="approve"]')?.disabled).toBe(false);
    expect(el().querySelector('[data-hint="approve"]')?.textContent).toContain('transmet la proposition aux RH');
  });

  it('« end » sends neither date', async () => {
    await open(decisionTask());
    click('[data-proposal="end"]');
    await settle();
    expect(el().querySelector('#decision-end')).toBeNull();
    click('[data-action="save-proposal"]');
    await settle();
    expect(http.expectOne('/api/contract-decisions/dec-1/proposal').request.body).toEqual({ proposal: 'end' });
  });

  it('at the HR step the proposal is shown, editable, and approving says what it applies; a refusal is explained', async () => {
    const hr = decisionTask({ proposal: 'convert_cdi', proposedStartDate: '2026-12-01' }, 'hr');
    await open(hr);
    expect(el().querySelector('legend')?.textContent).toContain('modifiable par les RH');
    expect(el().querySelector<HTMLInputElement>('[data-proposal="convert_cdi"]')?.checked).toBe(true);
    expect(el().querySelector('[data-hint="approve"]')?.textContent).toContain('Approuver appliquera : passage en CDI');
    click('[data-action="approve"]');
    await settle();
    http
      .expectOne('/api/tasks/t-decision/approve')
      .flush({ type: 'urn:hrforce:problem:contract-overlap', title: 'Overlap', status: 409 }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(el().querySelector('[data-feedback]')?.textContent).toContain('Impossible d’appliquer la décision pour');
  });

  it('in Arabic', async () => {
    TestBed.inject(LanguageService).use('ar', { remember: false });
    await open(decisionTask());
    expect(el().querySelector('[data-task="t-decision"]')?.textContent).toContain('قرار بشأن نهاية العقد');
    expect(el().querySelector('label[for="decision-proposal-renew"]')?.textContent).toContain('تجديد العقد');
  });
});
