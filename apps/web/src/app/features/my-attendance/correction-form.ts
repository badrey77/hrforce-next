/**
 * `<app-correction-form #correction [maxAgeDays]="30" (saved)="onSaved($event)" (notLinked)="onNotLinked()" />` —
 * the employee's correction request for one day, in a native `<dialog>` (docs/contracts/attendance.md › Phase B ›
 * Rules and Web): the day's live punches each with a "retirer" toggle, "ajouter" rows (direction + time), a
 * required reason, 1–4 changes, and the window rules spelled out. The page opens it with `correction.open(day)`.
 * A live BEFORE / AFTER preview (`<app-correction-preview>`) shows what the approver will see.
 *
 * Angular concepts:
 * - **Two `FormArray`s of different shapes in one typed form.** `removals` is a `FormArray<FormControl<boolean>>`,
 *   one checkbox per live punch, in the same order as the `punches` signal (`@for … let i = $index` binds
 *   `[formControlName]="i"`). `additions` is a `FormArray<FormGroup<{direction, time}>>` the person grows and
 *   shrinks with "Ajouter un pointage" / "Supprimer" — `push()` / `removeAt()`; `@for … track row` keys on the
 *   `FormGroup` OBJECT, so removing row 1 of 3 keeps rows 0 and 2 (and their focus and values) in place.
 * - **A group-level validator for a rule over several arrays** (`changeCount`): 1–4 changes counts ticked removals
 *   PLUS added rows, which no single control knows. Set on the root group, its error shows once above the lists.
 * - **A validator factory that reads a signal** (`notInFuture(() => this.date())`): "a time of today must not be in
 *   the future" depends on which day the dialog is for; reading the signal inside the validator keeps one validator
 *   per row. `updateValueAndValidity()` after `open()` re-runs it for the new day.
 * - **The form's value as a signal** (`toSignal(form.valueChanges)`), mapped by a `computed()` to the contract's
 *   `changes` shape, feeds the preview on each keystroke — no subscription to manage.
 * - **Server field errors on array rows**: the API names `changes.<i>.time` (`future`, `exists`, `duplicate`) and
 *   `changes.<i>.punchId` (`not_found`, `duplicate`), where `i` is the index in the body we sent; `submit()` builds the matching `{ key, control: 'additions.<j>.time' }` table for THIS body, so the
 *   message lands on the right row (`attendanceProblemToForm`, shared/attendance/attendance-forms.ts).
 * - `attendance-correction-date` (with `errors[{field: 'date', code: 'out_of_window'}]`: the form has no date
 *   control) falls through to the slug table and shows above the form.
 * - **`[appRevealAlert]`** scrolls the top-of-form error into view on a phone (chapter 07).
 */
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  type AbstractControl,
  FormArray,
  type FormControl,
  type FormGroup,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  type ValidationErrors,
  type ValidatorFn,
  Validators,
} from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import {
  algiersTime,
  algiersToday,
  type AttendanceDayView,
  CORRECTION_MAX_CHANGES,
  type CorrectionChangeInput,
  type CorrectionView,
  isTimeOfDay,
  type PunchDirection,
  type PunchView,
} from '../../core/attendance/attendance.models';
import { isApiProblemError } from '../../core/http/api-problem';
import { type FormMessage, problemSlug } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { attendanceProblemToForm, type FieldCodeTable, reasonErrorKey, reasonValidator } from '../../shared/attendance/attendance-forms';
import { ControlError } from '../../shared/attendance/control-error';
import { CorrectionPreviewView, type PreviewSourceChange } from '../../shared/attendance/correction-preview';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

export const CORRECTION_SLUGS = {
  'attendance-correction-date': { key: 'attendance.corrections.problems.date' },
  'attendance-correction-pending': { key: 'attendance.corrections.problems.pending' },
  'attendance-not-linked': { key: 'attendance.mine.notLinked' },
} as const;

type AddRow = FormGroup<{ direction: FormControl<PunchDirection>; time: FormControl<string> }>;

/** Root-group validator: ticked removals + added rows must be 1..max. */
export function changeCount(max = CORRECTION_MAX_CHANGES): ValidatorFn {
  return (group: AbstractControl): ValidationErrors | null => {
    const removals = group.get('removals')?.value as readonly boolean[] | undefined;
    const additions = group.get('additions')?.value as readonly unknown[] | undefined;
    const count = (removals ?? []).filter(Boolean).length + (additions ?? []).length;
    if (count === 0) return { noChange: true };
    if (count > max) return { tooManyChanges: { max, actual: count } };
    return null;
  };
}

/** A time on `date()` must not be later than now (Algiers) when that date is today. */
export function notInFuture(date: () => string | null, now: () => number = Date.now): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value: unknown = control.value;
    const day = date();
    if (!isTimeOfDay(value) || !day) return null;
    const current = now();
    return day === algiersToday(current) && value > algiersTime(current) ? { future: true } : null;
  };
}

@Component({
  selector: 'app-correction-form',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe, ControlError, RevealAlert, CorrectionPreviewView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './correction-form.html',
  styles: `
    .punch-toggle { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
    .add-row { display: flex; flex-wrap: wrap; align-items: end; gap: var(--space-2); margin-block-end: var(--space-2); }
    .add-row .field { margin: 0; }
    fieldset { min-inline-size: 0; }
    ul.plain { margin: 0; padding: 0; list-style: none; display: grid; gap: var(--space-1); }
  `,
})
export class CorrectionForm {
  private readonly api = inject(AttendanceApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  /** The correction window's length (days back), for the rules shown in the dialog. */
  readonly windowDays = input.required<number>();
  readonly saved = output<CorrectionView>();
  readonly notLinked = output<void>();

  protected readonly max = CORRECTION_MAX_CHANGES;
  /** The day being corrected. */
  protected readonly day = signal<AttendanceDayView | null>(null);
  protected readonly date = computed(() => this.day()?.date ?? null);
  /** Its live punches (void ones cannot be removed again). */
  protected readonly punches = computed<readonly PunchView[]>(() => (this.day()?.punches ?? []).filter((p) => p.status === 'live'));

  protected readonly form = this.fb.group(
    {
      removals: new FormArray<FormControl<boolean>>([]),
      additions: new FormArray<AddRow>([]),
      reason: ['', reasonValidator()],
    },
    { validators: changeCount() },
  );
  protected readonly reasonErrorKey = reasonErrorKey;

  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  private readonly value = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });
  /** The form as the contract's `changes` (for the preview): removals first, in punch order, then additions. */
  protected readonly previewChanges = computed<readonly PreviewSourceChange[]>(() => {
    const value = this.value();
    const punches = this.punches();
    const changes: PreviewSourceChange[] = [];
    (value.removals ?? []).forEach((ticked, i) => {
      const punch = punches[i];
      if (ticked && punch) {
        changes.push({ position: changes.length, action: 'void', direction: null, time: null, punch: { id: punch.id, direction: punch.direction, localTime: punch.localTime } });
      }
    });
    for (const row of value.additions ?? []) {
      if (row.direction && row.time && isTimeOfDay(row.time)) {
        changes.push({ position: changes.length, action: 'add', direction: row.direction, time: row.time, punch: null });
      }
    }
    return changes;
  });

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  get removals(): FormArray<FormControl<boolean>> {
    return this.form.controls.removals;
  }

  get additions(): FormArray<AddRow> {
    return this.form.controls.additions;
  }

  /** Opens the dialog for `day` (the page calls it from the day list's output). */
  open(day: AttendanceDayView): void {
    this.day.set(day);
    this.formError.set(null);
    this.submitting.set(false);
    this.removals.clear();
    this.additions.clear();
    for (let i = 0; i < this.punches().length; i++) this.removals.push(this.fb.control(false));
    // A day with no arrival usually needs one: start with an "Arrivée" row so the common case is one field away.
    if (!this.punches().length) this.addRow('in');
    this.form.controls.reason.reset('');
    this.form.markAsUntouched();
    this.form.updateValueAndValidity();
    this.dialog().nativeElement.showModal();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected addRow(direction: PunchDirection = 'out'): void {
    this.additions.push(
      this.fb.group({
        direction: this.fb.control<PunchDirection>(direction),
        time: this.fb.control('', [Validators.required, Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/), notInFuture(() => this.date())]),
      }),
    );
  }

  protected removeRow(index: number): void {
    this.additions.removeAt(index);
  }

  protected submit(): void {
    const day = this.day();
    this.formError.set(null);
    if (!day) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const punches = this.punches();
    const changes: CorrectionChangeInput[] = [];
    const codes: Record<string, { key: string; control: string }> = {};
    v.removals.forEach((ticked, i) => {
      const punch = punches[i];
      if (ticked && punch) {
        codes[`changes.${changes.length}.punchId:not_found`] = { key: 'attendance.corrections.problems.punchGone', control: `removals.${i}` };
        codes[`changes.${changes.length}.punchId:duplicate`] = { key: 'attendance.corrections.problems.duplicate', control: `removals.${i}` };
        changes.push({ action: 'void', punchId: punch.id });
      }
    });
    v.additions.forEach((row, j) => {
      const time = `additions.${j}.time`;
      codes[`changes.${changes.length}.time:future`] = { key: 'attendance.corrections.problems.future', control: time };
      codes[`changes.${changes.length}.time:exists`] = { key: 'attendance.corrections.problems.exists', control: time };
      codes[`changes.${changes.length}.time:duplicate`] = { key: 'attendance.corrections.problems.duplicateTime', control: time };
      changes.push({ action: 'add', direction: row.direction, time: row.time });
    });
    this.submitting.set(true);
    this.api.requestCorrection({ date: day.date, reason: v.reason.trim(), changes }).subscribe({
      next: (correction) => {
        this.close();
        this.saved.emit(correction);
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        if (isApiProblemError(error) && problemSlug(error.problem.type) === 'attendance-not-linked') {
          this.close();
          this.notLinked.emit();
          return;
        }
        // 1–4 changes is checked before sending (`changeCount`), so `changes` min/max 422s are not mapped here.
        const table: FieldCodeTable = codes;
        this.formError.set(attendanceProblemToForm(this.form, error, CORRECTION_SLUGS, table));
      },
    });
  }
}
