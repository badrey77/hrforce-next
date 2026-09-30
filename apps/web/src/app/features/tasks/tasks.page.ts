/**
 * /tasks — My tasks (docs/contracts/leave.md › Web): the open approval tasks where the signed-in user is a candidate,
 * a detail panel (the request, the employee's balance, the step history) and Approve / Reject (reject needs a
 * comment, asked in a dialog).
 *
 * Angular concepts:
 * - **One store, two views.** The list is `TasksBadge.items()` (core/tasks/tasks-badge.ts), the same signal the nav
 *   badge counts. The page holds no copy of the list, so approving here updates the badge in the same render.
 * - **Optimistic update with rollback** (the store's header explains the signal mechanics):
 *     click Approve → `store.hide(id)` (row and badge update NOW) → select the next task → POST …/approve
 *       ├─ success → feedback + `store.refresh()` (the server's list confirms the removal)
 *       └─ failure → `store.show(id)` (the row comes back where it was) + an explanation;
 *                    409 `workflow-task-closed` = someone else acted first → "already handled" + refresh, after which
 *                    the task disappears for good (it IS closed).
 *   Optimistic is right here because the server almost always agrees (the list only holds tasks you may act on), and
 *   an approver working through ten requests should not wait for ten round trips. It would be wrong for an action the
 *   server often refuses, or whose result the user must see before going on.
 * - **Selection as a signal, detail as a resource keyed on it.** `selectedId` is a `signal`; `selected` a `computed()`
 *   that finds the task in the store (so a task that vanished on refresh deselects itself); `detail` is an
 *   `httpResource` of `GET /leave/requests/:id` keyed on the selected task's subject.
 * - **A dialog with a required comment**: a one-control reactive form (`Validators.required` + a not-blank check)
 *   inside a native `<dialog>`; the POST is only sent when it is valid.
 * - **A query param as an entry point** (`/tasks?task=<id>`, the link in notifications and emails): with
 *   `withComponentInputBinding()` the router sets the `task` input from `?task=`. `selectedId` is a `linkedSignal` of
 *   it — it follows the link (also when a second notification is clicked while the page is open: same component, new
 *   input value) but clicking another row still overrides it. The URL is not rewritten on every click: the parameter
 *   says where to START, not which row is selected now. When the linked task is not in the list (someone else already
 *   handled it, or you are no longer a candidate) the page says so instead of silently showing nothing.
 * - **Two kinds of subject, one list** (docs/contracts/documents.md › Web › My tasks): a task is about a leave request
 *   OR a self-service document request. `TaskSubject` is a discriminated union (core/tasks/tasks.models.ts); the
 *   template branches with `@if (task.subject.type === 'leave_request')`, and Angular's template type-checker NARROWS
 *   the union inside the block exactly like TypeScript does after an `if`, so `task.subject.leaveTypeId` compiles
 *   there and not in the `@else`. A document task needs no extra request: its summary (employee, type, language,
 *   purpose) is all HR must see to decide. Approving it issues the document; an issuing refusal (letterhead
 *   incomplete…) comes back as the approval's error and is explained here.
 * - **A third kind: attendance corrections** (docs/contracts/attendance.md › Web (Phase B) › My tasks). The summary
 *   already names the employee, the date, the reason and the day's arrival/departure/status; the panel also asks
 *   `GET /attendance/corrections/:id` — the approver is a CANDIDATE, which that route accepts without any attendance
 *   permission (a unit head) — for every punch of the day, so `<app-correction-preview>` can show the day BEFORE and
 *   AFTER the change. Until that answer arrives (or if it fails), the preview is built from the summary's
 *   arrival/departure: the approver is never left without the essentials. A second resource keyed on a second
 *   `computed()` id, exactly like the leave detail: each fires only for its own kind of task.
 *   The purged form of the union (`{type: 'attendance_correction', purged: true}`, the retention job deleted the
 *   request) has no employee: rows name people through `subjectPerson()` and the panel explains instead of offering
 *   Approve/Reject. `attendance-correction-stale` (a punch to remove was voided meanwhile, the approval rolls back) is
 *   shown IN the task panel, next to the buttons, because it asks the approver to reject instead.
 * - **Focus management after removal**: when the acted-on row disappears, focus would fall to `<body>`. The page moves
 *   it to the panel heading of the next task (or the list heading) with `afterNextRender`, which runs once the DOM
 *   reflects the new state.
 */
import { DatePipe, DecimalPipe } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  Injector,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Observable } from 'rxjs';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveApi } from '../../core/leave/leave-api';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import { TasksApi } from '../../core/tasks/tasks-api';
import { TasksBadge } from '../../core/tasks/tasks-badge';
import { type OpenTask, subjectPerson } from '../../core/tasks/tasks.models';
import { CorrectionPreviewView, punchesOfSummary, type PreviewSourcePunch } from '../../shared/attendance/correction-preview';
import { DayStatusBadge } from '../../shared/attendance/day-badges';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { BalanceCards } from '../../shared/leave/balance-cards';
import { LeaveRequestView } from '../../shared/leave/leave-request-view';

export const COMMENT_MAX = 500;

type Decision = 'approve' | 'reject';

interface Feedback {
  readonly key: string;
  readonly name: string;
  readonly kind: 'ok' | 'error';
}

/**
 * Approving a document request ISSUES the document in the same transaction (docs/contracts/documents.md › Endpoints):
 * any issuing refusal fails the approval with the issuing slug. They are explained in the task panel.
 */
const DOCUMENT_APPROVAL_KEYS: Readonly<Record<string, string>> = {
  'document-profile-incomplete': 'tasks.problems.documentProfileIncomplete',
  'document-employment-ended': 'tasks.problems.documentEmploymentEnded',
  'document-no-signatory': 'tasks.problems.documentNoSignatory',
  'document-type-inactive': 'tasks.problems.documentTypeInactive',
  'document-busy': 'tasks.problems.documentRetry',
  'document-render-failed': 'tasks.problems.documentRetry',
};

/** Translation key for a failed decision. */
export function decisionErrorKey(error: unknown): string {
  if (!isApiProblemError(error)) return 'errors.generic';
  const slug = problemSlug(error.problem.type);
  const documentKey = slug === undefined ? undefined : DOCUMENT_APPROVAL_KEYS[slug];
  if (documentKey) return documentKey;
  switch (slug) {
    case 'attendance-correction-stale':
      return 'tasks.problems.correctionStale';
    case 'workflow-task-closed':
      return 'tasks.problems.closed';
    case 'workflow-self-approval':
      return 'tasks.problems.selfApproval';
    default:
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 403 || error.status === 404) return 'tasks.problems.notCandidate';
      return 'errors.generic';
  }
}

@Component({
  selector: 'app-tasks-page',
  imports: [
    TranslocoDirective,
    ReactiveFormsModule,
    DatePipe,
    DecimalPipe,
    DisplayNamePipe,
    LeaveRequestView,
    BalanceCards,
    CorrectionPreviewView,
    DayStatusBadge,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tasks.page.html',
  styleUrl: './tasks.page.css',
})
export class TasksPage {
  private readonly api = inject(TasksApi);
  private readonly injector = inject(Injector);
  protected readonly store = inject(TasksBadge);
  protected readonly catalog = inject(LeaveCatalog);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  /** `?task=<id>` (notification / email link), bound by the router. */
  readonly task = input<string | undefined>();
  protected readonly selectedId = linkedSignal<string | undefined, string | null>({
    source: this.task,
    computation: (id) => id ?? null,
  });
  /** The linked task is not (or no longer) open for this user. */
  protected readonly linkedTaskMissing = computed(() => {
    const id = this.task();
    return !!id && this.selectedId() === id && this.store.loaded() && !this.store.items().some((t) => t.id === id);
  });
  /** The selected task, if it is still in the (visible) list. */
  protected readonly selected = computed<OpenTask | undefined>(() => {
    const id = this.selectedId();
    return id ? this.store.items().find((task) => task.id === id) : undefined;
  });
  /**
   * The request id to show, as its own `computed()`. A refresh of the task list builds NEW task objects, so
   * `selected()` changes even when the same task stays selected; a computed returning a string compares by value
   * (`Object.is`), so it does NOT notify when the id is unchanged — and the detail resource is not re-fetched on
   * every list refresh. (Keying the resource on `selected()?.subject.id` directly would.)
   */
  private readonly selectedRequestId = computed(() => {
    const subject = this.selected()?.subject;
    return subject?.type === 'leave_request' ? subject.id : undefined;
  });
  protected readonly detail = inject(LeaveApi).requestResource(this.selectedRequestId);
  /** Same equality gate for a correction task: the correction id, or `undefined` for any other kind. */
  private readonly selectedCorrectionId = computed(() => {
    const subject = this.selected()?.subject;
    return subject?.type === 'attendance_correction' && !subject.purged ? subject.id : undefined;
  });
  protected readonly correction = inject(AttendanceApi).correctionResource(this.selectedCorrectionId);
  /** The day's punches for the before/after view: the detail's when it has them, else the summary's arrival/departure. */
  protected readonly correctionPunches = computed<readonly PreviewSourcePunch[]>(() => {
    const subject = this.selected()?.subject;
    if (subject?.type !== 'attendance_correction' || subject.purged) return [];
    const detail = this.correction.hasValue() ? this.correction.value() : undefined;
    return detail?.id === subject.id && detail.day.punches ? detail.day.punches : punchesOfSummary(subject.day);
  });
  /** A decision error shown inside the panel of the task it is about (the stale correction). */
  protected readonly panelError = signal<{ readonly taskId: string; readonly key: string } | null>(null);

  protected readonly detailBalances = computed(() => {
    const request = this.detail.hasValue() ? this.detail.value() : undefined;
    return (request?.balances ?? []).filter((b) => b.leaveTypeId === request?.leaveTypeId);
  });

  protected readonly feedback = signal<Feedback | null>(null);
  protected readonly acting = signal(false);

  private readonly panelHeading = viewChild<ElementRef<HTMLElement>>('panelHeading');
  private readonly listHeading = viewChild.required<ElementRef<HTMLElement>>('listHeading');

  /** What the task is about, in one line (leave type, or document type): list rows and the reject dialog. */
  protected subjectLabel(task: OpenTask): string {
    const subject = task.subject;
    if (subject.type === 'leave_request') return this.catalog.nameOf(subject.leaveTypeId);
    if (subject.type === 'document_request') return this.catalog.labelOf(subject.documentType.labels);
    return '';
  }

  /** The person a task is about (`null` for a purged correction). */
  protected readonly personOf = (task: OpenTask) => subjectPerson(task.subject);

  protected select(task: OpenTask): void {
    this.selectedId.set(task.id);
  }

  protected approve(task: OpenTask): void {
    this.decide(task, 'approve', this.api.approve(task.id));
  }

  // --- Reject dialog ----------------------------------------------------------------------------------------------

  private readonly rejectDialog = viewChild.required<ElementRef<HTMLDialogElement>>('rejectDialog');
  protected readonly rejecting = signal<OpenTask | null>(null);
  protected readonly rejectForm = inject(NonNullableFormBuilder).group({
    comment: ['', [Validators.required, Validators.maxLength(COMMENT_MAX), Validators.pattern(/\S/)]],
  });

  protected openReject(task: OpenTask): void {
    this.rejecting.set(task);
    this.rejectForm.reset({ comment: '' });
    this.rejectDialog().nativeElement.showModal();
  }

  protected closeReject(): void {
    this.rejectDialog().nativeElement.close();
  }

  protected onRejectClosed(): void {
    this.rejecting.set(null);
  }

  protected submitReject(): void {
    const task = this.rejecting();
    if (!task) return;
    if (this.rejectForm.invalid) {
      this.rejectForm.markAllAsTouched();
      return;
    }
    const comment = this.rejectForm.getRawValue().comment.trim();
    this.closeReject();
    this.decide(task, 'reject', this.api.reject(task.id, { comment }));
  }

  // --- The optimistic part ----------------------------------------------------------------------------------------

  private decide(task: OpenTask, decision: Decision, request$: Observable<unknown>): void {
    const name = this.employeeName(task);
    const next = this.nextAfter(task);
    this.feedback.set(null);
    this.panelError.set(null);
    this.acting.set(true);
    this.store.hide(task.id); // optimistic: gone from the list and the badge, now
    this.selectedId.set(next?.id ?? null);
    this.focusAfterRender();

    request$.subscribe({
      next: () => {
        this.acting.set(false);
        this.feedback.set({ key: `tasks.feedback.${decision === 'approve' ? 'approved' : 'rejected'}`, name, kind: 'ok' });
        this.store.refresh();
      },
      error: (error: unknown) => {
        this.acting.set(false);
        this.store.show(task.id); // rollback: the row is back where it was
        this.selectedId.set(task.id);
        const key = decisionErrorKey(error);
        this.feedback.set({ key, name, kind: 'error' });
        if (key === 'tasks.problems.correctionStale') this.panelError.set({ taskId: task.id, key });
        if (isApiProblemError(error) && problemSlug(error.problem.type) === 'workflow-task-closed') this.store.refresh();
      },
    });
  }

  private nextAfter(task: OpenTask): OpenTask | undefined {
    const items = this.store.items();
    const index = items.findIndex((t) => t.id === task.id);
    return items[index + 1] ?? items[index - 1];
  }

  private employeeName(task: OpenTask): string {
    const p = subjectPerson(task.subject);
    if (!p) return '';
    return this.lang() === 'ar' && p.lastNameAr && p.firstNameAr ? `${p.lastNameAr} ${p.firstNameAr}` : `${p.lastName} ${p.firstName}`;
  }

  private focusAfterRender(): void {
    afterNextRender(
      () => (this.panelHeading() ?? this.listHeading()).nativeElement.focus(),
      { injector: this.injector },
    );
  }
}
