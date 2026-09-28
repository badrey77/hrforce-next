/**
 * /employees/:id/rehire — a new employment for the person of an ENDED employment (`:id` = that employment's id).
 * The person's identity is shown read-only (it is the same person: `POST /employees` with `personId` refuses person
 * fields); the form (rehire-form.ts) collects the new matricule, hire date, first assignment and optional salary.
 * Reached from the "Rehire" button of an employee whose employment has an end date (employee-detail.page.html).
 *
 * Angular concepts:
 * - **A route below a param** (`:id/rehire`, employees.routes.ts): the same `:id` input as the detail page, bound by
 *   `withComponentInputBinding()`. The route has its own `canMatch: [permissionGuard('employee.create')]`, so without
 *   the permission the URL matches nothing and the app shows "not found".
 * - **Reusing a resource of another page**: `detailResource(this.id)` is the detail page's own request; the page
 *   needs the person (read-only identity) and the previous employment (end date → earliest hire date, last unit
 *   and job title → prefill). No new endpoint, no copy of the data in a service.
 * - **Rendering the form only when its data exists** (`@if (detail(); as e)` → `<app-rehire-form [previous]="e" />`):
 *   the child can then take the employment as a REQUIRED input and prefill once in `ngOnInit`. Loading, 404 and
 *   "this employment is still open" are the page's states; the form never sees a half-loaded employee.
 * - **The server keeps the last word**: the page offers the form when THIS employment has an end date. If the
 *   person was rehired since, the API answers 409 `employment-open`, shown above the form.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { EmployeesApi } from '../../core/employees/employees-api';
import type { EmployeeDetail } from '../../core/employees/employees.models';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { LanguageService } from '../../core/i18n/language.service';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { RehireForm } from './rehire-form';

@Component({
  selector: 'app-employee-rehire-page',
  imports: [TranslocoDirective, RouterLink, DisplayNamePipe, RehireForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <p>
        <a [routerLink]="['/employees', id()]">{{ t('employees.rehire.back') }}</a>
      </p>

      @if (detail(); as e) {
        <h1>{{ t('employees.rehire.title', { name: (e.person | displayName: lang()) }) }}</h1>
        <p class="field-hint">{{ t('employees.rehire.intro') }}</p>

        <!-- Read-only identity and the previous employment: what the new employment is attached to. -->
        <section class="section" data-section="person" aria-labelledby="rehire-person-title">
          <h2 id="rehire-person-title">{{ t('employees.sections.identity') }}</h2>
          <dl class="facts" data-panel="person">
            <dt>{{ t('employees.fields.lastName') }}</dt>
            <dd>{{ e.person.lastName }}</dd>
            <dt>{{ t('employees.fields.firstName') }}</dt>
            <dd>{{ e.person.firstName }}</dd>
            @if (e.person.lastNameAr || e.person.firstNameAr) {
              <dt>{{ t('employees.rehire.nameAr') }}</dt>
              <dd lang="ar" dir="rtl">{{ e.person.lastNameAr ?? '' }} {{ e.person.firstNameAr ?? '' }}</dd>
            }
            <dt>{{ t('employees.fields.birthDate') }}</dt>
            <dd class="nowrap">{{ e.person.birthDate ?? '—' }}</dd>
            <dt>{{ t('employees.fields.nin') }}</dt>
            <dd class="code">{{ e.person.nin ?? '—' }}</dd>
          </dl>
          <h2>{{ t('employees.rehire.previous') }}</h2>
          <dl class="facts" data-panel="previous">
            <dt>{{ t('employees.fields.matricule') }}</dt>
            <dd class="code">{{ e.matricule }}</dd>
            <dt>{{ t('employees.fields.unit') }}</dt>
            <dd>{{ e.unit | displayName: lang() }}</dd>
            <dt>{{ t('employees.fields.hireDate') }}</dt>
            <dd class="nowrap">{{ e.hireDate }}</dd>
            <dt>{{ t('employees.fields.endDate') }}</dt>
            <dd class="nowrap">{{ e.endDate ?? '—' }}</dd>
            @if (e.endReason) {
              <dt>{{ t('employees.fields.endReason') }}</dt>
              <dd>{{ t('employees.endReasons.' + e.endReason) }}</dd>
            }
          </dl>
        </section>

        @if (e.endDate) {
          <app-rehire-form [previous]="e" />
        } @else {
          <p class="form-error" role="alert" data-state="open">{{ t('employees.rehire.stillOpen') }}</p>
        }
      } @else if (employee.error()) {
        <p class="form-error" role="alert">{{ t(errorKey()) }}</p>
      } @else {
        <p role="status">{{ t('employees.detail.loading') }}</p>
      }
    </ng-container>
  `,
  styleUrl: './employees.css',
})
export class EmployeeRehirePage {
  protected readonly lang = inject(LanguageService).current;

  /** `:id` of the route: the ENDED employment whose person is rehired. */
  readonly id = input.required<string>();

  protected readonly employee = inject(EmployeesApi).detailResource(this.id);
  protected readonly detail = computed<EmployeeDetail | undefined>(() =>
    this.employee.hasValue() ? this.employee.value() : undefined,
  );
  protected readonly errorKey = computed(() => {
    const error = this.employee.error();
    if (!isApiProblemError(error)) return 'employees.detail.loadError';
    if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
    if (error.status === 404) return 'employees.problems.notFound';
    if (error.status === 403) return 'errors.forbidden';
    return 'employees.detail.loadError';
  });
}
