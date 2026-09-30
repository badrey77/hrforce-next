import { standardWeek } from '../../core/attendance/attendance.models';
import { resetWeek, weekForm, weekFromForm } from './week-form';

describe('week form', () => {
  it('round-trips the API week document (days 1..7, rest days as { rest: true })', () => {
    const form = weekForm();
    expect(form.controls).toHaveLength(7);
    expect(weekFromForm(form)).toEqual(standardWeek());
    expect(form.valid).toBe(true);
  });

  it('flags a bad day on its group and "no working day" on the array', () => {
    const form = weekForm();
    form.at(0).patchValue({ breakStart: '12:00', breakEnd: '' });
    expect(form.at(0).hasError('invalid_break')).toBe(true);
    form.at(1).patchValue({ start: '17:00' });
    expect(form.at(1).hasError('invalid_time')).toBe(true);

    resetWeek(form, standardWeek().map((day) => ({ day: day.day, rest: true as const })));
    expect(form.hasError('no_working_day')).toBe(true);
    expect(form.at(0).valid).toBe(true);
  });

  it('keeps the times of a day set to rest, so un-ticking brings them back', () => {
    const form = weekForm();
    form.at(6).controls.rest.setValue(true);
    expect(weekFromForm(form)[6]).toEqual({ day: 7, rest: true });
    form.at(6).controls.rest.setValue(false);
    expect(weekFromForm(form)[6]).toEqual({ day: 7, start: '08:00', end: '16:30', breakStart: '12:00', breakEnd: '12:30' });
  });
});
