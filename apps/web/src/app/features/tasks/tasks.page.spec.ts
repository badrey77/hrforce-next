import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { correctionDetail, correctionView } from '../../../testing/attendance-fixtures';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { conflict, flushLeaveTypes, leaveDetail, openTask } from '../../../testing/leave-fixtures';
import { openingTaskSummary } from '../../../testing/recruitment-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { CorrectionTaskSubject, DocumentTaskSubject, LeaveTaskSubject, OpenTask } from '../../core/tasks/tasks.models';
import { TasksBadge } from '../../core/tasks/tasks-badge';
import { TasksPage } from './tasks.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

/** A task about a self-service document request (documents contract › Task summaries). */
function documentTask(id: string): OpenTask {
  const leave = openTask(id);
  const subject: DocumentTaskSubject = {
    type: 'document_request',
    id: `dr-${id}`,
    employee: (leave.subject as LeaveTaskSubject).employee,
    documentType: { code: 'attestation_travail', labels: { fr: 'Attestation de travail', ar: 'شهادة عمل', en: 'Employment attestation' } },
    language: 'ar',
    purpose: 'Dossier de prêt',
    requestedAt: '2026-09-27T08:00:00Z',
  };
  return { ...leave, stepKey: 'hr', subject };
}

/** A task about an attendance correction (attendance contract › Audit and timeline (Phase B): task summaries). */
function correctionTask(id: string): OpenTask {
  const leave = openTask(id);
  const view = correctionView();
  const subject: CorrectionTaskSubject = {
    type: 'attendance_correction',
    id: view.id,
    employee: { id: view.employee.id, matricule: view.employee.matricule, person: view.employee.person, unit: view.employee.unit },
    date: view.date,
    reason: view.reason,
    changes: view.changes,
    day: { status: 'present', arrival: { id: 'p-0', occurredAt: '2026-09-28T06:52:00Z', localTime: '07:52' }, departure: null },
  };
  return { ...leave, stepKey: 'manager', stepIndex: 0, subject };
}

describe('TasksPage', () => {
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

  async function open(items: readonly OpenTask[] = [openTask('k-1'), openTask('k-2'), openTask('k-3')], url = '/tasks'): Promise<void> {
    await harness.navigateByUrl(url);
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

  it('?task=<id> (a notification or email link) selects that task and loads its request', async () => {
    await open(undefined, '/tasks?task=k-2');
    expect(el().querySelector('[data-task="k-2"]')?.getAttribute('aria-pressed')).toBe('true');
    http.expectOne('/api/leave/requests/r-k-2').flush(leaveDetail({ id: 'r-k-2' }));
    await settle();
    expect(el().querySelector('#task-panel-title')?.textContent).toContain('BENALI Amina');
    expect(el().querySelector('[data-state="task-not-open"]')).toBeNull();

    // Another link while the page is open: same component, new input → new selection.
    await harness.navigateByUrl('/tasks?task=k-3');
    await answerTasks([openTask('k-1'), openTask('k-2'), openTask('k-3')]);
    expect(el().querySelector('[data-task="k-3"]')?.getAttribute('aria-pressed')).toBe('true');
    http.expectOne('/api/leave/requests/r-k-3').flush(leaveDetail({ id: 'r-k-3' }));
    await settle();
  });

  it('?task=<id> of a task that is no longer open says so', async () => {
    await open([openTask('k-1')], '/tasks?task=k-9');
    expect(el().querySelector('[data-state="task-not-open"]')?.textContent).toContain('n’est plus ouverte');
    expect(el().querySelector('[data-state="no-selection"]')).not.toBeNull();
  });

  describe('document requests (docs/contracts/documents.md › Web › My tasks)', () => {
    it('renders the summary without asking for a leave request, and approves', async () => {
      await open([documentTask('k-9')]);
      expect(el().querySelector('[data-task="k-9"]')?.textContent).toContain('Attestation de travail · Arabe');
      click('[data-task="k-9"]');
      await settle();
      http.expectNone((r) => r.url.startsWith('/api/leave/requests'));
      const panel = el().querySelector('[data-panel="document-request"]');
      expect(panel?.querySelector('[data-field="purpose"]')?.textContent).toBe('Dossier de prêt');
      click('[data-action="approve"]');
      http.expectOne('/api/tasks/k-9/approve').flush({});
      await answerTasks([]);
    });

    it('explains an issuing refusal of the approval (letterhead incomplete) and brings the task back', async () => {
      await open([documentTask('k-9')]);
      click('[data-task="k-9"]');
      await settle();
      click('[data-action="approve"]');
      http.expectOne('/api/tasks/k-9/approve').flush(...conflict('document-profile-incomplete'));
      await settle();
      expect(el().querySelector('[data-feedback]')?.textContent).toContain('l’en-tête de l’entreprise est incomplet');
      expect(rows()).toEqual(['k-9']);
    });
  });

  it('a correction task: employee, day, reason and a before/after view from the detail; stale approval explained in the panel', async () => {
    await open([correctionTask('k-c')]);
    expect(el().querySelector('[data-task="k-c"] [data-subject="attendance_correction"]')?.textContent).toContain('Correction de pointage');
    click('[data-task="k-c"]');
    await settle();
    // Before the detail answers, the summary's arrival already feeds the preview.
    expect(el().querySelector('[data-panel="correction-preview"]')?.textContent).toContain('07:52');
    http.expectOne('/api/attendance/corrections/c-1').flush(correctionDetail());
    await settle();
    const panel = el().querySelector('[data-panel="attendance-correction"]') as HTMLElement;
    expect(panel.querySelector('[data-field="reason"]')?.textContent).toContain('Téléphone oublié');
    const after = [...el().querySelectorAll('[data-panel="correction-preview"] [data-change]')].map((li) => li.getAttribute('data-change'));
    expect(after).toEqual(['removed', 'kept', 'added']);

    click('[data-action="approve"]');
    await settle();
    http.expectOne('/api/tasks/k-c/approve').flush(...conflict('attendance-correction-stale'));
    await settle();
    for (const req of http.match('/api/attendance/corrections/c-1')) req.flush(correctionDetail());
    await settle();
    expect(el().querySelector('[data-error="panel"]')?.textContent).toContain('déjà été annulé');
  });

  it('an opening request: everything an approver needs in the panel; approve and reject work as for leave', async () => {
    const task: OpenTask = { ...openTask('k-9'), stepKey: 'manager', stepIndex: 0, subject: openingTaskSummary() };
    await open([task]);
    const row = el().querySelector('[data-task="k-9"]')?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(row).toContain("Agent d'accueil");
    expect(row).toContain('REC-2026-0002');
    expect(row).toContain('Agence Annaba');
    click('[data-task="k-9"]');
    await settle();
    // No other request: the summary carries the whole opening (an approver may hold no recruitment permission).
    http.expectNone((r) => r.url.startsWith('/api/recruitment'));
    const panel = el().querySelector('[data-panel="recruitment-opening"]') as HTMLElement;
    expect(el().querySelector('#task-panel-title')?.textContent?.trim()).toBe("Agent d'accueil");
    expect(panel.querySelector('[data-field="reference"]')?.textContent).toContain('REC-2026-0002');
    expect(panel.querySelector('[data-field="posts"]')?.textContent?.trim()).toBe('1');
    expect(panel.querySelector('[data-field="justification"]')?.textContent).toContain('Saison haute.');
    expect(panel.querySelector('[data-field="requester"]')?.textContent).toContain('Chef Annaba');
    expect(panel.textContent).toContain('CDD');

    // Reject needs a comment, whose hint says who will read it.
    click('[data-action="reject"]');
    await settle();
    expect(el().querySelector('#reject-comment-hint')?.textContent).toContain('la personne qui a fait la demande');
    const comment = el().querySelector('#reject-comment') as HTMLTextAreaElement;
    comment.value = 'Poste non budgétisé';
    comment.dispatchEvent(new Event('input'));
    click('[data-action="confirm-reject"]');
    await settle();
    const reject = http.expectOne('/api/tasks/k-9/reject');
    expect(reject.request.body).toEqual({ comment: 'Poste non budgétisé' });
    reject.flush({});
    await answerTasks([]);
    expect(el().querySelector('[data-feedback]')?.textContent).toContain('Demande de Chef Annaba refusée.');
  });

  it('a purged correction: no employee, an explanation, and only Reject', async () => {
    const purged: OpenTask = { ...openTask('k-p'), subject: { type: 'attendance_correction', purged: true } };
    await open([purged]);
    click('[data-task="k-p"]');
    await settle();
    expect(el().querySelector('[data-state="purged"]')).not.toBeNull();
    expect(el().querySelector('[data-action="approve"]')).toBeNull();
    expect(el().querySelector('[data-action="reject"]')).not.toBeNull();
    http.expectNone('/api/attendance/corrections/c-1');
  });
});
