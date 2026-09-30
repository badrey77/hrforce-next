/**
 * The week of a schedule as a typed reactive form (docs/contracts/attendance.md › Week document): a `FormArray` of 7
 * day groups, index = ISO weekday − 1 (Monday first, the API's order), whatever order the editor DISPLAYS them in
 * (Sunday first — week-editor.ts). Plain functions over the Forms API, unit-tested.
 *
 * Angular concepts:
 * - **`FormArray` of typed `FormGroup`s**: `week.at(i).controls.start` is a `FormControl<string>`, checked by
 *   `strictTemplates` wherever it is bound. A fixed-length array (7) is still a `FormArray` rather than seven named
 *   groups because the API's validation errors name days by index (`week.3.breakEnd`), which `form.get('week.3.
 *   breakEnd')` resolves through the array — the server's field paths map onto the controls with no translation.
 * - **Group and array validators reusing the domain rules**: each day group runs `weekErrors([day])` (the same pure
 *   function the page could call before sending), the array adds `no_working_day`. One rule, one place.
 * - **Form shape ≠ wire format**: a rest day is `rest: true` in the form with its times kept (un-ticking "rest"
 *   brings them back); `weekFromForm()` builds the API's `{ day, rest: true }` / `{ day, start, end, … }` union.
 */
import { type AbstractControl, FormArray, FormControl, FormGroup, type ValidationErrors } from '@angular/forms';
import {
  standardWeek,
  type Week,
  type WeekDay,
  weekErrors,
  type WeekdayNumber,
} from '../../core/attendance/attendance.models';

export type DayForm = FormGroup<{
  rest: FormControl<boolean>;
  start: FormControl<string>;
  end: FormControl<string>;
  breakStart: FormControl<string>;
  breakEnd: FormControl<string>;
}>;

export type WeekForm = FormArray<DayForm>;

function dayOf(group: AbstractControl, day: WeekdayNumber): WeekDay {
  const v = group.value as { rest?: boolean; start?: string; end?: string; breakStart?: string; breakEnd?: string };
  if (v.rest) return { day, rest: true };
  return { day, start: v.start ?? '', end: v.end ?? '', breakStart: v.breakStart || null, breakEnd: v.breakEnd || null };
}

function dayValidator(day: WeekdayNumber) {
  return (group: AbstractControl): ValidationErrors | null => {
    const error = weekErrors([dayOf(group, day)]).find((e) => e.code !== 'no_working_day');
    return error ? { [error.code]: true } : null;
  };
}

function weekValidator(array: AbstractControl): ValidationErrors | null {
  const days = (array as WeekForm).controls.map((group, i) => dayOf(group, (i + 1) as WeekdayNumber));
  return days.some((day) => !('rest' in day)) ? null : { no_working_day: true };
}

export function dayForm(day: WeekDay): DayForm {
  const working = 'rest' in day ? null : day;
  return new FormGroup(
    {
      rest: new FormControl('rest' in day, { nonNullable: true }),
      start: new FormControl(working?.start ?? '08:00', { nonNullable: true }),
      end: new FormControl(working?.end ?? '16:30', { nonNullable: true }),
      breakStart: new FormControl(working?.breakStart ?? '', { nonNullable: true }),
      breakEnd: new FormControl(working?.breakEnd ?? '', { nonNullable: true }),
    },
    { validators: dayValidator(day.day) },
  );
}

/** A week form filled with `week` (default: the contract's standard week). */
export function weekForm(week: Week = standardWeek()): WeekForm {
  const byDay = new Map(week.map((day) => [day.day, day]));
  const days = ([1, 2, 3, 4, 5, 6, 7] as const).map((n) => dayForm(byDay.get(n) ?? { day: n, rest: true }));
  return new FormArray(days, { validators: weekValidator });
}

/** Refills an existing week form (keeps the controls the template is bound to). */
export function resetWeek(form: WeekForm, week: Week = standardWeek()): void {
  const byDay = new Map(week.map((day) => [day.day, day]));
  form.controls.forEach((group, i) => {
    const day = byDay.get((i + 1) as WeekdayNumber) ?? { day: (i + 1) as WeekdayNumber, rest: true as const };
    const working = 'rest' in day ? null : day;
    group.reset({
      rest: 'rest' in day,
      start: working?.start ?? '08:00',
      end: working?.end ?? '16:30',
      breakStart: working?.breakStart ?? '',
      breakEnd: working?.breakEnd ?? '',
    });
  });
}

/** The API's week document (7 entries, days 1..7 in order). */
export function weekFromForm(form: WeekForm): Week {
  return form.controls.map((group, i) => dayOf(group, (i + 1) as WeekdayNumber));
}
