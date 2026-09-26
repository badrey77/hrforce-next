/**
 * Leave types table with INLINE edit (numbers and labels) — part of /leave/settings (`leave.configure`).
 *
 * Angular concepts:
 * - **Inline edit = one form, one `editingId` signal.** Only one row is edited at a time, so a single `FormGroup` is
 *   enough: "Edit" resets it with that row's values and sets `editingId`; the `@for` renders inputs for the row whose
 *   id matches and plain cells for the others. (One FormGroup per row — a `FormArray` — would pay off only if several
 *   rows could be edited and saved together.)
 * - **Number inputs in a typed form**: `<input type="number" formControlName>` uses Angular's NumberValueAccessor,
 *   which writes a `number` — or `null` for an empty box — into a `FormControl<number | null>`. "Empty" therefore
 *   maps straight to the API's `null` ("no limit"); `Validators.min()`/`max()` check the rest.
 * - **After a save, reload the SHARED catalogue** (`LeaveCatalog.reload()`): every screen that shows a type name reads
 *   that one root resource, so a renamed type is renamed everywhere without further code.
 */
import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveApi } from '../../core/leave/leave-api';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import type { LeaveType, UpdateLeaveType } from '../../core/leave/leave.models';
import { leaveErrorKey } from '../../shared/leave/leave-forms';

export const LABEL_MAX = 120;

@Component({
  selector: 'app-leave-types-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './leave-types-settings.html',
})
export class LeaveTypesSettings {
  private readonly api = inject(LeaveApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly catalog = inject(LeaveCatalog);
  private readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  protected readonly editingId = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly errorKey = leaveErrorKey;

  protected readonly form = this.fb.group({
    labels: this.fb.group({
      fr: ['', [Validators.required, Validators.maxLength(LABEL_MAX)]],
      ar: ['', [Validators.required, Validators.maxLength(LABEL_MAX)]],
      en: ['', [Validators.required, Validators.maxLength(LABEL_MAX)]],
    }),
    // Empty = null = "no limit"; otherwise positive (the API refuses 0: leave the box empty instead).
    accrualDaysPerMonth: this.fb.control<number | null>(null, [Validators.min(0.01), Validators.max(31)]),
    maxDaysPerYear: this.fb.control<number | null>(null, [Validators.min(0.5), Validators.max(366)]),
    maxDaysPerRequest: this.fb.control<number | null>(null, [Validators.min(0.5), Validators.max(366)]),
    requiresDocument: [false],
    active: [true],
  });

  protected edit(type: LeaveType): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({
      labels: { ...type.labels },
      accrualDaysPerMonth: type.accrualDaysPerMonth,
      maxDaysPerYear: type.maxDaysPerYear,
      maxDaysPerRequest: type.maxDaysPerRequest,
      requiresDocument: type.requiresDocument,
      active: type.active,
    });
    this.editingId.set(type.id);
  }

  protected cancel(): void {
    this.editingId.set(null);
  }

  protected save(type: LeaveType): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const body: UpdateLeaveType = {
      labels: { fr: v.labels.fr.trim(), ar: v.labels.ar.trim(), en: v.labels.en.trim() },
      accrualDaysPerMonth: v.accrualDaysPerMonth,
      maxDaysPerYear: v.maxDaysPerYear,
      maxDaysPerRequest: v.maxDaysPerRequest,
      requiresDocument: v.requiresDocument,
      active: v.active,
    };
    this.saving.set(true);
    this.api.updateType(type.id, body).subscribe({
      next: () => {
        this.saving.set(false);
        this.editingId.set(null);
        this.feedback.set('leave.settings.types.saved');
        this.catalog.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(problemToForm(this.form, error, {}));
      },
    });
  }
}
