import { FormControl, FormGroup } from '@angular/forms';
import { fakeFile } from '../../../testing/employee-file-fixtures';
import { ApiProblemError } from '../../core/http/api-problem';
import { acceptedFiles, email, pastDate, phone, postalCode, profileErrorKey, requestProblemToForm, rib, todayIso } from './profile-forms';

const ctrl = (value: unknown) => new FormControl(value);

function form() {
  return new FormGroup({
    payload: new FormGroup({ mobilePhone: new FormControl(''), children: new FormGroup({ 0: new FormGroup({ birthDate: new FormControl('') }) }) }),
    files: new FormControl<File[]>([]),
  });
}

const problem422 = (errors: { field: string; code: string; message: string }[]) =>
  new ApiProblemError({ type: 'urn:hrforce:problem:validation', title: 'Invalid', status: 422, errors });

describe('profile form rules', () => {
  it('validates phones, e-mails, postal codes and RIBs (empty is allowed)', () => {
    expect(phone(ctrl(''))).toBeNull();
    expect(phone(ctrl('+213 555 12 34 56'))).toBeNull();
    expect(phone(ctrl('0555'))).toEqual({ phone: true });
    expect(email(ctrl('a@b.dz'))).toBeNull();
    expect(email(ctrl('a@b'))).toEqual({ email: true });
    expect(postalCode(ctrl('23000'))).toBeNull();
    expect(postalCode(ctrl('2300'))).toEqual({ postalCode: true });
    expect(rib(ctrl('0040 0123 4567 8901 2345'))).toBeNull();
    expect(rib(ctrl('123'))).toEqual({ rib: true });
  });

  it('refuses future dates and malformed ones', () => {
    const rule = pastDate(() => '2026-10-24');
    expect(rule(ctrl('2026-10-24'))).toBeNull();
    expect(rule(ctrl('2026-10-25'))).toEqual({ future: true });
    expect(rule(ctrl('24/10/2026'))).toEqual({ isoDate: true });
    expect(todayIso(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('checks files: at most 3, accepted types, not empty', () => {
    expect(acceptedFiles(ctrl([fakeFile('a.pdf', 'application/pdf')]))).toBeNull();
    expect(acceptedFiles(ctrl([1, 2, 3, 4].map((n) => fakeFile(`${n}.pdf`, 'application/pdf'))))).toEqual({ tooMany: true });
    expect(acceptedFiles(ctrl([fakeFile('a.exe', 'application/x-msdownload')]))).toEqual({ file: 'type' });
    expect(acceptedFiles(ctrl([fakeFile('a.pdf', 'application/pdf', 0)]))).toEqual({ file: 'empty' });
    const c = ctrl([]);
    c.setErrors({ file: 'size' });
    expect(profileErrorKey(c)).toBe('documents.file.errors.too_large');
  });

  it('maps unchanged, files and field-path errors of a refused request', () => {
    const f = form();
    expect(requestProblemToForm(f, problem422([{ field: 'payload', code: 'unchanged', message: '' }]))).toEqual({ key: 'profile.problems.unchanged' });

    expect(requestProblemToForm(f, problem422([{ field: 'files', code: 'required', message: '' }]))).toBeNull();
    expect(f.controls.files.getError('serverKey')).toBe('profile.files.required');

    expect(
      requestProblemToForm(f, problem422([
        { field: 'files.0', code: 'too_large', message: '' },
        { field: 'payload.children.0.birthDate', code: 'future', message: 'Date future' },
      ])),
    ).toBeNull();
    expect(f.controls.files.getError('serverKey')).toBe('documents.file.errors.too_large');
    expect(f.get('payload.children.0.birthDate')?.getError('server')).toBe('Date future');

    const conflict = new ApiProblemError({ type: 'urn:hrforce:problem:profile-request-pending', title: 'Pending', status: 409 });
    expect(requestProblemToForm(f, conflict)).toEqual({ key: 'profile.problems.pending' });
    expect(requestProblemToForm(f, new ApiProblemError({ type: 'about:blank', title: 'Too big', status: 413 }))).toBeNull();
    expect(requestProblemToForm(f, new Error('boom'))).toEqual({ key: 'errors.generic' });
  });
});
