/**
 * /employees/new — one multi-section form: Identity, Employment, First assignment, and — only for users who may
 * write them — Salary, Bank, NSS (employment contract › Web). On 201 the page navigates to the new employee.
 *
 * Angular concepts:
 * - **Nested typed FormGroups.** `fb.group({ identity: fb.group({...}), employment: fb.group({...}), … })`: each
 *   section is its own `FormGroup`, and TypeScript infers the whole tree — `form.controls.identity.controls.nin`
 *   is a `FormControl<string>`, `form.getRawValue().assignment.orgUnitId` is `string | null`. A group has its own
 *   `valid`/`touched`, so a section can be validated, disabled or shown as "has errors" as a unit, and nested paths
 *   work everywhere a path is accepted: `form.get('identity.nin')`, `formGroupName="identity"` + `formControlName`.
 * - **`formGroupName`** in the template scopes the `formControlName`s inside it to that sub-group — the markup
 *   mirrors the model (one `<fieldset formGroupName="…">` per section).
 * - **Validator factories and cross-section rules** (employee-forms.ts): `digits(18)` for the NIN, `digits(20)` for
 *   the RIB, `digits(10, 15)` for the NSS; `money` for the salary; `bothOrNeither('rib', 'bankName')` on the bank
 *   GROUP; `birthBeforeHire` on the ROOT group because it reads two sections.
 * - **Optional sections = disabled groups.** Salary/Bank/NSS exist in the model for everyone, but an `effect()`
 *   `disable()`s the ones the session may not write (`employee.salary.update`…). A disabled control is excluded
 *   from the parent's validity and from `form.value`, so a hidden section can never block the submit, and the
 *   template shows a section only `@if` its group is allowed. When permissions change (a /me reload), the effect
 *   re-runs. This is COMFORT: the server stays the authority and answers 403 `forbidden-field` (mapped onto the
 *   field) for a block the caller may not write.
 * - **Dependent input from another section**: the unit picker searches units as of the hire date —
 *   `toSignal(hireDate.valueChanges)` feeds its `[asOf]`.
 * - **Navigation after a write**: `router.navigate(['/employees', created.id])` — segments, so the id is encoded.
 * - `<app-field-error>` (field-error.ts) renders each field's message from the control's `events`.
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { type FormGroup, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from '../../core/auth/session';
import { todayIso } from '../../core/date/iso-date';
import { EmployeesApi } from '../../core/employees/employees-api';
import type { CreateEmployee, Sex } from '../../core/employees/employees.models';
import type { FormMessage } from '../../core/http/problem-form';
import { OrgApi } from '../../core/org/org-api';
import type { Site } from '../../core/org/org.models';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import {
  birthBeforeHire,
  bothOrNeither,
  CREATE_FIELD_PATHS,
  CREATE_SLUGS,
  digits,
  digitsOnly,
  employeeProblemToForm,
  isoDate,
  JOB_TITLE_MAX,
  matricule,
  money,
  NAME_MAX,
  NATIONALITY_PATTERN,
  normaliseMatricule,
  normaliseMatriculeControl,
  normaliseMoney,
  notBlank,
} from './employee-forms';
import { FieldError } from './field-error';

/** Blank → null (optional text fields). */
function orNull(value: string): string | null {
  return value.trim() || null;
}

@Component({
  selector: 'app-employee-create-page',
  imports: [TranslocoDirective, ReactiveFormsModule, RouterLink, OrgUnitPicker, FieldError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './employee-create.page.html',
  styleUrl: './employees.css',
})
export class EmployeeCreatePage {
  private readonly api = inject(EmployeesApi);
  private readonly router = inject(Router);
  private readonly session = inject(Session);
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly form = this.fb.group(
    {
      identity: this.fb.group({
        lastName: ['', [Validators.required, notBlank, Validators.maxLength(NAME_MAX)]],
        firstName: ['', [Validators.required, notBlank, Validators.maxLength(NAME_MAX)]],
        lastNameAr: ['', Validators.maxLength(NAME_MAX)],
        firstNameAr: ['', Validators.maxLength(NAME_MAX)],
        birthDate: ['', isoDate],
        birthPlace: ['', Validators.maxLength(NAME_MAX)],
        // `Sex | null`: the generic widens the inferred type; `null` = not stated.
        sex: this.fb.control<Sex | null>(null),
        nationality: ['DZ', [Validators.required, Validators.pattern(NATIONALITY_PATTERN)]],
        nin: ['', digits(18)],
      }),
      employment: this.fb.group({
        matricule: ['', [Validators.required, matricule]],
        hireDate: [todayIso(), [Validators.required, isoDate]],
      }),
      assignment: this.fb.group({
        orgUnitId: this.fb.control<string | null>(null, Validators.required),
        // null = the unit's effective site.
        siteId: this.fb.control<string | null>(null),
        jobTitle: ['', [Validators.required, notBlank, Validators.maxLength(JOB_TITLE_MAX)]],
      }),
      salary: this.fb.group({ baseSalary: ['', money] }),
      bank: this.fb.group(
        { rib: ['', digits(20)], bankName: ['', Validators.maxLength(NAME_MAX)] },
        { validators: bothOrNeither('rib', 'bankName') },
      ),
      nss: this.fb.group({ nss: ['', digits(10, 15)] }),
    },
    { validators: birthBeforeHire },
  );

  /** Sensitive sections the session may WRITE somewhere (the server re-checks the unit). */
  protected readonly canSalary = this.session.allows('employee.salary.update');
  protected readonly canBank = this.session.allows('employee.bank.update');
  protected readonly canNss = this.session.allows('employee.nss.update');
  protected readonly canSites = this.session.allows('site.read');

  private readonly sitesResource = inject(OrgApi).sitesResource(() => '', this.canSites);
  protected readonly sites = computed<readonly Site[]>(() => (this.sitesResource.hasValue() ? this.sitesResource.value().items : []));
  protected readonly hireDate = toSignal(this.form.controls.employment.controls.hireDate.valueChanges, {
    initialValue: this.form.controls.employment.controls.hireDate.value,
  });

  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  /** Set by the first submit: the root group's cross-section error is shown from then on. */
  protected readonly submitted = signal(false);

  constructor() {
    const { salary, bank, nss } = this.form.controls;
    effect(() => {
      toggle(salary, this.canSalary());
      toggle(bank, this.canBank());
      toggle(nss, this.canNss());
    });
  }

  /** `(blur)` of the matricule input: show the value as it will be saved (employee-forms.ts › `matricule`). */
  protected normaliseMatricule(): void {
    normaliseMatriculeControl(this.form.controls.employment.controls.matricule);
  }

  protected submit(): void {
    this.formError.set(null);
    this.submitted.set(true);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.formError.set({ key: 'employees.create.fixErrors' });
      return;
    }
    this.submitting.set(true);
    this.api.create(this.body()).subscribe({
      next: (created) => {
        this.submitting.set(false);
        void this.router.navigate(['/employees', created.id]);
      },
      error: (error: unknown) => {
        this.formError.set(employeeProblemToForm(this.form, error, CREATE_SLUGS, CREATE_FIELD_PATHS));
        this.submitting.set(false);
      },
    });
  }

  /**
   * The POST body: the nested form FLATTENED to the API's shape (sections are a UI grouping, not the wire format),
   * trimmed texts, blanks as null, digits without spaces, money as a 2-decimal string.
   */
  private body(): CreateEmployee {
    const { identity, employment, assignment, salary, bank, nss } = this.form.getRawValue();
    const { controls } = this.form;
    const body: { -readonly [K in keyof CreateEmployee]: CreateEmployee[K] } = {
      lastName: identity.lastName.trim(),
      firstName: identity.firstName.trim(),
      lastNameAr: orNull(identity.lastNameAr),
      firstNameAr: orNull(identity.firstNameAr),
      birthDate: identity.birthDate || null,
      birthPlace: orNull(identity.birthPlace),
      sex: identity.sex,
      nationality: identity.nationality,
      nin: orNull(digitsOnly(identity.nin)),
      matricule: normaliseMatricule(employment.matricule),
      hireDate: employment.hireDate,
      orgUnitId: assignment.orgUnitId ?? '',
      siteId: assignment.siteId,
      jobTitle: assignment.jobTitle.trim(),
    };
    // `getRawValue()` includes disabled groups: send a block only if its section is enabled AND filled in.
    if (controls.salary.enabled && salary.baseSalary.trim()) body.salary = { baseSalary: normaliseMoney(salary.baseSalary) };
    if (controls.bank.enabled && bank.rib.trim()) body.bank = { rib: digitsOnly(bank.rib), bankName: orNull(bank.bankName) };
    if (controls.nss.enabled && nss.nss.trim()) body.nss = { nss: digitsOnly(nss.nss) };
    return body;
  }
}

function toggle(group: FormGroup, enabled: boolean): void {
  if (enabled && group.disabled) group.enable();
  if (!enabled && group.enabled) group.disable();
}
