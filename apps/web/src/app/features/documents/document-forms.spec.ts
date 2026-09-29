import { HttpErrorResponse } from '@angular/common/http';
import { type ApiProblem, ApiProblemError, parseApiProblem } from '../../core/http/api-problem';
import { LOGO_FIELD_KEYS, logoFieldError, logoProblem } from './document-forms';

function problem(body: Partial<ApiProblem> & { status: number }): ApiProblemError {
  return new ApiProblemError(parseApiProblem({ title: 'x', type: 'about:blank', ...body }, body.status), {
    cause: new HttpErrorResponse({ status: body.status }),
  });
}

const refused = (code: string) => problem({ status: 422, type: 'urn:hrforce:problem:validation-error', errors: [{ field: 'file', code, message: 'x' }] });

describe('logo upload problems', () => {
  it('maps the 422 codes of the file field to a field error, each with a translation key', () => {
    expect(logoFieldError(refused('unsupported_type'))).toBe('type');
    expect(logoFieldError(refused('too_large'))).toBe('size');
    expect(logoFieldError(refused('dimensions_too_large'))).toBe('dimensions');
    expect(LOGO_FIELD_KEYS.dimensions).toBe('documents.profile.logoDimensions');
  });

  it('leaves anything else to the message above the logo', () => {
    expect(logoFieldError(refused('something_new'))).toBeNull();
    expect(logoFieldError(problem({ status: 403, type: 'urn:hrforce:problem:forbidden-scope' }))).toBeNull();
    expect(logoFieldError(new Error('network'))).toBeNull();
    expect(logoProblem(problem({ status: 403, type: 'urn:hrforce:problem:forbidden-scope' }))).toEqual({ key: 'documents.problems.companyWide' });
    expect(logoProblem(refused('something_new'))).toEqual({ key: 'errors.generic' });
  });
});
