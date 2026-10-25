import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { problem } from '../../../testing/employee-fixtures';
import { flushLeaveTypes } from '../../../testing/leave-fixtures';
import { profileRequestDetail } from '../../../testing/profile-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { OpenTask } from '../../core/tasks/tasks.models';
import { TasksPage } from './tasks.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

function profileTask(extra: Partial<OpenTask> = {}): OpenTask {
  const r = profileRequestDetail();
  return {
    id: 't-profile',
    stepKey: 'hr',
    stepIndex: 0,
    stepLabels: { fr: 'RH', ar: 'الموارد البشرية', en: 'HR' },
    createdAt: '2026-10-20T08:30:00Z',
    subject: { type: 'profile_change_request', id: 'pr-1', employee: r.employee, section: 'family', changedFields: ['children'] },
    ...extra,
  };
}

describe('TasksPage › profile changes', () => {
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
    TestBed.inject(Session).set(meWith(['employee.personal.update']));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
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

  async function open(task: OpenTask = profileTask(), detail = profileRequestDetail({ changedSince: true })): Promise<void> {
    await harness.navigateByUrl(`/tasks?task=${task.id}`);
    await settle();
    flushLeaveTypes(http);
    await answerTasks([task]);
    http.expectOne('/api/profile/requests/pr-1').flush(detail);
    await settle();
  }

  it('lists the request by section and field names only, and shows before → after with the files', async () => {
    await open();
    const row = text('[data-task="t-profile"]') ?? '';
    expect(row).toContain('Demande de modification · Situation familiale');
    expect(row).toContain('1 champ(s) : Enfants à charge');
    expect(row).not.toContain('Lina');
    expect(text('[data-panel="profile-change"] [data-field="section"]')).toBe('Situation familiale');
    expect(el().querySelector('[data-child-diff="added"]')?.textContent).toContain('Lina');
    expect(el().querySelector('[data-state="changed-since"]')).not.toBeNull();
    expect(el().querySelector('[data-file="pf-1"] a')?.getAttribute('target')).toBe('_blank');
    expect(text('[data-field="approve-hint"]')).toContain('Approuver applique la modification');
  });

  it('approves; a refusal of the apply is explained', async () => {
    await open();
    click('[data-action="approve"]');
    await settle();
    http.expectOne('/api/tasks/t-profile/approve').flush(...problem(409, 'employment-ended'));
    await settle();
    expect(text('[data-feedback]')).toBe('La demande de Haddad Samir ne peut plus être appliquée : son emploi a pris fin.');
    // the row is back (rollback): its panel is shown again and reads the request
    http.expectOne('/api/profile/requests/pr-1').flush(profileRequestDetail());
    await settle();
    expect(el().querySelector('[data-child-diff="added"]')).not.toBeNull();
    // (later list refreshes keep the same id: no new read)n only if the id changes
    await answerTasks([profileTask()]);
    http.expectNone('/api/profile/requests/pr-1');
  });

  it('rejects with a comment', async () => {
    await open();
    click('[data-action="reject"]');
    await settle();
    expect(text('#reject-title + p')).toContain('Situation familiale');
    const comment = el().querySelector('#reject-comment') as HTMLTextAreaElement;
    comment.value = 'Pièce illisible';
    comment.dispatchEvent(new Event('input'));
    el().querySelector('dialog form')?.dispatchEvent(new Event('submit'));
    await settle();
    const reject = http.expectOne('/api/tasks/t-profile/reject');
    expect(reject.request.body).toEqual({ comment: 'Pièce illisible' });
    reject.flush({});
    await answerTasks([]);
  });

  it('says what approving an error report or a bank change does; the detail can fail and be retried', async () => {
    const note = profileTask({ subject: { type: 'profile_change_request', id: 'pr-1', employee: profileRequestDetail().employee, section: 'identity_note', changedFields: ['note'] } });
    await harness.navigateByUrl(`/tasks?task=${note.id}`);
    await settle();
    flushLeaveTypes(http);
    await answerTasks([note]);
    http.expectOne('/api/profile/requests/pr-1').flush(...problem(404, null));
    await settle();
    expect(text('[data-field="approve-hint"]')).toContain('rien n’est modifié');
    expect(el().querySelector('[data-panel="profile-change"] ~ .form-error')).not.toBeNull();
    click('[data-action="retry-request"]');
    await settle();
    http.expectOne('/api/profile/requests/pr-1').flush(profileRequestDetail({ section: 'identity_note', changedFields: ['note'], payload: { note: 'Erreur de date' }, before: null }));
    await settle();
    expect(text('[data-field="note"]')).toBe('Erreur de date');
  });
});
