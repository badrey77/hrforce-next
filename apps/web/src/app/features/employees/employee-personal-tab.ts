/**
 * The employee page's **Coordonnées et famille** tab (shown when the detail carries `personal`, i.e. the caller holds
 * `employee.personal.read` over the employee; docs/contracts/profile-changes.md › Web builder 1): contact details,
 * emergency contact, family situation with the dependent children (age, dependent flag), an edit form per block when
 * `_actions` has `update_personal`, and the employee's « Demandes de modification » (each with its before → after).
 * `<app-employee-personal-tab [employee]="e" (changed)="…" />` — `changed` asks the page to re-read the employee.
 */
import { DatePipe } from '@angular/common';
import { afterNextRender, ChangeDetectionStrategy, Component, computed, ElementRef, inject, Injector, input, output, signal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { todayIso } from '../../core/date/iso-date';
import { type EmployeeDetail, employeeActions } from '../../core/employees/employees.models';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { ProfileApi } from '../../core/profile/profile-api';
import {
  ageOn,
  DEFAULT_PROFILE_REQUEST_QUERY,
  type PersonalView,
  type ProfileRequestQuery,
  type ProfileRequestView,
} from '../../core/profile/profile.models';
import { wilayaLabel } from '../../core/profile/wilayas';
import { ProfileRequestDiff } from '../../shared/profile/profile-request-diff';
import { ContactForm, EmergencyForm } from './contact-form';
import { FamilyForm } from './family-form';

type Editing = 'contact' | 'emergency' | 'family' | null;

/** The API's page maximum: an employee has far fewer requests than that. */
const REQUESTS_PAGE_SIZE = 100;

const EMPTY_PERSONAL: PersonalView = {
  contact: { mobilePhone: null, otherPhone: null, personalEmail: null, addressLine: null, commune: null, wilayaCode: null, postalCode: null, updatedAt: null },
  emergencyContact: null,
  family: { maritalStatus: null, maritalStatusSince: null, spouseEmployed: null, children: [] },
};

@Component({
  selector: 'app-employee-personal-tab',
  imports: [TranslocoDirective, DatePipe, ContactForm, EmergencyForm, FamilyForm, ProfileRequestDiff],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './employee-personal-tab.html',
  styleUrls: ['./employees.css', './personal.css'],
})
export class EmployeePersonalTab {
  private readonly api = inject(ProfileApi);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly today = todayIso();

  readonly employee = input.required<EmployeeDetail>();
  readonly changed = output<void>();

  protected readonly personal = computed<PersonalView>(() => this.employee().personal ?? EMPTY_PERSONAL);
  protected readonly canEdit = computed(
    () => employeeActions(this.employee()).includes('update_personal') && this.employee().status !== 'ended',
  );
  protected readonly editing = signal<Editing>(null);
  protected readonly feedback = signal<string | null>(null);

  /** Keyed on the id string, so a reload of the employee after a save does not read the list again. */
  private readonly employmentId = computed(() => this.employee().id);
  private readonly query = computed<ProfileRequestQuery>(() => ({
    ...DEFAULT_PROFILE_REQUEST_QUERY,
    status: '',
    employmentId: this.employmentId(),
    pageSize: REQUESTS_PAGE_SIZE,
  }));
  protected readonly requests = this.api.requestsResource(this.query);
  protected readonly items = computed<readonly ProfileRequestView[]>(() => (this.requests.hasValue() ? this.requests.value().items : []));
  protected readonly requestsErrorKey = computed(() => {
    const error = this.requests.error();
    return isApiProblemError(error) && error.problem.type === PROBLEM_TYPE_NETWORK ? 'errors.network' : 'personal.loadError';
  });
  protected readonly expanded = signal<string | null>(null);

  protected wilaya(code: string | null): string {
    return wilayaLabel(code, this.lang());
  }

  protected age(birthDate: string): number {
    return ageOn(birthDate, this.today);
  }

  protected edit(what: Exclude<Editing, null>): void {
    this.feedback.set(null);
    this.editing.set(what);
    // The « Modifier » button that had the focus is replaced by the form: move the focus to its first field.
    this.focusIn(what, 'form :is(input, select, textarea)');
  }

  protected cancel(): void {
    const what = this.editing();
    this.editing.set(null);
    if (what) this.focusIn(what, `[data-action="edit-${what}"]`);
  }

  protected onSaved(key: string): void {
    const what = this.editing();
    this.editing.set(null);
    this.feedback.set(key);
    this.changed.emit();
    if (what) this.focusIn(what, `[data-action="edit-${what}"]`);
  }

  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly injector = inject(Injector);

  private focusIn(what: Exclude<Editing, null>, selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`[data-section="${what}"] ${selector}`)?.focus(), { injector: this.injector });
  }

  protected toggle(request: ProfileRequestView): void {
    this.expanded.update((id) => (id === request.id ? null : request.id));
  }
}
