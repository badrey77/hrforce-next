import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup } from '@angular/forms';
import { ApiProblemError, type ApiProblem, parseApiProblem } from './api-problem';
import { problemToForm, type SlugTable } from './problem-form';

const SLUGS: SlugTable = {
  'grant-escalation': { key: 'k.escalation', field: 'roleId' },
  'grant-user-not-member': { key: 'k.notMember', field: 'userId' },
  'grant-self': { key: 'k.self' },
};

function problem(body: Partial<ApiProblem> & { status: number }): ApiProblemError {
  return new ApiProblemError(parseApiProblem({ title: 'x', type: 'about:blank', ...body }, body.status), {
    cause: new HttpErrorResponse({ status: body.status }),
  });
}

const form = () => new FormGroup({ roleId: new FormControl(''), orgUnitId: new FormControl('') });

describe('problemToForm', () => {
  it('a slug with a field that exists → translated key on that control, no form message', () => {
    const f = form();
    const result = problemToForm(f, problem({ status: 409, type: 'urn:hrforce:problem:grant-escalation' }), SLUGS);

    expect(result).toBeNull();
    expect(f.controls.roleId.getError('serverKey')).toBe('k.escalation');
    expect(f.controls.roleId.touched).toBe(true);
  });

  it('a slug whose field has no control, or no field → form-level key', () => {
    const f = form();
    const type = 'urn:hrforce:problem:grant-user-not-member';
    expect(problemToForm(f, problem({ status: 409, type, errors: [{ field: 'userId', code: 'x', message: 'm' }] }), SLUGS)).toEqual({
      key: 'k.notMember',
    });
    expect(problemToForm(f, problem({ status: 409, type: 'urn:hrforce:problem:grant-self' }), SLUGS)).toEqual({ key: 'k.self' });
  });

  it('422 errors[] → server text on the control; unmatched → form text', () => {
    const f = form();
    const errors = [
      { field: 'orgUnitId', code: 'invalid', message: 'Bad unit' },
      { field: 'nope', code: 'invalid', message: 'Other' },
    ];
    expect(problemToForm(f, problem({ status: 422, errors }), SLUGS)).toEqual({ text: 'Other' });
    expect(f.controls.orgUnitId.getError('server')).toBe('Bad unit');
  });

  it('403 / 404 / network / non-problem errors', () => {
    expect(problemToForm(form(), problem({ status: 403 }), SLUGS)).toEqual({ key: 'errors.forbidden' });
    expect(problemToForm(form(), problem({ status: 404 }), SLUGS, 'k.gone')).toEqual({ key: 'k.gone' });
    expect(problemToForm(form(), problem({ status: 0 }), SLUGS)).toEqual({ key: 'errors.network' });
    expect(problemToForm(form(), new Error('boom'), SLUGS)).toEqual({ key: 'errors.generic' });
  });
});
