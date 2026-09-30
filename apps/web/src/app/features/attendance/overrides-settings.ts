/**
 * Settings › Horaires, second half: date-bounded overrides (docs/contracts/attendance.md › Data, assumption 3) — e.g.
 * Ramadan hours for every schedule of the company, or for one schedule. A list per year, with create / edit / delete;
 * an `approximate` badge as for lunar holidays (HR confirms the dates each year).
 *
 * Angular concepts:
 * - **A resource keyed on a number signal** (`year`): ‹ › change the year, `overridesResource(this.year)` re-fetches.
 * - **One form for "create" and "edit"**: `editing` holds the override being edited (or `'new'`); submit picks POST or
 *   PUT from it. The form is reset from the item when the panel opens (a click, so a plain method).
 * - **A `<select>` whose "all" option is `null`**: `[ngValue]="null"` (not `value=""`) keeps the control typed
 *   `string | null`, which is exactly the API's `scheduleId: string | null` (chapter 07's "inherit" option).
 * - **Confirm-before-delete inline** (`confirming` signal): a small two-button row instead of a modal — deleting an
 *   override is reversible by re-creating it, so a lighter confirmation fits (a revocation, final, gets a dialog).
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Observable } from 'rxjs';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import { type OverrideView, TOLERANCE_MAX, type Week, type WeekDay } from '../../core/attendance/attendance.models';
import type { FormMessage } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { attendanceProblemToForm } from '../../shared/attendance/attendance-forms';
import { ControlError } from '../../shared/attendance/control-error';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { OVERRIDE_CODES, OVERRIDE_SLUGS } from './settings-problems';
import { WeekEditor } from './week-editor';
import { resetWeek, weekForm, weekFromForm } from './week-form';

/** Ramadan-style default for a new override: Sun–Thu 09:00–16:00, no break (contract assumption 3). */
export function shortWeek(): Week {
  return ([1, 2, 3, 4, 5, 6, 7] as const).map((day): WeekDay =>
    day === 5 || day === 6 ? { day, rest: true } : { day, start: '09:00', end: '16:00', breakStart: null, breakEnd: null },
  );
}

@Component({
  selector: 'app-attendance-overrides-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe, RevealAlert, WeekEditor, ControlError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overrides-settings.html',
  styles: `
    .year { display: flex; align-items: center; gap: var(--space-2); }
    .year strong { min-inline-size: 4rem; text-align: center; }
  `,
})
export class OverridesSettings {
  private readonly api = inject(AttendanceApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly toleranceMax = TOLERANCE_MAX;

  protected readonly year = signal(new Date().getFullYear());
  protected readonly list = this.api.overridesResource(this.year);
  protected readonly items = computed(() => (this.list.hasValue() ? this.list.value().items : []));
  private readonly schedulesList = this.api.schedulesResource();
  protected readonly schedules = computed(() => (this.schedulesList.hasValue() ? this.schedulesList.value().items : []));

  protected readonly editing = signal<OverrideView | 'new' | null>(null);
  protected readonly confirming = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);

  protected readonly form = this.fb.group({
    scheduleId: this.fb.control<string | null>(null),
    fr: ['', [Validators.required, Validators.maxLength(120)]],
    ar: ['', [Validators.required, Validators.maxLength(120)]],
    en: ['', [Validators.required, Validators.maxLength(120)]],
    from: ['', Validators.required],
    to: ['', Validators.required],
    toleranceMinutes: [10, [Validators.required, Validators.min(0), Validators.max(TOLERANCE_MAX)]],
    approximate: [false],
    week: weekForm(shortWeek()),
  });

  protected label(labels: OverrideView['labels']): string {
    return pickLabel(labels, this.lang());
  }

  protected shiftYear(delta: number): void {
    this.year.update((y) => y + delta);
  }

  protected open(item: OverrideView | 'new'): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.confirming.set(null);
    if (item === 'new') {
      this.form.reset({ scheduleId: null, fr: '', ar: '', en: '', from: '', to: '', toleranceMinutes: 10, approximate: false });
      resetWeek(this.form.controls.week, shortWeek());
    } else {
      this.form.reset({
        scheduleId: item.schedule?.id ?? null,
        fr: item.labels.fr,
        ar: item.labels.ar,
        en: item.labels.en,
        from: item.from,
        to: item.to,
        toleranceMinutes: item.toleranceMinutes,
        approximate: item.approximate,
      });
      resetWeek(this.form.controls.week, item.week);
    }
    this.editing.set(item);
  }

  protected close(): void {
    this.editing.set(null);
    this.formError.set(null);
  }

  protected submit(): void {
    const editing = this.editing();
    this.formError.set(null);
    if (!editing) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const body = {
      scheduleId: v.scheduleId,
      labels: { fr: v.fr.trim(), ar: v.ar.trim(), en: v.en.trim() },
      from: v.from,
      to: v.to,
      week: weekFromForm(this.form.controls.week),
      toleranceMinutes: Number(v.toleranceMinutes),
      approximate: v.approximate,
    };
    const request: Observable<unknown> = editing === 'new' ? this.api.createOverride(body) : this.api.updateOverride(editing.id, body);
    this.saving.set(true);
    request.subscribe({
      next: () => this.done(editing === 'new' ? 'attendance.overrides.created' : 'attendance.overrides.saved'),
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(attendanceProblemToForm(this.form, error, OVERRIDE_SLUGS, OVERRIDE_CODES));
      },
    });
  }

  protected remove(item: OverrideView): void {
    this.formError.set(null);
    this.saving.set(true);
    this.api.deleteOverride(item.id).subscribe({
      next: () => this.done('attendance.overrides.deleted'),
      error: (error: unknown) => {
        this.saving.set(false);
        this.confirming.set(null);
        this.formError.set(attendanceProblemToForm(this.form, error, OVERRIDE_SLUGS));
      },
    });
  }

  private done(key: string): void {
    this.saving.set(false);
    this.editing.set(null);
    this.confirming.set(null);
    this.feedback.set(key);
    this.list.reload();
  }
}
