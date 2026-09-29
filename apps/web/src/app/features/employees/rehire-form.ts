/**
 * The rehire form: `<app-rehire-form [previous]="e" />` on /employees/:id/rehire (employee-rehire.page.ts).
 * `POST /employees` with `personId` — a NEW employment (new matricule, hire date, first assignment, optional salary)
 * for a person who already exists (docs/contracts/employment.md › Endpoints, "Settled by the build": with
 * `personId` the person fields are refused, so the identity is shown read-only by the page, never sent).
 *
 * Angular concepts:
 * - **Prefill from loaded data without an `effect()`**: the page renders this component only once the previous
 *   employment has loaded (`@if (detail(); as e)`), and passes it as a REQUIRED input. By `ngOnInit` the input is
 *   set, so the form is filled once, in plain code: hire date = the day after the previous end (or today, whichever
 *   is later), unit and job title = the last ones held. An `effect()` watching the resource would instead re-fill
 *   the form on every reload and overwrite what the user typed. Same pattern as assignment-form.ts.
 * - **The same nested groups as the create page** (`employment`, `assignment`, `salary`), minus `identity`: the
 *   API's field names (`matricule`, `hireDate`, `orgUnitId`, `salary`) then map onto controls through the create
 *   page's path table (`CREATE_FIELD_PATHS`), and the create page's validators are reused as they are.
 * - **A validator reading an input** (`notBefore(() => this.minHireDate())`): the new hire date must follow the end
 *   of the previous employment (409 `hire-date` otherwise). The server stays the authority — the person may have a
 *   LATER employment than the one this page was opened from — and its 409 lands on the same field.
 * - **An optional section as a disabled group** (salary without `employee.salary.update`), as on the create page:
 *   a disabled group does not count for validity and is left out of the body.
 * - **Problems → controls** with a slug table (`REHIRE_SLUGS`, employee-forms.ts); 422 `personId not_found` (the
 *   person left the caller's scope meanwhile) has no control, so it becomes the translated "not found" above the form.
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, type OnInit, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from '../../core/auth/session';
import { todayIso } from '../../core/date/iso-date';
import { EmployeesApi } from '../../core/employees/employees-api';
import type { CreateEmployee, EmployeeDetail } from '../../core/employees/employees.models';
import { isApiProblemError } from '../../core/http/api-problem';
import type { FormMessage } from '../../core/http/problem-form';
import { OrgApi } from '../../core/org/org-api';
import type { Site } from '../../core/org/org.models';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { nextDay } from './assignment-form';
import {
  CREATE_FIELD_PATHS,
  employeeProblemToForm,
  isoDate,
  JOB_TITLE_MAX,
  matricule,
  money,
  normaliseMatricule,
  normaliseMatriculeControl,
  normaliseMoney,
  notBefore,
  notBlank,
  REHIRE_SLUGS,
} from './employee-forms';
import { FieldError } from './field-error';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

/** True when the problem is the API's 422 on `personId` (the person is unknown or out of the caller's scope). */
function isPersonNotFound(error: unknown): boolean {
  return isApiProblemError(error) && error.status === 422 && (error.problem.errors ?? []).some((e) => e.field === 'personId');
}

@Component({
  selector: 'app-rehire-form',
  imports: [RevealAlert, TranslocoDirective, ReactiveFormsModule, RouterLink, OrgUnitPicker, FieldError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rehire-form.html',
  styleUrl: './employees.css',
})
export class RehireForm implements OnInit {
  private readonly api = inject(EmployeesApi);
  private readonly router = inject(Router);
  private readonly session = inject(Session);
  private readonly fb = inject(NonNullableFormBuilder);

  /** The ended employment the page was opened from (its person is rehired). */
  readonly previous = input.required<EmployeeDetail>();

  /** First allowed hire date: the day after the previous employment ended. */
  protected readonly minHireDate = computed(() => {
    const end = this.previous().endDate;
    return end ? nextDay(end) : null;
  });

  protected readonly form = this.fb.group({
    employment: this.fb.group({
      matricule: ['', [Validators.required, matricule]],
      // Empty until ngOnInit: the validator reads the `previous` input, which is not set during field initialisation.
      hireDate: ['', [Validators.required, isoDate, notBefore(() => this.minHireDate())]],
    }),
    assignment: this.fb.group({
      orgUnitId: this.fb.control<string | null>(null, Validators.required),
      siteId: this.fb.control<string | null>(null),
      jobTitle: ['', [Validators.required, notBlank, Validators.maxLength(JOB_TITLE_MAX)]],
    }),
    salary: this.fb.group({ baseSalary: ['', money] }),
  });

  protected readonly canSalary = this.session.allows('employee.salary.update');
  protected readonly canSites = this.session.allows('site.read');
  private readonly sitesResource = inject(OrgApi).sitesResource(() => '', this.canSites);
  protected readonly sites = computed<readonly Site[]>(() => (this.sitesResource.hasValue() ? this.sitesResource.value().items : []));
  protected readonly hireDate = toSignal(this.form.controls.employment.controls.hireDate.valueChanges, { initialValue: '' });

  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  constructor() {
    const { salary } = this.form.controls;
    effect(() => {
      const allowed = this.canSalary();
      if (allowed && salary.disabled) salary.enable();
      if (!allowed && salary.enabled) salary.disable();
    });
  }

  ngOnInit(): void {
    const previous = this.previous();
    const today = todayIso();
    const min = this.minHireDate();
    this.form.patchValue({
      employment: { hireDate: min && min > today ? min : today },
      assignment: { orgUnitId: previous.unit.id, jobTitle: previous.jobTitle },
    });
  }

  /** `(blur)` of the matricule input: show the value as it will be saved. */
  protected normaliseMatricule(): void {
    normaliseMatriculeControl(this.form.controls.employment.controls.matricule);
  }

  protected submit(): void {
    this.formError.set(null);
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
        this.formError.set(
          isPersonNotFound(error)
            ? { key: 'employees.problems.notFound' }
            : employeeProblemToForm(this.form, error, REHIRE_SLUGS, CREATE_FIELD_PATHS),
        );
        this.submitting.set(false);
      },
    });
  }

  /** The POST body: `personId` and the new employment only — never the person's fields (the API refuses them). */
  private body(): CreateEmployee {
    const { employment, assignment, salary } = this.form.getRawValue();
    const body: { -readonly [K in keyof CreateEmployee]: CreateEmployee[K] } = {
      personId: this.previous().person.id,
      matricule: normaliseMatricule(employment.matricule),
      hireDate: employment.hireDate,
      orgUnitId: assignment.orgUnitId ?? '',
      siteId: assignment.siteId,
      jobTitle: assignment.jobTitle.trim(),
    };
    if (this.form.controls.salary.enabled && salary.baseSalary.trim()) body.salary = { baseSalary: normaliseMoney(salary.baseSalary) };
    return body;
  }
}
