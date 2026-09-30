import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup } from '@angular/forms';
import { ApiProblemError, parseApiProblem } from '../../core/http/api-problem';
import { attendanceProblemToForm, reasonErrorKey, reasonValidator } from './attendance-forms';

function problem(status: number, slug: string | null, errors?: { field: string; code: string; message: string }[]) {
  const body = { type: slug ? `urn:hrforce:problem:${slug}` : 'about:blank', title: 'x', status, ...(errors ? { errors } : {}) };
  return new ApiProblemError(parseApiProblem(body, status), { cause: new HttpErrorResponse({ status }) });
}

describe('attendance form helpers', () => {
  it('requires a trimmed reason of 3 to 500 characters', () => {
    const control = new FormControl('  ', { nonNullable: true, validators: reasonValidator() });
    expect(control.errors).toEqual({ required: true });
    expect(reasonErrorKey(control)).toBe('attendance.reason.required');
    control.setValue(' ab ');
    expect(reasonErrorKey(control)).toBe('attendance.reason.tooShort');
    control.setValue('x'.repeat(501));
    expect(reasonErrorKey(control)).toBe('attendance.reason.tooLong');
    control.setValue('Téléphone en panne');
    expect(control.valid).toBe(true);
  });

  it('puts known field codes on their control as translated keys (with an alias), the rest through problemToForm', () => {
    const form = new FormGroup({ time: new FormControl(''), targetId: new FormControl(''), reason: new FormControl('') });
    const error = problem(422, null, [
      { field: 'time', code: 'future', message: 'in the future' },
      { field: 'target.id', code: 'root_unit', message: 'root' },
      { field: 'reason', code: 'too_short', message: 'Reason too short' },
    ]);
    const message = attendanceProblemToForm(form, error, {}, {
      'time:future': 'attendance.manual.future',
      'target.id:root_unit': { key: 'attendance.assignments.rootUnit', control: 'targetId' },
    });
    expect(form.controls.time.getError('serverKey')).toBe('attendance.manual.future');
    expect(form.controls.targetId.getError('serverKey')).toBe('attendance.assignments.rootUnit');
    expect(form.controls.reason.getError('server')).toBe('Reason too short');
    expect(message).toBeNull();
  });

  it('uses the slug table for business rules', () => {
    const form = new FormGroup({ time: new FormControl('') });
    expect(attendanceProblemToForm(form, problem(409, 'attendance-self-manage'), { 'attendance-self-manage': { key: 'attendance.manual.selfManage' } })).toEqual({
      key: 'attendance.manual.selfManage',
    });
    attendanceProblemToForm(form, problem(409, 'attendance-punch-exists'), { 'attendance-punch-exists': { key: 'attendance.manual.exists', field: 'time' } });
    expect(form.controls.time.getError('serverKey')).toBe('attendance.manual.exists');
  });
});
