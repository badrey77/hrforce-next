/**
 * Leave form rules: validators, the 409 slug table, and small pure helpers shared by the leave screens.
 * Plain functions over the Forms API (no DI) — unit tested without TestBed.
 *
 * Angular concepts (all met before, chapter 07 / 14):
 * - **Group validators** for rules over two controls: `endNotBeforeStart` (end ≥ start; ISO strings compare like
 *   dates) and `halfDaysOnOneDay` (a one-day request cannot be half a day at BOTH ends — that would be zero days).
 *   They sit on the FormGroup and report on the group; the template shows them next to the field they concern.
 * - **A validator reading a getter** (`documentRequired(() => type)`): whether a document reference is required depends
 *   on the leave type chosen in ANOTHER control. The validator reads the current type each time it runs; the form
 *   re-runs it when the type changes (`updateValueAndValidity()`), since validators react to their own control only.
 * - **Slug table → fields** (`problemToForm`, core/http/problem-form.ts): each business rule of the contract is shown
 *   where the user can fix it — an overlap on the dates, a missing certificate on the document field, a balance
 *   problem above the form next to the preview. `leave-not-linked` is not a form problem at all: the page handles it.
 */
import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { isIsoDate } from '../../core/date/iso-date';
import type { SlugTable } from '../../core/http/problem-form';
import {
  type LeaveRequestDetail,
  type LeaveRequestSummary,
  type LeaveType,
  requestActions,
} from '../../core/leave/leave.models';

export const REASON_MAX = 500;
export const DOCUMENT_REF_MAX = 120;

/** Fails with `{ isoDate: true }` unless empty (left to `required`) or a real `YYYY-MM-DD`. */
export const isoDate: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  !control.value || isIsoDate(control.value) ? null : { isoDate: true };

/** Group validator: `endDate` ≥ `startDate` (inclusive range). Invalid/empty dates are left to the controls. */
export const endNotBeforeStart: ValidatorFn = (group: AbstractControl): ValidationErrors | null => {
  const start: unknown = group.get('startDate')?.value;
  const end: unknown = group.get('endDate')?.value;
  if (!isIsoDate(start) || !isIsoDate(end)) return null;
  return end >= start ? null : { dateOrder: true };
};

/** Group validator: a single-day request may be a half day at the start OR the end, not both. */
export const halfDaysOnOneDay: ValidatorFn = (group: AbstractControl): ValidationErrors | null => {
  const start: unknown = group.get('startDate')?.value;
  const end: unknown = group.get('endDate')?.value;
  const both = group.get('halfDayStart')?.value === true && group.get('halfDayEnd')?.value === true;
  return both && start === end ? { halfDays: true } : null;
};

/** Control validator: required when the chosen type `requiresDocument` (sick leave: the medical certificate). */
export function documentRequired(type: () => LeaveType | undefined): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (!type()?.requiresDocument) return null;
    return typeof control.value === 'string' && control.value.trim() !== '' ? null : { documentRequired: true };
  };
}

/** Where each 409 of `POST …/leave/requests` is explained (docs/contracts/leave.md › Validation). */
export const LEAVE_REQUEST_SLUGS: SlugTable = {
  'leave-overlap': { key: 'leave.problems.overlap', field: 'startDate' },
  'leave-dates': { key: 'leave.problems.dates', field: 'endDate' },
  'leave-balance': { key: 'leave.problems.balance' },
  'leave-max-request': { key: 'leave.problems.maxRequest' },
  'leave-once-per-career': { key: 'leave.problems.oncePerCareer', field: 'leaveTypeId' },
  'leave-document-required': { key: 'leave.problems.documentRequired', field: 'documentRef' },
  'leave-not-linked': { key: 'leave.problems.notLinked' },
};

/** Translation key for a control's first error (a server `serverKey` first; `server` text is shown as-is). */
export function leaveErrorKey(control: AbstractControl): string {
  const serverKey: unknown = control.getError('serverKey');
  if (typeof serverKey === 'string') return serverKey;
  if (control.hasError('required')) return 'leave.form.errors.required';
  if (control.hasError('isoDate')) return 'leave.form.errors.date';
  if (control.hasError('maxlength')) return 'leave.form.errors.tooLong';
  if (control.hasError('documentRequired')) return 'leave.form.errors.documentRequired';
  if (control.hasError('min') || control.hasError('max') || control.hasError('step')) return 'leave.form.errors.number';
  return 'errors.generic';
}

/**
 * May the requester cancel? The server's `_actions` when it sent them; else the contract's rule: pending, or approved
 * and not started yet.
 */
export function canCancel(request: LeaveRequestSummary & Pick<LeaveRequestDetail, '_actions'>, today: string): boolean {
  const actions = requestActions(request);
  if (actions) return actions.includes('cancel');
  return request.status === 'pending' || (request.status === 'approved' && request.startDate > today);
}

/** "2026–2027" for a reference year starting in July; "2026" when it starts in January. */
export function referenceYearLabel(periodStart: string): string {
  const [year = '', month = '01'] = periodStart.split('-');
  return month === '01' ? year : `${year}–${Number(year) + 1}`;
}
