/**
 * « Applications » on the Access user page (docs/contracts/sso.md › Web › Access → user detail): the connected-app
 * roles this person holds (app, role, since), « Attribuer » and « Retirer » for `sso.assign` holders — never on one's
 * own page (the API also refuses: 409 `sso-assign-self`).
 *
 *   <app-user-apps-section [user]="person" [assignments]="appAssignments" />
 *
 * Angular concepts:
 * - **A resource passed to a child as an input.** The PAGE creates `GET /sso/assignments?userId=` (it also needs the
 *   answer to name app roles in the history tab) and hands the `HttpResourceRef` itself to this section, which reads
 *   `assignments().value()` and calls `assignments().reload()` after a write. One request, two readers, no service.
 * - **`toSignal(control.valueChanges)`** — the role `<select>` depends on the app `<select>`. `valueChanges` is an
 *   Observable of the control's value; `toSignal()` turns it into a signal (with `initialValue`), so the list of roles
 *   is a plain `computed()` of "the chosen app" and "the apps loaded". The subscription ends with the component.
 * - **A resource that exists only while the form is open**: `clientsResource(this.adding)` sends `GET /sso/clients`
 *   the first time « Attribuer » is clicked, not on every user page.
 * - Buttons: « Attribuer » needs `sso.assign` AND another person; « Retirer » follows each row's `_actions`.
 */
import { DatePipe } from '@angular/common';
import type { HttpResourceRef } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import type { AccessUser } from '../../core/access/access.models';
import { Session } from '../../core/auth/session';
import type { FormMessage } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { SsoApi } from '../../core/sso/sso-api';
import { type SsoAssignmentList, type SsoAssignmentView, type SsoClientView, ssoAppName } from '../../core/sso/sso.models';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { ASSIGN_SLUGS, ssoFieldErrorKey, ssoProblemToForm } from './sso-forms';

@Component({
  selector: 'app-user-apps-section',
  imports: [DatePipe, RevealAlert, ReactiveFormsModule, RouterLink, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './user-apps-section.html',
})
export class UserAppsSection {
  private readonly api = inject(SsoApi);
  private readonly session = inject(Session);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly user = input.required<AccessUser>();
  /** `GET /sso/assignments?userId=` owned by the page (see the header). */
  readonly assignments = input.required<HttpResourceRef<SsoAssignmentList | undefined>>();

  protected readonly items = computed<readonly SsoAssignmentView[]>(() => {
    const resource = this.assignments();
    return resource.hasValue() ? resource.value().items : [];
  });
  private readonly canAssignPermission = this.session.allows('sso.assign');
  protected readonly isSelf = computed(() => this.user().id === this.session.user()?.id);
  protected readonly canAssign = computed(() => this.canAssignPermission() && !this.isSelf());

  protected readonly adding = signal(false);
  private readonly clients = this.api.clientsResource(this.adding);
  /** Apps that can receive an assignment: active, with at least one role. */
  protected readonly apps = computed<readonly SsoClientView[]>(() =>
    this.clients.hasValue() ? this.clients.value().items.filter((app) => app.status === 'active' && app.roles.length > 0) : [],
  );
  protected readonly appsLoading = computed(() => this.clients.isLoading());

  protected readonly form = inject(NonNullableFormBuilder).group({
    clientId: ['', Validators.required],
    roleId: ['', Validators.required],
  });
  private readonly chosenApp = toSignal(this.form.controls.clientId.valueChanges, { initialValue: '' });
  protected readonly roles = computed(() => this.apps().find((app) => app.id === this.chosenApp())?.roles ?? []);

  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly fieldErrorKey = ssoFieldErrorKey;
  protected readonly removing = signal<string | null>(null);

  protected appName(client: SsoAssignmentView['client'] | SsoClientView): string {
    return ssoAppName(client, this.lang());
  }

  protected roleName(role: SsoAssignmentView['role']): string {
    return role.names[this.lang()];
  }

  protected startAssign(): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({ clientId: '', roleId: '' });
    this.adding.set(true);
  }

  protected onAppChange(): void {
    this.form.controls.roleId.reset('');
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.api.assign({ userId: this.user().id, roleId: this.form.getRawValue().roleId }).subscribe({
      next: () => {
        this.submitting.set(false);
        this.adding.set(false);
        this.feedback.set('sso.assignments.added');
        this.assignments().reload();
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.formError.set(ssoProblemToForm(this.form, error, ASSIGN_SLUGS));
      },
    });
  }

  /** Two-step remove (« Retirer ? Oui / Non ») — reversible by assigning again, so no modal. */
  protected remove(assignment: SsoAssignmentView): void {
    this.formError.set(null);
    this.submitting.set(true);
    this.api.unassign(assignment.id).subscribe({
      next: () => {
        this.submitting.set(false);
        this.removing.set(null);
        this.feedback.set('sso.assignments.removed');
        this.assignments().reload();
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.removing.set(null);
        this.formError.set(ssoProblemToForm(this.form, error, ASSIGN_SLUGS));
      },
    });
  }
}
