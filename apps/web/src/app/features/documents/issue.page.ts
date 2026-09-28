/**
 * /documents/new?type=&employee=&leaveRequest= — issue a numbered document (`document.issue`): type, employee, for a
 * titre de congé one of the employee's APPROVED leave requests, language, signatory; "Preview" opens a specimen PDF in
 * a new tab (no number consumed), "Issue" allocates the number, stores the PDF and opens the detail page
 * (docs/contracts/documents.md › Web › Issue).
 *
 * Angular concepts:
 * - **Form values as signals.** `toSignal(control.valueChanges, { initialValue })` turns the type and employee
 *   controls into signals, so resources can be keyed on them: the signatories covering the chosen employee
 *   (`GET /documents/signatories?employmentId=`) and, for a titre de congé, the employee's approved leave requests.
 *   Picking another employee re-sends both; the resources cancel what is still in flight.
 * - **`effect()` to push server defaults INTO the form**, guarded by `untracked()` for everything it must not depend
 *   on: when the signatories arrive, the type's default signatory (else the nearest one) is preselected; when the type
 *   changes, the language falls back to one the type is printed in. (Deriving is a `computed()`'s job; writing into a
 *   form control is a side effect, so an effect.)
 * - **A control that exists only for one type**: `leaveRequestId` is DISABLED unless the type is `titre_conge`. A
 *   disabled control does not count for validity and `getRawValue()` still reads it, so `body()` decides what to send.
 * - **Prefill from query params in `ngOnInit`** (inputs are set by then; chapter 14 "prefill via required input"):
 *   `?employee=` and `?leaveRequest=` come from the employee Documents tab and the leave request page.
 * - **Idempotent submit**: a `clientRequestId` (UUID) is created for the first submit of a form fill and reused if
 *   the user retries after a network error — the API then answers 200 with the SAME document instead of issuing a
 *   second number. Any change to the form starts a new fill (the id is dropped). The button is disabled while pending.
 * - **Preview = a POST that returns a PDF**, opened with the page's own `BlobFiles` (`providers: [BlobFiles]`):
 *   `files.open()` must run inside the click, which is why `preview()` validates synchronously first.
 * - **Problems**: `document-profile-incomplete` lists the missing letterhead fields (a banner, with a link to the
 *   settings for users holding `document.configure`); the other slugs go through `problemToForm()` (document-forms.ts).
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, type OnInit, signal, untracked } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from '../../core/auth/session';
import { BlobFiles } from '../../core/browser/blob-files';
import { newUuid } from '../../core/browser/uuid';
import { DocumentCatalog } from '../../core/documents/document-catalog';
import { DocumentsApi } from '../../core/documents/documents-api';
import type { DocumentLanguage, IssueBody, SignatoryView } from '../../core/documents/documents.models';
import { EmployeesApi } from '../../core/employees/employees-api';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveApi } from '../../core/leave/leave-api';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import { DEFAULT_LEAVE_QUERY, type LeaveRequestSummary } from '../../core/leave/leave.models';
import { EmployeePicker } from '../../shared/employee-picker/employee-picker';
import { pdfErrorKey } from '../../shared/documents/pdf-actions';
import { ISSUE_SLUGS, missingProfileFields } from './document-forms';

export const TITRE_CONGE = 'titre_conge';

@Component({
  selector: 'app-documents-issue-page',
  imports: [TranslocoDirective, ReactiveFormsModule, RouterLink, DatePipe, EmployeePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [BlobFiles],
  templateUrl: './issue.page.html',
  styleUrl: './documents.css',
})
export class IssuePage implements OnInit {
  private readonly api = inject(DocumentsApi);
  private readonly router = inject(Router);
  private readonly files = inject(BlobFiles);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly catalog = inject(DocumentCatalog);
  protected readonly leaveCatalog = inject(LeaveCatalog);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly canConfigure = inject(Session).allows('document.configure');

  // Query params (entry points from other pages), bound by the router.
  readonly type = input<string | undefined>();
  readonly employee = input<string | undefined>();
  readonly leaveRequest = input<string | undefined>();

  protected readonly form = this.fb.group({
    typeCode: ['', Validators.required],
    employmentId: this.fb.control<string | null>(null, Validators.required),
    leaveRequestId: this.fb.control({ value: '', disabled: true }, Validators.required),
    language: this.fb.control<DocumentLanguage>('fr'),
    /** '' = let the server choose (the type's default, else the nearest signatory up the unit tree). */
    signatoryId: [''],
  });

  private readonly typeCode = toSignal(this.form.controls.typeCode.valueChanges, { initialValue: '' });
  private readonly employmentId = toSignal(this.form.controls.employmentId.valueChanges, { initialValue: null });
  protected readonly selectedType = computed(() => this.catalog.type(this.typeCode()));
  protected readonly isTitre = computed(() => this.typeCode() === TITRE_CONGE);
  protected readonly languages = computed<readonly DocumentLanguage[]>(() => this.selectedType()?.languages ?? ['fr', 'ar']);

  protected readonly signatories = this.api.signatoriesForResource(this.employmentId);
  protected readonly signatoryItems = computed<readonly SignatoryView[]>(() =>
    this.signatories.hasValue() ? this.signatories.value().items : [],
  );

  // --- Titre de congé: the employee's approved leave requests ------------------------------------------------------

  /** The chosen employee (only for a titre: its matricule searches the leave list). */
  private readonly employeeDetail = inject(EmployeesApi).detailResource(() => (this.isTitre() ? this.employmentId() : null));
  private readonly leaveApi = inject(LeaveApi);
  protected readonly approvedLeave = this.leaveApi.listResource(() => {
    const e = this.employeeDetail.hasValue() ? this.employeeDetail.value() : undefined;
    if (!this.isTitre() || !e || e.id !== this.employmentId()) return undefined;
    return { ...DEFAULT_LEAVE_QUERY, q: e.matricule, status: 'approved', pageSize: 100 };
  });
  protected readonly leaveItems = computed<readonly LeaveRequestSummary[]>(() => {
    const id = this.employmentId();
    return this.approvedLeave.hasValue() ? this.approvedLeave.value().items.filter((r) => r.employee.id === id) : [];
  });
  /** `?leaveRequest=` without `?employee=`: the request names its employee. */
  private readonly presetRequest = this.leaveApi.requestResource(() => (this.employee() ? null : this.leaveRequest()));

  // --- Submit state ---------------------------------------------------------------------------------------------

  protected readonly issuing = signal(false);
  protected readonly previewing = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  /** Missing letterhead fields of a `document-profile-incomplete` answer (`null` = not that problem). */
  protected readonly profileMissing = signal<readonly string[] | null>(null);
  private clientRequestId: string | null = null;

  constructor() {
    // Type from ?type= (when it names an active type) or the first active type, once the catalogue is known.
    effect(() => {
      const active = this.catalog.activeTypes();
      if (!active.length || untracked(() => this.form.controls.typeCode.value)) return;
      const wanted = untracked(this.type);
      this.form.controls.typeCode.setValue(active.some((t) => t.code === wanted) ? (wanted ?? '') : (active[0]?.code ?? ''));
    });
    // Language: Arabic when the UI is Arabic, else French — restricted to the type's languages.
    effect(() => {
      const allowed = this.languages();
      const preferred: DocumentLanguage = untracked(this.lang) === 'ar' ? 'ar' : 'fr';
      const current = untracked(() => this.form.controls.language.value);
      if (!allowed.includes(current) || !this.form.controls.language.dirty) {
        this.form.controls.language.setValue(allowed.includes(preferred) ? preferred : (allowed[0] ?? 'fr'));
      }
    });
    // The leave request select exists only for a titre de congé.
    effect(() => {
      const control = this.form.controls.leaveRequestId;
      if (this.isTitre()) control.enable({ emitEvent: false });
      else control.disable({ emitEvent: false });
    });
    // Signatory: the type's default, else the nearest one (the API lists nearest first).
    effect(() => {
      const items = this.signatoryItems();
      const code = this.typeCode();
      const chosen = items.find((s) => s.defaultFor.includes(code)) ?? items[0];
      untracked(() => this.form.controls.signatoryId.setValue(chosen?.id ?? ''));
    });
    effect(() => {
      const request = this.presetRequest.hasValue() ? this.presetRequest.value() : undefined;
      if (request && !untracked(() => this.form.controls.employmentId.value)) {
        this.form.controls.employmentId.setValue(request.employee.id);
      }
    });
    // A new fill of the form = a new idempotency key.
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.clientRequestId = null;
    });
  }

  ngOnInit(): void {
    const employee = this.employee();
    if (employee) this.form.controls.employmentId.setValue(employee);
    const leaveRequest = this.leaveRequest();
    if (leaveRequest) this.form.controls.leaveRequestId.setValue(leaveRequest);
  }

  protected signatoryLabel(s: SignatoryView): string {
    const lang = this.form.controls.language.value;
    return `${s.names[lang]} — ${s.titles[lang]}`;
  }

  /** The request body, or `null` (and every error shown) when the form is invalid. */
  private body(): IssueBody | null {
    this.formError.set(null);
    this.profileMissing.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return null;
    }
    const v = this.form.getRawValue();
    const subject = v.typeCode === TITRE_CONGE ? { leaveRequestId: v.leaveRequestId } : { employmentId: v.employmentId ?? '' };
    return { typeCode: v.typeCode, ...subject, language: v.language, ...(v.signatoryId ? { signatoryId: v.signatoryId } : {}) };
  }

  protected preview(): void {
    const body = this.body();
    if (!body) return;
    this.previewing.set(true);
    this.files.open(this.api.preview(body), `${body.typeCode}-preview.pdf`).subscribe({
      next: () => this.previewing.set(false),
      error: (error: unknown) => {
        this.previewing.set(false);
        this.fail(error, true);
      },
    });
  }

  protected issue(): void {
    const body = this.body();
    if (!body || this.issuing()) return;
    this.clientRequestId ??= newUuid();
    this.issuing.set(true);
    this.api.issue({ ...body, clientRequestId: this.clientRequestId }).subscribe({
      next: (document) => {
        void this.router.navigate(['/documents', document.id], { queryParams: { issued: 1 } });
      },
      error: (error: unknown) => {
        this.issuing.set(false);
        this.fail(error, false);
      },
    });
  }

  private fail(error: unknown, preview: boolean): void {
    const missing = missingProfileFields(error);
    if (missing) {
      this.profileMissing.set(missing);
      return;
    }
    const message = problemToForm(this.form, error, ISSUE_SLUGS, 'documents.problems.subjectNotFound');
    // A preview failure that is not a business rule (e.g. the network) reads like a PDF failure.
    this.formError.set(preview && message && 'key' in message && message.key === 'errors.generic' ? { key: pdfErrorKey(error) } : message);
  }
}
