import { FormControl, FormGroup } from '@angular/forms';
import { leaveSummary, TYPE_ANNUAL, TYPE_SICK } from '../../../testing/leave-fixtures';
import { canCancel, documentRequired, endNotBeforeStart, halfDaysOnOneDay, referenceYearLabel } from './leave-forms';

function dates(start: string, end: string, halfStart = false, halfEnd = false): FormGroup {
  return new FormGroup({
    startDate: new FormControl(start),
    endDate: new FormControl(end),
    halfDayStart: new FormControl(halfStart),
    halfDayEnd: new FormControl(halfEnd),
  });
}

describe('leave form rules', () => {
  it('end must not be before start', () => {
    expect(endNotBeforeStart(dates('2026-10-05', '2026-10-04'))).toEqual({ dateOrder: true });
    expect(endNotBeforeStart(dates('2026-10-05', '2026-10-05'))).toBeNull();
    expect(endNotBeforeStart(dates('', '2026-10-05'))).toBeNull();
  });

  it('a one-day request cannot be half a day at both ends', () => {
    expect(halfDaysOnOneDay(dates('2026-10-05', '2026-10-05', true, true))).toEqual({ halfDays: true });
    expect(halfDaysOnOneDay(dates('2026-10-05', '2026-10-06', true, true))).toBeNull();
  });

  it('the document is required only for types that require one', () => {
    let type = TYPE_ANNUAL;
    const validator = documentRequired(() => type);
    expect(validator(new FormControl(''))).toBeNull();
    type = TYPE_SICK;
    expect(validator(new FormControl('  '))).toEqual({ documentRequired: true });
    expect(validator(new FormControl('CM-42'))).toBeNull();
  });

  it('canCancel: _actions when sent, else pending or approved and not started', () => {
    expect(canCancel(leaveSummary(), '2026-09-26')).toBe(true);
    expect(canCancel(leaveSummary({ status: 'approved' }), '2026-09-26')).toBe(true);
    expect(canCancel(leaveSummary({ status: 'approved' }), '2026-10-05')).toBe(false);
    expect(canCancel(leaveSummary({ status: 'rejected' }), '2026-09-26')).toBe(false);
    expect(canCancel({ ...leaveSummary(), _actions: [] }, '2026-09-26')).toBe(false);
  });

  it('labels reference years', () => {
    expect(referenceYearLabel('2026-07-01')).toBe('2026–2027');
    expect(referenceYearLabel('2026-01-01')).toBe('2026');
  });
});
