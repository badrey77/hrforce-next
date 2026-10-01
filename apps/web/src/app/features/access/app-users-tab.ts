/**
 * « Utilisateurs » tab of a connected app (docs/contracts/sso.md › Web): who holds which role of this app, « Attribuer
 * un rôle » (a user found with the existing Access search + one of the app's roles) and « Retirer » (confirmed).
 *
 * Angular concepts:
 * - **A search that exists only while the form is open.** `searchQ` is `undefined` while the form is closed, so the
 *   `httpResource` sends nothing (`AccessApi.userSearchResource`); opening the form sets it to `''` (list everyone the
 *   caller may see), and « Rechercher » sets the typed text — the resource re-fetches and cancels a previous request.
 *   Typing alone sends nothing: a search is a deliberate action here, the list is short and must stay stable while a
 *   radio button is being chosen.
 * - **Radio buttons as a picker** (`formControlName="userId"` on each `<input type="radio" [value]="user.id">`): a
 *   choice among a few search results needs no combobox. The signed-in admin's own row is shown DISABLED with a note —
 *   separation of duties, nobody assigns a role to themselves (the API also answers 409 `sso-assign-self`).
 * - **An inner permission.** Searching users needs `access.read`; assigning needs `sso.assign`. A holder of the second
 *   without the first would see an empty search, so the form says why instead (`Session.allows`, a per-code
 *   `computed()` kept in a field, chapter 12).
 * - Remove buttons come from each assignment's `_actions` (`remove`), the server's decision.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { AccessApi } from '../../core/access/access-api';
import type { AccessUser } from '../../core/access/access.models';
import { Session } from '../../core/auth/session';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import type { FormMessage } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { SsoApi } from '../../core/sso/sso-api';
import type { SsoAssignmentView, SsoClientView } from '../../core/sso/sso.models';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { DatePipe } from '@angular/common';
import { ASSIGN_SLUGS, ssoFieldErrorKey, ssoProblemToForm } from './sso-forms';

@Component({
  selector: 'app-sso-users-tab',
  imports: [RevealAlert, TranslocoDirective, ReactiveFormsModule, RouterLink, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-users-tab.html',
  styles: `
    .search { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-block-end: var(--space-3); }
    .search input { padding-block: var(--space-1); padding-inline: var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius); }
    .user-choices { border: 0; padding: 0; margin: 0 0 var(--space-4); max-block-size: 18rem; overflow-y: auto; }
    legend { font-weight: 600; }
    .radio { display: flex; gap: var(--space-2); align-items: baseline; padding-block: var(--space-1); }
    .no-radio { display: inline-block; inline-size: 13px; }
    .self { color: var(--color-text-muted); }
  `,
})
export class SsoUsersTab {
  private readonly sso = inject(SsoApi);
  private readonly access = inject(AccessApi);
  private readonly session = inject(Session);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly client = input.required<SsoClientView>();
  /** An assignment was added or removed (the page reloads the app's counts). */
  readonly changed = output<void>();

  protected readonly canAssign = this.session.allows('sso.assign');
  protected readonly canSearch = this.session.allows('access.read');
  protected readonly selfId = computed(() => this.session.user()?.id ?? null);

  protected readonly assignments = this.sso.assignmentsResource(() => ({ clientId: this.client().id }));
  protected readonly items = computed<readonly SsoAssignmentView[]>(() =>
    this.assignments.hasValue() ? this.assignments.value().items : [],
  );

  // --- Assign ---------------------------------------------------------------------------------------------------

  protected readonly adding = signal(false);
  /** `undefined` = no search (form closed). */
  private readonly searchQ = signal<string | undefined>(undefined);
  protected readonly users = this.access.userSearchResource(this.searchQ);
  protected readonly userItems = computed<readonly AccessUser[]>(() => (this.users.hasValue() ? this.users.value().items : []));
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly fieldErrorKey = ssoFieldErrorKey;

  protected readonly form = inject(NonNullableFormBuilder).group({
    userId: ['', Validators.required],
    roleId: ['', Validators.required],
  });

  protected roleName(role: SsoAssignmentView['role']): string {
    return role.names[this.lang()];
  }

  protected startAssign(): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({ userId: '', roleId: '' });
    this.searchQ.set('');
    this.adding.set(true);
  }

  protected cancelAssign(): void {
    this.adding.set(false);
    this.searchQ.set(undefined);
  }

  protected search(event: Event, text: string): void {
    event.preventDefault();
    this.form.controls.userId.reset('');
    this.searchQ.set(text);
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.sso.assign(this.form.getRawValue()).subscribe({
      next: (assignment) => {
        this.submitting.set(false);
        this.cancelAssign();
        this.feedback.set(assignment.user.displayName);
        this.assignments.reload();
        this.changed.emit();
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.formError.set(ssoProblemToForm(this.form, error, ASSIGN_SLUGS));
      },
    });
  }

  // --- Remove ---------------------------------------------------------------------------------------------------

  private readonly removeDialog = viewChild.required<ElementRef<HTMLDialogElement>>('removeDialog');
  protected readonly removing = signal<SsoAssignmentView | null>(null);
  protected readonly removeError = signal<FormMessage | null>(null);
  protected readonly removedNote = signal(false);

  protected openRemove(assignment: SsoAssignmentView): void {
    this.feedback.set(null);
    this.removedNote.set(false);
    this.removeError.set(null);
    this.removing.set(assignment);
    this.removeDialog().nativeElement.showModal();
  }

  protected closeRemove(): void {
    this.removeDialog().nativeElement.close();
  }

  protected confirmRemove(): void {
    const assignment = this.removing();
    if (!assignment) return;
    this.submitting.set(true);
    this.sso.unassign(assignment.id).subscribe({
      next: () => {
        this.submitting.set(false);
        this.closeRemove();
        this.removedNote.set(true);
        this.assignments.reload();
        this.changed.emit();
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.removeError.set(ssoProblemToForm(this.form, error, ASSIGN_SLUGS));
      },
    });
  }
}
