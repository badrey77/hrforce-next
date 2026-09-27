/**
 * Public holidays of one year: list (approximate lunar dates flagged), add, edit, delete — part of /leave/settings.
 *
 * Angular concepts:
 * - **A resource keyed on a local signal**: `year` is a `signal<number>`; the year select sets it and
 *   `holidaysResource(this.year)` re-fetches (cancelling a request still running for the previous year).
 * - **One form for "add" and "edit"**: `editing` is `'new' | holidayId | null`. The same FormGroup is reset with
 *   empty or existing values; submit calls POST or PUT depending on the mode.
 * - **Inline delete confirmation** instead of a modal: `deletingId` swaps the row's buttons for "Delete? Yes / No".
 *   Deleting a holiday is cheap to redo (and audited), so a full dialog would be more ceremony than safety.
 * - **Dates in the UI language** with `DatePipe` + explicit locale ('fullDate' names the weekday: "vendredi 1 mai
 *   2026" / "الجمعة 1 ماي 2026"), which is what HR checks when confirming a lunar date.
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Observable } from 'rxjs';
import { type FormMessage, problemToForm, type SlugTable } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveApi } from '../../core/leave/leave-api';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import type { HolidayInput, PublicHoliday } from '../../core/leave/leave.models';
import { isoDate, leaveErrorKey } from '../../shared/leave/leave-forms';
import { LABEL_MAX } from './leave-types-settings';


/** 409 slugs of the holiday write, shown on the field the user can fix (in the UI language, not the server's text). */
const HOLIDAY_SLUGS: SlugTable = {
  'holiday-date-taken': { key: 'leave.settings.holidays.dateTaken', field: 'date' },
};
@Component({
  selector: 'app-holidays-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './holidays-settings.html',
})
export class HolidaysSettings {
  private readonly api = inject(LeaveApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly catalog = inject(LeaveCatalog);
  private readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  private readonly thisYear = new Date().getFullYear();
  protected readonly years = [this.thisYear - 1, this.thisYear, this.thisYear + 1, this.thisYear + 2];
  protected readonly year = signal(this.thisYear);
  protected readonly holidays = this.api.holidaysResource(this.year);
  protected readonly items = computed<readonly PublicHoliday[]>(() =>
    this.holidays.hasValue() ? this.holidays.value().items.toSorted((a, b) => a.date.localeCompare(b.date)) : [],
  );

  protected readonly editing = signal<string | null>(null);
  protected readonly deletingId = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly errorKey = leaveErrorKey;

  protected readonly form = this.fb.group({
    date: ['', [Validators.required, isoDate]],
    labels: this.fb.group({
      fr: ['', [Validators.required, Validators.maxLength(LABEL_MAX)]],
      ar: ['', [Validators.required, Validators.maxLength(LABEL_MAX)]],
      en: ['', [Validators.required, Validators.maxLength(LABEL_MAX)]],
    }),
    approximate: [false],
  });

  protected onYear(event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? Number(event.target.value) : this.thisYear;
    this.editing.set(null);
    this.year.set(value);
  }

  protected startAdd(): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({ date: `${this.year()}-01-01`, labels: { fr: '', ar: '', en: '' }, approximate: false });
    this.editing.set('new');
  }

  protected startEdit(holiday: PublicHoliday): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({ date: holiday.date, labels: { ...holiday.labels }, approximate: holiday.approximate });
    this.editing.set(holiday.id);
  }

  protected save(): void {
    const mode = this.editing();
    this.formError.set(null);
    if (!mode) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const body: HolidayInput = {
      date: v.date,
      labels: { fr: v.labels.fr.trim(), ar: v.labels.ar.trim(), en: v.labels.en.trim() },
      approximate: v.approximate,
    };
    const write$: Observable<unknown> = mode === 'new' ? this.api.createHoliday(body) : this.api.updateHoliday(mode, body);
    this.saving.set(true);
    write$.subscribe({
      next: () => this.done(mode === 'new' ? 'leave.settings.holidays.added' : 'leave.settings.holidays.saved'),
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(problemToForm(this.form, error, HOLIDAY_SLUGS));
      },
    });
  }

  protected confirmDelete(holiday: PublicHoliday): void {
    this.saving.set(true);
    this.api.deleteHoliday(holiday.id).subscribe({
      next: () => this.done('leave.settings.holidays.deleted'),
      error: () => {
        this.saving.set(false);
        this.deletingId.set(null);
        this.formError.set({ key: 'errors.generic' });
      },
    });
  }

  private done(key: string): void {
    this.saving.set(false);
    this.editing.set(null);
    this.deletingId.set(null);
    this.feedback.set(key);
    this.holidays.reload();
  }
}
