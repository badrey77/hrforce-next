import { FormControl, FormGroup, Validators } from '@angular/forms';
import type { ApiProblem } from './api-problem';
import { applyServerErrors } from './apply-server-errors';

function validationProblem(errors: ApiProblem['errors']): ApiProblem {
  return { type: 'urn:hrforce:problem:validation', title: 'Validation failed', status: 422, errors };
}

function buildForm() {
  return new FormGroup({
    email: new FormControl('a@b.c', { nonNullable: true }),
    name: new FormControl('x', { nonNullable: true, validators: [Validators.minLength(3)] }),
    address: new FormGroup({ city: new FormControl('', { nonNullable: true }) }),
  });
}

describe('applyServerErrors', () => {
  it('sets {server: message} on the matching control and marks it touched', () => {
    const form = buildForm();

    applyServerErrors(form, validationProblem([{ field: 'email', code: 'taken', message: 'Already used' }]));

    const email = form.controls.email;
    expect(email.errors).toEqual({ server: 'Already used' });
    expect(email.touched).toBe(true);
    expect(form.valid).toBe(false);
  });

  it('keeps existing client-side errors alongside the server error', () => {
    const form = buildForm();

    applyServerErrors(form, validationProblem([{ field: 'name', code: 'too_short', message: 'Too short' }]));

    expect(form.controls.name.errors).toEqual({
      minlength: { requiredLength: 3, actualLength: 1 },
      server: 'Too short',
    });
  });

  it('resolves dotted paths into nested groups', () => {
    const form = buildForm();

    applyServerErrors(form, validationProblem([{ field: 'address.city', code: 'required', message: 'Required' }]));

    expect(form.controls.address.controls.city.errors).toEqual({ server: 'Required' });
  });

  it('returns errors whose field matches no control', () => {
    const form = buildForm();
    const orphan = { field: 'unknown', code: 'x', message: 'Orphan' };

    const unmatched = applyServerErrors(
      form,
      validationProblem([orphan, { field: 'email', code: 'taken', message: 'Already used' }]),
    );

    expect(unmatched).toEqual([orphan]);
  });

  it('does nothing when the problem has no errors', () => {
    const form = buildForm();

    expect(applyServerErrors(form, { type: 'about:blank', title: 'Conflict', status: 409 })).toEqual([]);
    expect(form.controls.email.errors).toBeNull();
  });

  it('clears the server error once the user edits the control', () => {
    const form = buildForm();
    applyServerErrors(form, validationProblem([{ field: 'email', code: 'taken', message: 'Already used' }]));

    form.controls.email.setValue('other@b.c');

    expect(form.controls.email.errors).toBeNull();
  });
});
