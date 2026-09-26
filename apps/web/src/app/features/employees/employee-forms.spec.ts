import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup } from '@angular/forms';
import { ApiProblemError } from '../../core/http/api-problem';
import {
  birthBeforeHire,
  bothOrNeither,
  CREATE_FIELD_PATHS,
  CREATE_SLUGS,
  digits,
  employeeProblemToForm,
  fieldErrorKey,
  fieldErrorParams,
  MATRICULE_PATTERN,
  money,
  normaliseMoney,
} from './employee-forms';
import { resolveQuery, toQueryParams } from './employee-list-state';

const control = (value: string) => new FormControl(value, { nonNullable: true });

describe('employee validators', () => {
  it('digits(n) and digits(min, max): empty passes, spaces ignored, wrong length fails with its bounds', () => {
    const nin = digits(18);
    expect(nin(control(''))).toBeNull();
    expect(nin(control('109901234567890123'))).toBeNull();
    expect(nin(control('1099 0123 4567 8901 23'))).toBeNull();
    expect(nin(control('12345'))).toEqual({ digits: { min: 18, max: 18 } });
    expect(nin(control('10990123456789012A'))).toEqual({ digits: { min: 18, max: 18 } });

    const nss = digits(10, 15);
    expect(nss(control('1234567890'))).toBeNull();
    expect(nss(control('123456789012345'))).toBeNull();
    expect(nss(control('1234567890123456'))).not.toBeNull();
    const c = control('12');
    c.setValidators(nss);
    c.updateValueAndValidity();
    expect(fieldErrorKey(c)).toBe('employees.form.errors.digits');
    expect(fieldErrorParams(c)).toEqual({ min: 10, max: 15, count: '10–15' });
  });

  it('money: positive, at most 2 decimals, comma accepted; normalised to a 2-decimal string', () => {
    for (const ok of ['85000', '85000.5', '85000,50', '0.01']) expect(money(control(ok))).toBeNull();
    for (const bad of ['0', '0.00', '-5', '85000.123', '85 000', 'abc', '12345678901']) expect(money(control(bad))).toEqual({ money: true });
    expect(normaliseMoney('85000')).toBe('85000.00');
    expect(normaliseMoney('85000,5')).toBe('85000.50');
    expect(normaliseMoney('007.25')).toBe('7.25');
  });

  it('matricule pattern follows the contract', () => {
    expect(MATRICULE_PATTERN.test('EMP-0042')).toBe(true);
    expect(MATRICULE_PATTERN.test('emp-1')).toBe(false);
    expect(MATRICULE_PATTERN.test('-EMP')).toBe(false);
    expect(MATRICULE_PATTERN.test('A'.repeat(21))).toBe(false);
  });

  it('bothOrNeither and the cross-section birthBeforeHire', () => {
    const bank = new FormGroup({ rib: control(''), bankName: control('') }, { validators: bothOrNeither('rib', 'bankName') });
    expect(bank.errors).toBeNull();
    bank.controls.rib.setValue('00400123456789012345');
    expect(bank.errors).toEqual({ incomplete: true });
    bank.controls.bankName.setValue('BNA');
    expect(bank.errors).toBeNull();

    const root = new FormGroup(
      {
        identity: new FormGroup({ birthDate: control('2000-01-01') }),
        employment: new FormGroup({ hireDate: control('1999-12-31') }),
      },
      { validators: birthBeforeHire },
    );
    expect(root.errors).toEqual({ birthAfterHire: true });
    root.controls.employment.controls.hireDate.setValue('2020-01-01');
    expect(root.errors).toBeNull();
  });
});

const form = () =>
  new FormGroup({
    identity: new FormGroup({ nin: control('') }),
    employment: new FormGroup({ matricule: control('') }),
    salary: new FormGroup({ baseSalary: control('') }),
  });
const error = (status: number, slug: string | null, errors?: { field: string; code: string; message: string }[]) =>
  new ApiProblemError(
    { type: slug ? `urn:hrforce:problem:${slug}` : 'about:blank', title: 'x', status, ...(errors ? { errors } : {}) },
    { cause: new HttpErrorResponse({ status }) },
  );

describe('employeeProblemToForm', () => {
  it('maps a 409 slug named by errors[] through the path table (nin → identity.nin)', () => {
    const f = form();
    expect(employeeProblemToForm(f, error(409, 'nin-taken', [{ field: 'nin', code: 'taken', message: 'taken' }]), CREATE_SLUGS, CREATE_FIELD_PATHS)).toBeNull();
    expect(f.get('identity.nin')?.getError('serverKey')).toBe('employees.problems.ninTaken');
  });

  it('uses the slug table field when there is no errors[]', () => {
    const f = form();
    expect(employeeProblemToForm(f, error(409, 'matricule-taken'), CREATE_SLUGS, CREATE_FIELD_PATHS)).toBeNull();
    expect(f.get('employment.matricule')?.getError('serverKey')).toBe('employees.problems.matriculeTaken');
  });

  it('403 forbidden-field lands on the named sensitive field; a slug without field is form-level', () => {
    const f = form();
    expect(
      employeeProblemToForm(f, error(403, 'forbidden-field', [{ field: 'salary', code: 'forbidden', message: '' }]), CREATE_SLUGS, CREATE_FIELD_PATHS),
    ).toBeNull();
    expect(f.get('salary.baseSalary')?.getError('serverKey')).toBe('employees.problems.forbiddenField');
    expect(employeeProblemToForm(form(), error(409, 'employment-open'), CREATE_SLUGS, CREATE_FIELD_PATHS)).toEqual({
      key: 'employees.problems.employmentOpen',
    });
  });

  it('422 errors[] show the server text on mapped controls; other 403s stay generic', () => {
    const f = form();
    expect(
      employeeProblemToForm(f, error(422, null, [{ field: 'matricule', code: 'pattern', message: 'Bad matricule' }]), CREATE_SLUGS, CREATE_FIELD_PATHS),
    ).toBeNull();
    expect(f.get('employment.matricule')?.getError('server')).toBe('Bad matricule');
    expect(employeeProblemToForm(form(), error(403, null), CREATE_SLUGS)).toEqual({ key: 'errors.forbidden' });
  });
});

describe('list state ⇄ URL', () => {
  it('resolves defaults and ignores garbage', () => {
    expect(resolveQuery({})).toMatchObject({ status: 'active', sort: 'name', dir: 'asc', page: 1, pageSize: 25, includeSubUnits: true });
    expect(resolveQuery({ page: '-3', pageSize: '500', sort: 'salary', dir: 'up', status: 'x', asOf: '2025-02-30' })).toMatchObject({
      page: 1,
      pageSize: 25,
      sort: 'name',
      dir: 'asc',
      status: 'active',
      asOf: null,
    });
    expect(resolveQuery({ includeSubUnits: 'false', page: '4', sort: 'unit', dir: 'desc' })).toMatchObject({
      includeSubUnits: false,
      page: 4,
      sort: 'unit',
      dir: 'desc',
    });
  });

  it('writes only non-default values; defaults become null (param removed)', () => {
    expect(toQueryParams({ q: 'ben', page: 1, sort: 'name', dir: 'desc', unitId: null, includeSubUnits: false })).toEqual({
      q: 'ben',
      page: null,
      sort: null,
      dir: 'desc',
      unitId: null,
      includeSubUnits: 'false',
    });
  });
});
