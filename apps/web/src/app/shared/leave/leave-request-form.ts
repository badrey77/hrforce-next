/**
 * `<app-leave-request-form [employmentId]="…" (saved)="…" (notLinked)="…" />` — a leave request with a LIVE PREVIEW
 * of the days it will cost: as the user picks a type and dates, `POST /api/leave/preview` answers with the days
 * counted, the breakdown (weekend days, public holidays by name, half days) and the balance after.
 * Without `employmentId` it is the self-service form (`POST /me/leave/requests`); with it, HR's "request on behalf"
 * (`POST /employees/:id/leave/requests`). Lives in shared/ because My leave and the employee page both use it.
 *
 * Angular concepts:
 * - **A live preview = form changes → debounced signal → resource.**
 *     form.valueChanges ─debounceTime(400)─ map(previewRequest) ─distinctUntilChanged─▶ toSignal ─▶ httpResource(POST)
 *   RxJS does what it is best at — TIME (wait until typing pauses) and dropping duplicates (changing the reason does
 *   not change the preview body, so no request); `toSignal()` hands the result to the signal world; the
 *   `httpResource` (core/leave/leave-api.ts `previewResource`) does the HTTP part: a new body cancels the request in
 *   flight, `value()` always answers the LATEST body, `isLoading()`/`error()` drive the template. `undefined` (form
 *   incomplete) leaves the resource idle: no request for a half-typed date.
 *   Why the debounce is not optional: a date input fires on each digit typed; without it, "2026-10-15" typed by hand
 *   would send several previews of impossible dates.
 * - **Why a POST can be a read** (see leave-api.ts): the preview writes nothing; it is safe to send, repeat or cancel.
 *   So it is modelled as data derived from the form (a resource), not as an action (a `subscribe()` in a handler).
 *   The real write, `submit()`, IS an action: one explicit `subscribe()` per click, never cancelled by typing.
 * - **`toSignal()` needs an initial value** (`initialValue: undefined`): a signal always has a value, an Observable
 *   may not have emitted yet. `toSignal` subscribes in the constructor's injection context and unsubscribes when the
 *   component is destroyed.
 * - **Validators that depend on another control**: `documentRef` is required for types that require a document
 *   (sick leave). Its validator reads the selected type; a subscription re-runs it when the type changes.
 * - **Server rules → where the user can act**: `LEAVE_REQUEST_SLUGS` (leave-forms.ts) + `problemToForm()`;
 *   `leave-not-linked` is raised to the page through the `notLinked` output instead (nothing in the form can fix it).
 * - **Outputs** (`output()`): `saved` hands the created request to the page, which refreshes its lists and balances.
 */
import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, type Signal, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime, distinctUntilChanged, map, startWith } from 'rxjs';
import { isIsoDate, todayIso } from '../../core/date/iso-date';
import { isApiProblemError } from '../../core/http/api-problem';
import { type FormMessage, problemSlug, problemToForm } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveApi } from '../../core/leave/leave-api';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import type { LeavePreviewRequest, LeaveRequestDetail, LeaveType, NewLeaveRequest } from '../../core/leave/leave.models';
import {
  DOCUMENT_REF_MAX,
  documentRequired,
  endNotBeforeStart,
  halfDaysOnOneDay,
  isoDate,
  LEAVE_REQUEST_SLUGS,
  leaveErrorKey,
  REASON_MAX,
} from './leave-forms';

/** How long the form must stay still before a preview is requested. */
export const LEAVE_PREVIEW_DEBOUNCE_MS = 400;

let nextId = 0;

@Component({
  selector: 'app-leave-request-form',
  imports: [ReactiveFormsModule, TranslocoDirective, DatePipe, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './leave-request-form.html',
  styleUrl: './leave-request-form.css',
})
export class LeaveRequestForm {
  private readonly api = inject(LeaveApi);
  protected readonly catalog = inject(LeaveCatalog);
  private readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  private readonly fb = inject(NonNullableFormBuilder);

  /** The employee a request is made FOR (HR on behalf); `null` = the signed-in user (self-service). */
  readonly employmentId = input<string | null>(null);
  readonly saved = output<LeaveRequestDetail>();
  readonly notLinked = output<void>();
  readonly cancelled = output<void>();
  /** Show a Cancel button (the employee page's inline form); My leave keeps the form always open. */
  readonly cancellable = input(false);

  /** Prefix for element ids: two forms on one page must not share ids. */
  protected readonly ids = `leave-form-${nextId++}`;

  protected readonly form = this.fb.group(
    {
      leaveTypeId: ['', Validators.required],
      startDate: [todayIso(), [Validators.required, isoDate]],
      endDate: [todayIso(), [Validators.required, isoDate]],
      halfDayStart: [false],
      halfDayEnd: [false],
      reason: ['', Validators.maxLength(REASON_MAX)],
      // `?.()`: a control runs its validators once while being CREATED, before `selectedType` (declared below) exists.
      documentRef: ['', [Validators.maxLength(DOCUMENT_REF_MAX), documentRequired(() => this.selectedType?.())]],
    },
    { validators: [endNotBeforeStart, halfDaysOnOneDay] },
  );
  protected readonly c = this.form.controls;

  private readonly typeId: Signal<string> = toSignal(this.c.leaveTypeId.valueChanges, { initialValue: '' });
  // Explicit type: the form's validator reads this signal, and TypeScript cannot infer a type through that cycle.
  protected readonly selectedType: Signal<LeaveType | undefined> = computed(() => this.catalog.type(this.typeId()));

  /** The preview body, once the form has been still for LEAVE_PREVIEW_DEBOUNCE_MS (see header). */
  private readonly previewBody: Signal<LeavePreviewRequest | undefined> = toSignal(
    this.form.valueChanges.pipe(
      startWith(null),
      debounceTime(LEAVE_PREVIEW_DEBOUNCE_MS),
      map((): LeavePreviewRequest | undefined => this.previewRequest()),
      distinctUntilChanged<LeavePreviewRequest | undefined>((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    ),
    { initialValue: undefined },
  );
  protected readonly preview = this.api.previewResource(this.previewBody);
  protected readonly previewErrorKey = computed(() => {
    const error = this.preview.error();
    const slug = isApiProblemError(error) ? problemSlug(error.problem.type) : undefined;
    return (slug && LEAVE_REQUEST_SLUGS[slug]?.key) || 'leave.preview.error';
  });
  /** Preview warnings (slugs) → translated messages, minus `leave-balance` when the negative balance already says it. */
  protected readonly warningKeys = computed(() => {
    const preview = this.preview.hasValue() ? this.preview.value() : undefined;
    const over = preview?.balanceAfter !== null && preview?.balanceAfter !== undefined && preview.balanceAfter < 0;
    return (preview?.warnings ?? [])
      .filter((slug) => !(over && slug === 'leave-balance'))
      .map((slug) => LEAVE_REQUEST_SLUGS[slug]?.key ?? 'leave.preview.warning');
  });
  /** Half days in the request (0–2), from the form: the preview's `days` already accounts for them. */
  protected readonly halfDays = toSignal(
    this.form.valueChanges.pipe(map(() => Number(this.c.halfDayStart.value) + Number(this.c.halfDayEnd.value))),
    { initialValue: 0 },
  );

  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly errorKey = leaveErrorKey;

  constructor() {
    // documentRef's validator reads the type: re-run it when the type changes.
    this.c.leaveTypeId.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.c.documentRef.updateValueAndValidity({ emitEvent: false }));
  }

  /** The body the preview can count, or `undefined` while the type or the dates are missing or inconsistent. */
  private previewRequest(): LeavePreviewRequest | undefined {
    const v = this.form.getRawValue();
    if (!v.leaveTypeId || !isIsoDate(v.startDate) || !isIsoDate(v.endDate) || v.endDate < v.startDate) return undefined;
    const employmentId = this.employmentId();
    return {
      ...(employmentId ? { employmentId } : {}),
      leaveTypeId: v.leaveTypeId,
      startDate: v.startDate,
      endDate: v.endDate,
      halfDayStart: v.halfDayStart,
      halfDayEnd: v.halfDayEnd,
    };
  }

  private body(): NewLeaveRequest {
    const v = this.form.getRawValue();
    const reason = v.reason.trim();
    const documentRef = v.documentRef.trim();
    return {
      leaveTypeId: v.leaveTypeId,
      startDate: v.startDate,
      endDate: v.endDate,
      halfDayStart: v.halfDayStart,
      halfDayEnd: v.halfDayEnd,
      ...(reason ? { reason } : {}),
      ...(documentRef ? { documentRef } : {}),
    };
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const employmentId = this.employmentId();
    const request$ = employmentId ? this.api.requestOnBehalf(employmentId, this.body()) : this.api.requestSelf(this.body());
    this.submitting.set(true);
    request$.subscribe({
      next: (created) => {
        this.submitting.set(false);
        this.form.reset({ leaveTypeId: '', startDate: todayIso(), endDate: todayIso() });
        this.saved.emit(created);
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        if (isApiProblemError(error) && problemSlug(error.problem.type) === 'leave-not-linked') {
          this.notLinked.emit();
          return;
        }
        this.formError.set(problemToForm(this.form, error, LEAVE_REQUEST_SLUGS, 'leave.problems.employeeNotFound'));
      },
    });
  }
}
