/**
 * Settings › Horaires, first half: the work schedules (docs/contracts/attendance.md › Settings › Horaires). A list of
 * schedules — name, code, active, weekly hours, tolerance, current version, how many assignments use it — with
 * "Nouvel horaire", "Nouvelle version à partir du …", rename, deactivate/reactivate, and the version history.
 * The company-wide Ramadan-style overrides are the second half (overrides-settings.ts).
 *
 * Versions are APPENDED, never edited (contract › Data): changing hours means a new version from a date; the API
 * closes the previous one at that date and recomputes past days if the date is in the past (it says so: audited).
 *
 * Angular concepts:
 * - **One panel at a time, as a discriminated-union signal** (`panel`: new | version of X | labels of X | none), the
 *   state-machine idea of chapter 17 applied to a settings list: `@switch (p.kind)` shows exactly one form.
 * - **Forms that contain a `FormArray` from a helper** (`weekForm()`, week-form.ts) and hand it to a child editor
 *   (`<app-week-editor [week]="form.controls.week" />`): the parent validates and submits the whole form.
 * - **Pre-filling a form from the item being acted on** (`openVersion(s)` resets the version form from `s.current`):
 *   a plain method called by the button, not an `effect()` — the trigger is a click, not a signal change.
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import { algiersToday, type ScheduleView, standardWeek, TOLERANCE_MAX } from '../../core/attendance/attendance.models';
import type { FormMessage } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { attendanceProblemToForm } from '../../shared/attendance/attendance-forms';
import { ControlError } from '../../shared/attendance/control-error';
import { MinutesPipe } from '../../shared/attendance/minutes.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { SCHEDULE_SLUGS } from './settings-problems';
import { WeekEditor } from './week-editor';
import { resetWeek, weekForm, weekFromForm } from './week-form';

export const SCHEDULE_CODE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

type Panel =
  | { readonly kind: 'new' }
  | { readonly kind: 'version'; readonly schedule: ScheduleView }
  | { readonly kind: 'labels'; readonly schedule: ScheduleView };

@Component({
  selector: 'app-attendance-schedules-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe, MinutesPipe, RevealAlert, WeekEditor, ControlError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './schedules-settings.html',
  styles: `
    .schedules { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
    .schedules > li { padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius); }
    .head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
    .head h3 { margin: 0; font-size: 1.0625rem; }
    .versions { margin: var(--space-2) 0 0; padding-inline-start: var(--space-4); }
  `,
})
export class SchedulesSettings {
  private readonly api = inject(AttendanceApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly toleranceMax = TOLERANCE_MAX;

  protected readonly list = this.api.schedulesResource();
  protected readonly schedules = computed(() => (this.list.hasValue() ? this.list.value().items : []));

  protected readonly panel = signal<Panel | null>(null);
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);

  protected readonly newForm = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(SCHEDULE_CODE_PATTERN)]],
    fr: ['', [Validators.required, Validators.maxLength(120)]],
    ar: ['', [Validators.required, Validators.maxLength(120)]],
    en: ['', [Validators.required, Validators.maxLength(120)]],
    toleranceMinutes: [10, [Validators.required, Validators.min(0), Validators.max(TOLERANCE_MAX)]],
    validFrom: [algiersToday(), Validators.required],
    week: weekForm(),
  });

  protected readonly versionForm = this.fb.group({
    validFrom: ['', Validators.required],
    toleranceMinutes: [10, [Validators.required, Validators.min(0), Validators.max(TOLERANCE_MAX)]],
    week: weekForm(),
  });

  protected readonly labelsForm = this.fb.group({
    fr: ['', [Validators.required, Validators.maxLength(120)]],
    ar: ['', [Validators.required, Validators.maxLength(120)]],
    en: ['', [Validators.required, Validators.maxLength(120)]],
  });

  protected name(schedule: Pick<ScheduleView, 'labels'>): string {
    return pickLabel(schedule.labels, this.lang());
  }

  protected openNew(): void {
    this.reset();
    this.newForm.reset({ code: '', fr: '', ar: '', en: '', toleranceMinutes: 10, validFrom: algiersToday() });
    resetWeek(this.newForm.controls.week, standardWeek());
    this.panel.set({ kind: 'new' });
  }

  protected openVersion(schedule: ScheduleView): void {
    this.reset();
    this.versionForm.reset({ validFrom: algiersToday(), toleranceMinutes: schedule.current?.toleranceMinutes ?? 10 });
    resetWeek(this.versionForm.controls.week, schedule.current?.week ?? standardWeek());
    this.panel.set({ kind: 'version', schedule });
  }

  protected openLabels(schedule: ScheduleView): void {
    this.reset();
    this.labelsForm.reset({ ...schedule.labels });
    this.panel.set({ kind: 'labels', schedule });
  }

  protected close(): void {
    this.panel.set(null);
    this.formError.set(null);
  }

  protected submitNew(): void {
    if (!this.valid(this.newForm)) return;
    const v = this.newForm.getRawValue();
    this.save(
      this.api.createSchedule({
        code: v.code.trim(),
        labels: { fr: v.fr.trim(), ar: v.ar.trim(), en: v.en.trim() },
        week: weekFromForm(this.newForm.controls.week),
        toleranceMinutes: Number(v.toleranceMinutes),
        validFrom: v.validFrom,
      }),
      this.newForm,
      'attendance.schedules.created',
    );
  }

  protected submitVersion(schedule: ScheduleView): void {
    if (!this.valid(this.versionForm)) return;
    const v = this.versionForm.getRawValue();
    this.save(
      this.api.addVersion(schedule.id, {
        validFrom: v.validFrom,
        week: weekFromForm(this.versionForm.controls.week),
        toleranceMinutes: Number(v.toleranceMinutes),
      }),
      this.versionForm,
      'attendance.schedules.versionAdded',
    );
  }

  protected submitLabels(schedule: ScheduleView): void {
    if (!this.valid(this.labelsForm)) return;
    const v = this.labelsForm.getRawValue();
    this.save(
      this.api.updateSchedule(schedule.id, { labels: { fr: v.fr.trim(), ar: v.ar.trim(), en: v.en.trim() } }),
      this.labelsForm,
      'attendance.schedules.renamed',
    );
  }

  protected toggleActive(schedule: ScheduleView): void {
    this.reset();
    this.saving.set(true);
    this.api.updateSchedule(schedule.id, { active: !schedule.active }).subscribe({
      next: () => this.done(schedule.active ? 'attendance.schedules.deactivated' : 'attendance.schedules.activated'),
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(attendanceProblemToForm(this.labelsForm, error, SCHEDULE_SLUGS));
      },
    });
  }

  private valid(form: { invalid: boolean; markAllAsTouched(): void }): boolean {
    this.formError.set(null);
    this.feedback.set(null);
    if (form.invalid) {
      form.markAllAsTouched();
      return false;
    }
    return true;
  }

  private save(request: ReturnType<AttendanceApi['createSchedule']>, form: Parameters<typeof attendanceProblemToForm>[0], key: string): void {
    this.saving.set(true);
    request.subscribe({
      next: () => this.done(key),
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(attendanceProblemToForm(form, error, SCHEDULE_SLUGS));
      },
    });
  }

  private done(key: string): void {
    this.saving.set(false);
    this.panel.set(null);
    this.feedback.set(key);
    this.list.reload();
  }

  private reset(): void {
    this.feedback.set(null);
    this.formError.set(null);
  }
}
