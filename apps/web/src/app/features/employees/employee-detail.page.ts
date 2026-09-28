/**
 * /employees/:id — one employee: header (name, matricule, unit, status), tabs Identity · Assignments · Pay ·
 * Bank & NSS · History, and "End employment" (a native `<dialog>`). Buttons come from the server's `_actions`,
 * sensitive tabs from `_redacted` (docs/contracts/employment.md › Web).
 *
 * Angular concepts:
 * - **Route param → input → resource.** `:id` arrives as `id = input.required<string>()`
 *   (`withComponentInputBinding()`), and `employee = api.detailResource(this.id)` re-fetches when it changes —
 *   following a link from one employee to another reuses this component, only the input changes.
 * - **Reload after writes.** Every form emits `saved`; the page then calls `employee.reload()`. The resource keeps
 *   its current value while reloading (status `reloading`), so nothing flashes, and the server's answer — new
 *   assignment history, new `_actions`, a status that became `ended` — replaces it. The page does NOT patch the
 *   detail by hand from what it sent: derived fields (the previous assignment's end, the effective site) are the
 *   server's to compute.
 * - **Tabs as a LOCAL signal, not child routes.** `tab` is a `linkedSignal` of `id` (back to Identity when another
 *   employee opens). Child routes (`/employees/:id/pay`) would give each tab a URL, but every tab shows the SAME
 *   loaded detail: child routes would need it shared through a service or a resolver, and a hidden tab (redacted
 *   pay) would also need a guard. Here a tab is a view of data already on the page, so a signal is enough; the
 *   list, whose state IS worth sharing, keeps its state in the URL (employees.page.ts).
 * - **Visible tabs are a `computed()`** of the detail's `_redacted` and the session's `audit.read`. If a reload
 *   redacts the tab being shown, `activeTab` falls back to Identity instead of rendering an empty panel.
 * - **Buttons from `_actions`** (`update`, `assign`, `end`, `update_salary`…): the server evaluated the caller's
 *   scope on THIS employee's unit; `Session.can()` only says "somewhere". (chapter 12)
 * - **`@defer (on viewport)`** for the History tab's timeline, as in shared/timeline/history-tabs.ts: its code is
 *   downloaded only when the tab is opened (and prefetched when idle).
 * - **Native `<dialog>` + `viewChild.required()`** for "End employment" (reason select + date), as in the Access
 *   user page: `showModal()` makes the page inert and traps focus; `(close)` cleans up however it was closed.
 * - **Leave tab** (`leave.read`): a child component (`<app-employee-leave-tab>`, employee-leave-tab.ts) that owns its
 *   own resources (balances, ledger), so they are only requested when the tab is opened — `@switch` renders just the
 *   active panel, and a component that is not rendered is not created.
 * - **Documents tab** (`document.read`): `<app-employee-documents-tab>` (employee-documents-tab.ts), same idea as the
 *   Leave tab — its own resource, created only when the tab is rendered.
 * - **"Rehire"** is a link to `/employees/:id/rehire`, shown when the employment has an end date and the session
 *   holds `employee.create` (not an `_actions` entry: it creates a NEW employment, whose unit is not known yet).
 * - **`DecimalPipe` with an explicit locale** for money (`"85000.00" | number: '1.2-2' : locale()`): the string is
 *   formatted, never added to or rounded (money stays a decimal string, see core/employees/employees.models.ts).
 */
import { DecimalPipe } from '@angular/common';
import {
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
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from '../../core/auth/session';
import { todayIso } from '../../core/date/iso-date';
import { EmployeesApi } from '../../core/employees/employees-api';
import {
  END_REASONS,
  type EmployeeAction,
  type EmployeeDetail,
  employeeActions,
  type EndReason,
  isRedacted,
} from '../../core/employees/employees.models';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import type { FormMessage } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import { DisplayNamePipe, displayNameOf } from '../../shared/display-name/display-name.pipe';
import { Timeline } from '../../shared/timeline/timeline';
import type { AuditNameResolver } from '../../shared/timeline/timeline-view';
import { AssignmentForm } from './assignment-form';
import { employeeProblemToForm, END_SLUGS, isoDate, notBefore } from './employee-forms';
import { EmployeeDocumentsTab } from './employee-documents-tab';
import { EmployeeLeaveTab } from './employee-leave-tab';
import { FieldError } from './field-error';
import { PersonForm } from './person-form';
import { BankForm, NssForm, SalaryForm } from './sensitive-forms';

export type EmployeeTab = 'identity' | 'assignments' | 'pay' | 'bank' | 'leave' | 'documents' | 'history';
type Editing = 'person' | 'assignment' | 'salary' | 'bank' | 'nss';

@Component({
  selector: 'app-employee-detail-page',
  imports: [
    TranslocoDirective,
    RouterLink,
    ReactiveFormsModule,
    DecimalPipe,
    DisplayNamePipe,
    FieldError,
    PersonForm,
    AssignmentForm,
    SalaryForm,
    BankForm,
    NssForm,
    Timeline,
    EmployeeLeaveTab,
    EmployeeDocumentsTab,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './employee-detail.page.html',
  styleUrl: './employees.css',
})
export class EmployeeDetailPage {
  private readonly api = inject(EmployeesApi);
  private readonly canAudit = inject(Session).allows('audit.read');
  /** Leave tab (docs/contracts/leave.md › Web): balances and ledger need `leave.read` (held anywhere; the API scopes). */
  private readonly canLeave = inject(Session).allows('leave.read');
  /** Documents tab (docs/contracts/documents.md › Web): the register rows of this employee need `document.read`. */
  private readonly canDocuments = inject(Session).allows('document.read');
  /** "Rehire" on an employment with an end date (employee-rehire.page.ts); the route has the same guard. */
  protected readonly canRehire = inject(Session).allows('employee.create');
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  /** `:id` of the route (the employment id). */
  readonly id = input.required<string>();

  protected readonly employee = this.api.detailResource(this.id);
  protected readonly detail = computed<EmployeeDetail | undefined>(() =>
    this.employee.hasValue() ? this.employee.value() : undefined,
  );
  protected readonly notFound = computed(() => {
    const error = this.employee.error();
    return isApiProblemError(error) && error.status === 404;
  });
  protected readonly errorKey = computed(() => {
    const error = this.employee.error();
    if (!isApiProblemError(error)) return 'employees.detail.loadError';
    if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
    if (error.status === 404) return 'employees.problems.notFound';
    if (error.status === 403) return 'errors.forbidden';
    return 'employees.detail.loadError';
  });

  protected readonly actions = computed<readonly EmployeeAction[]>(() => {
    const e = this.detail();
    return e ? employeeActions(e) : [];
  });

  /** Tabs this caller may see for this employee. */
  protected readonly tabs = computed<readonly EmployeeTab[]>(() => {
    const e = this.detail();
    const tabs: EmployeeTab[] = ['identity', 'assignments'];
    if (e && !isRedacted(e, 'salary')) tabs.push('pay');
    if (e && (!isRedacted(e, 'bank') || !isRedacted(e, 'nss'))) tabs.push('bank');
    if (this.canLeave()) tabs.push('leave');
    if (this.canDocuments()) tabs.push('documents');
    if (this.canAudit()) tabs.push('history');
    return tabs;
  });
  protected readonly tab = linkedSignal<string, EmployeeTab>({ source: this.id, computation: () => 'identity' });
  protected readonly activeTab = computed<EmployeeTab>(() => (this.tabs().includes(this.tab()) ? this.tab() : 'identity'));
  protected readonly editing = linkedSignal<string, Editing | null>({ source: this.id, computation: () => null });
  protected readonly feedback = signal<string | null>(null);

  /** Asked for only when the History tab names a leave type: opening an employee must not load the leave catalogue. */
  private readonly injector = inject(Injector);

  /**
   * Names for ids in the History tab: units and sites of this employee's assignments, and leave types (the tab also
   * lists the employee's leave requests and their approval events — notifications contract › Audit gap).
   */
  protected readonly auditNames: AuditNameResolver = (kind, value) => {
    if (kind === 'leaveType') {
      const catalog = this.injector.get(LeaveCatalog);
      return catalog.type(value) ? catalog.nameOf(value) : undefined;
    }
    const e = this.detail();
    if (!e) return undefined;
    for (const a of e.assignments) {
      if (kind === 'unit' && a.unit.id === value) return displayNameOf(a.unit, this.lang());
      if (kind === 'site' && a.site?.id === value) return a.site.name;
    }
    return undefined;
  };

  protected readonly redacted = isRedacted;

  protected can(action: EmployeeAction): boolean {
    return this.actions().includes(action);
  }

  protected select(tab: EmployeeTab): void {
    this.tab.set(tab);
    this.editing.set(null);
  }

  protected edit(what: Editing): void {
    this.feedback.set(null);
    this.editing.set(what);
  }

  /** A form saved: close it, say so, and re-read the detail from the server. */
  protected onSaved(key: string): void {
    this.editing.set(null);
    this.feedback.set(key);
    this.employee.reload();
  }

  // --- End employment dialog ------------------------------------------------------------------------------------

  private readonly endDialog = viewChild.required<ElementRef<HTMLDialogElement>>('endDialog');
  protected readonly endReasons = END_REASONS;
  protected readonly endSubmitting = signal(false);
  protected readonly endError = signal<FormMessage | null>(null);

  /** Earliest end date: the current assignment's start (contract `end-date`: ≥ it and ≥ the hire date). */
  private endMin(): string | null {
    const e = this.detail();
    if (!e) return null;
    const start = e.assignments[0]?.validFrom ?? e.hireDate;
    return start > e.hireDate ? start : e.hireDate;
  }

  protected readonly endForm = inject(NonNullableFormBuilder).group({
    reason: inject(NonNullableFormBuilder).control<EndReason | ''>('', Validators.required),
    endDate: ['', [Validators.required, isoDate, notBefore(() => this.endMin())]],
  });

  protected openEnd(): void {
    this.feedback.set(null);
    this.endError.set(null);
    this.endForm.reset({ reason: '', endDate: todayIso() });
    this.endDialog().nativeElement.showModal();
  }

  protected cancelEnd(): void {
    this.endDialog().nativeElement.close();
  }

  protected onEndClosed(): void {
    this.endSubmitting.set(false);
  }

  protected submitEnd(): void {
    const e = this.detail();
    this.endError.set(null);
    if (!e) return;
    if (this.endForm.invalid) {
      this.endForm.markAllAsTouched();
      return;
    }
    const { reason, endDate } = this.endForm.getRawValue();
    if (reason === '') return;
    this.endSubmitting.set(true);
    this.api.end(e.id, { endDate, reason }).subscribe({
      next: () => {
        this.endDialog().nativeElement.close();
        this.onSaved('employees.feedback.ended');
      },
      error: (error: unknown) => {
        this.endError.set(employeeProblemToForm(this.endForm, error, END_SLUGS));
        this.endSubmitting.set(false);
      },
    });
  }
}
