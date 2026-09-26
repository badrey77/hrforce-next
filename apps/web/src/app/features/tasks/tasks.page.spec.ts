import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { conflict, flushLeaveTypes, leaveDetail, openTask } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { OpenTask } from '../../core/tasks/tasks.models';
import { TasksBadge } from '../../core/tasks/tasks-badge';
import { TasksPage } from './tasks.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('TasksPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'tasks', component: TasksPage }]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    // A unit head with the self-service role only: no leave permission is needed to approve the manager step.
    TestBed.inject(Session).set(meWith(['leave.request_self']));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const rows = () => [...el().querySelectorAll('[data-task]')].map((b) => b.getAttribute('data-task'));
  const click = (selector: string) => (el().querySelector(selector) as HTMLElement).click();

  /** Answers every open `GET /api/tasks` (the resource may have been reloaded by the navigation). */
  async function answerTasks(items: readonly OpenTask[]): Promise<void> {
    await settle();
    for (const req of http.match((r) => r.url === '/api/tasks')) if (!req.cancelled) req.flush({ items });
    await settle();
  }

  async function open(items: readonly OpenTask[] = [openTask('k-1'), openTask('k-2'), openTask('k-3')]): Promise<void> {
    await harness.navigateByUrl('/tasks');
    await settle();
    flushLeaveTypes(http);
    await answerTasks(items);
  }

  async function selectAndLoad(id: string): Promise<void> {
    click(`[data-task="${id}"]`);
    await settle();
    http.expectOne(`/api/leave/requests/r-${id}`).flush(leaveDetail({ id: `r-${id}` }));
    await settle();
  }

  it('lists the open tasks with employee, type, dates and step; the panel shows the request, balance and history', async () => {
    await open();
    expect(rows()).toEqual(['k-1', 'k-2', 'k-3']);
    const first = el().querySelector('[data-task="k-1"]')?.textContent?.replace(/\s+/g, ' ');
    expect(first).toContain('BENALI Amina');
    expect(first).toContain('Congé annuel');
    expect(first).toContain('5 j');
    expect(first).toContain('Étape : RH régionales');
    expect(el().querySelector('h2')?.textContent).toContain('3 tâche(s) en attente');

    await selectAndLoad('k-1');
    expect(el().querySelector('[data-task="k-1"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(el().querySelector('[data-field="type"]')?.textContent?.trim()).toBe('Congé annuel');
    expect(el().querySelector('app-balance-cards [data-period="2025-07-01"]')?.textContent).toContain('8');
    expect(el().querySelector('[data-table="history"] tbody')?.textContent).toContain('Chef Annaba');
    expect(el().querySelectorAll('app-workflow-stepper li')).toHaveLength(2);
  });

  it('approves optimistically: the row and the badge drop at once, the next task is selected, then the list refreshes', async () => {
    await open();
    await selectAndLoad('k-1');
    const badge = TestBed.inject(TasksBadge);

    click('[data-action="approve"]');
    await settle();
    expect(rows()).toEqual(['k-2', 'k-3']);
    expect(badge.count()).toBe(2);
    expect(el().querySelector('[data-task="k-2"]')?.getAttribute('aria-pressed')).toBe('true');

    const approve = http.expectOne('/api/tasks/k-1/approve');
    expect(approve.request.method).toBe('POST');
    http.expectOne('/api/leave/requests/r-k-2').flush(leaveDetail({ id: 'r-k-2' }));
    approve.flush({});
    await settle();
    expect(el().querySelector('[data-feedback]')?.textContent?.trim()).toBe('Demande de BENALI Amina approuvée.');
    await answerTasks([openTask('k-2'), openTask('k-3')]);
    expect(rows()).toEqual(['k-2', 'k-3']);
  });

  it('rolls back on 409 workflow-task-closed: the row comes back, explained, and the list is refreshed', async () => {
    await open();
    await selectAndLoad('k-2');

    click('[data-action="approve"]');
    await settle();
    expect(rows()).toEqual(['k-1', 'k-3']);
    http.expectOne('/api/leave/requests/r-k-3').flush(leaveDetail({ id: 'r-k-3' }));
    http.expectOne('/api/tasks/k-2/approve').flush(...conflict('workflow-task-closed'));
    await settle();

    expect(rows()).toEqual(['k-1', 'k-2', 'k-3']); // back where it was
    expect(el().querySelector('[data-feedback]')?.textContent?.trim()).toBe(
      "La demande de BENALI Amina a déjà été traitée par quelqu'un d'autre.",
    );
    expect(el().querySelector('[data-feedback]')?.classList).toContain('warning');
    http.expectOne('/api/leave/requests/r-k-2').flush(leaveDetail({ id: 'r-k-2' }));
    // The refresh shows the truth: the task is closed.
    await answerTasks([openTask('k-1'), openTask('k-3')]);
    expect(rows()).toEqual(['k-1', 'k-3']);
  });

  it('reject needs a comment (dialog), then sends it', async () => {
    await open([openTask('k-1')]);
    await selectAndLoad('k-1');

    click('[data-action="reject"]');
    await settle();
    const dialog = el().querySelector('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    const textarea = dialog.querySelector('#reject-comment') as HTMLTextAreaElement;
    textarea.value = '   ';
    textarea.dispatchEvent(new Event('input'));
    dialog.querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
    http.expectNone('/api/tasks/k-1/reject');
    expect(dialog.querySelector('[data-error="comment"]')?.textContent?.trim()).toBe('Un commentaire est obligatoire pour refuser.');

    textarea.value = 'Période de clôture';
    textarea.dispatchEvent(new Event('input'));
    dialog.querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
    expect(dialog.open).toBe(false);
    expect(rows()).toEqual([]);
    const reject = http.expectOne('/api/tasks/k-1/reject');
    expect(reject.request.body).toEqual({ comment: 'Période de clôture' });
    reject.flush({});
    await settle();
    expect(el().querySelector('[data-feedback]')?.textContent?.trim()).toBe('Demande de BENALI Amina refusée.');
    await answerTasks([]);
    expect(el().querySelector('[data-state="empty"]')).not.toBeNull();
  });

  it('explains a self-approval refusal and keeps the task', async () => {
    await open([openTask('k-1')]);
    await selectAndLoad('k-1');
    click('[data-action="approve"]');
    await settle();
    http.expectOne('/api/tasks/k-1/approve').flush(...conflict('workflow-self-approval'));
    await settle();
    expect(rows()).toEqual(['k-1']);
    expect(el().querySelector('[data-feedback]')?.textContent?.trim()).toBe('Vous ne pouvez pas traiter votre propre demande.');
    http.expectOne('/api/leave/requests/r-k-1').flush(leaveDetail({ id: 'r-k-1' }));
    await settle();
  });
});
