/**
 * /access/users/:id — one member: identity, grants table (current + future, or all with "show ended"), "End" per
 * grant (a date dialog) and "Add a grant".
 *
 * Angular concepts:
 * - **Route param → input**: `:id` arrives as `id = input.required<string>()` (withComponentInputBinding).
 * - **A resource whose request is built from two signals**: `grants` reads `id()` AND `includeEnded()`; ticking the
 *   checkbox (a `signal`) re-fetches with `includeEnded=true`, and the previous request is cancelled if still running.
 * - **Native `<dialog>` + `viewChild()`**. The End dialog is a real `<dialog>` element: `showModal()` opens it as a
 *   modal (the browser makes the rest of the page inert, traps focus inside, closes it on Escape and shows
 *   `::backdrop`) — no overlay library, no z-index games. To call `showModal()` the class needs the DOM element:
 *   `viewChild.required<ElementRef<HTMLDialogElement>>('endDialog')` is a **signal query** that finds the element
 *   marked `#endDialog` in THIS component's template. It is a signal: `this.endDialog()` returns the current match
 *   (`required` = it always exists, so no `undefined` to handle; reading it before the view is created throws).
 *   `ElementRef.nativeElement` is the element itself. The older decorator form `@ViewChild('endDialog')` does the
 *   same with a plain property that is only set after `ngAfterViewInit`.
 *   The dialog is always in the DOM (closed); `(close)` fires however it was closed (button, Escape, `close()`),
 *   so cleanup lives in one handler.
 * - **Record buttons from the server**: "End" shows only when the grant's `_actions` contains `end` — the API
 *   decided (scope, not-yourself). "Add a grant" uses `*appCan="'access.grant'"`: a page-level permission check.
 *   Both are comfort; the API re-checks everything (409 slugs are mapped in the forms).
 *
 * - **A resource keyed on a route param**: `member` is `AccessApi.userResource(this.id)` (`GET /access/users/:id`).
 *   Navigating from one user to another reuses this component; the `id` input changes and the resource re-fetches.
 *   A 404 (unknown id, or a member this caller may not see — ADR 002) is shown as "not found", never "forbidden".
 * - **History tab** (docs/contracts/audit.md › Web): the grants part of the page is projected into
 *   `<app-history-tabs [subject]="'user:' + person.id">` (shared/timeline/history-tabs.ts), which adds the member's
 *   audit timeline (grant rows + login/password events) for `audit.read` holders. `auditNames` names role ids and
 *   codes from the catalogue, and units / people from the grants this page already loaded — no extra request.
 *   The End dialog stays OUTSIDE the tabs: it is page-level UI, and a `<dialog>` hidden with its panel could not open.
 * - **"Reset two-step sign-in"** (docs/contracts/mfa.md): `*appCan="'access.grant'"` for the permission, plus
 *   `@if (!isSelf())` — the API refuses a self-reset (409 `mfa-reset-self`), so the button is not offered on your own
 *   page. A second native `<dialog>` asks for confirmation, because the action is destructive (it also signs the
 *   person out everywhere). `role="alertdialog"` tells assistive tech this dialog needs a decision; focus starts on
 *   Cancel, the safe choice (`autofocus` inside a modal dialog is honoured by `showModal()`).
 * - **Applications** (docs/contracts/sso.md › Web): `<app-user-apps-section>` (`*appCan="'sso.read'"`) lists the
 *   person's connected-app roles. This page creates the `GET /sso/assignments?userId=` resource (gated by `sso.read`)
 *   and passes it to the section as an input, because the history tab also uses it to name app roles.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { AccessApi } from '../../core/access/access-api';
import { Session } from '../../core/auth/session';
import { AccessCatalog } from '../../core/access/access-catalog';
import type { GrantView } from '../../core/access/access.models';
import { todayIso } from '../../core/date/iso-date';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { KindCatalog } from '../../core/org/kind-catalog';
import { CanDirective } from '../../shared/can/can.directive';
import { HistoryTabs } from '../../shared/timeline/history-tabs';
import { dateWithin, END_GRANT_SLUGS, fieldErrorKey, grantState, isoDate } from './access-forms';
import { AccessNav } from './access-nav';
import { accessAuditNames } from './audit-names';
import { GrantForm } from './grant-form';
import { LinkedEmployee } from './linked-employee';
import { UserAppsSection } from './user-apps-section';
import { SsoApi } from '../../core/sso/sso-api';
import { ssoAppName } from '../../core/sso/sso.models';
import { LanguageService } from '../../core/i18n/language.service';

function loadErrorKey(error: unknown, fallback: string, notFound = fallback): string {
  if (!isApiProblemError(error)) return fallback;
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
  if (error.status === 403) return 'errors.forbidden';
  if (error.status === 404) return notFound;
  return fallback;
}

/** Translation key for a failed `POST /access/users/:id/mfa/reset`. */
export function resetErrorKey(error: unknown): string {
  if (!isApiProblemError(error)) return 'errors.generic';
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
  if (error.problem.type === 'urn:hrforce:problem:mfa-reset-self') return 'access.mfaReset.self';
  if (error.status === 403) return 'errors.forbidden';
  if (error.status === 404) return 'access.users.notFound';
  return 'errors.generic';
}

@Component({
  selector: 'app-access-user-detail-page',
  imports: [TranslocoDirective, RouterLink, ReactiveFormsModule, AccessNav, GrantForm, CanDirective, HistoryTabs, LinkedEmployee, UserAppsSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './user-detail.page.html',
  styleUrl: './access.css',
})
export class UserDetailPage {
  private readonly api = inject(AccessApi);
  protected readonly catalog = inject(AccessCatalog);
  protected readonly kinds = inject(KindCatalog);

  /** `:id` of the route. */
  readonly id = input.required<string>();

  protected readonly includeEnded = signal(false);
  protected readonly adding = signal(false);
  protected readonly feedback = signal<{ key: string; role: string } | null>(null);
  protected readonly today = todayIso();
  protected readonly grantState = grantState;

  protected readonly member = this.api.userResource(this.id);
  protected readonly grants = this.api.grantsResource(() => ({ userId: this.id(), includeEnded: this.includeEnded() }));

  protected readonly user = computed(() => (this.member.hasValue() ? this.member.value() : undefined));
  protected readonly memberNotFound = computed(() => {
    const error = this.member.error();
    return isApiProblemError(error) && error.status === 404;
  });
  protected readonly memberErrorKey = computed(() =>
    loadErrorKey(this.member.error(), 'access.users.loadError', 'access.users.notFound'),
  );
  protected readonly grantItems = computed<readonly GrantView[]>(() => (this.grants.hasValue() ? this.grants.value().items : []));
  protected readonly grantsErrorKey = computed(() => loadErrorKey(this.grants.error(), 'access.grants.loadError'));

  // --- Connected apps (docs/contracts/sso.md › Web) -----------------------------------------------------------

  private readonly canReadApps = inject(Session).allows('sso.read');
  private readonly lang = inject(LanguageService).current;
  /** `GET /sso/assignments?userId=` — owned here, shown by `<app-user-apps-section>`, and read by `auditNames`. */
  protected readonly appAssignments = inject(SsoApi).assignmentsResource(() =>
    this.canReadApps() ? { userId: this.id() } : undefined,
  );

  /** Names for the audit history: roles from the catalogue; units and people from the member and their grants. */
  protected readonly auditNames = accessAuditNames(this.catalog, {
    appRoles: computed(() => {
      const items = this.appAssignments.hasValue() ? this.appAssignments.value().items : [];
      return new Map(items.map((a) => [a.role.id, `${ssoAppName(a.client, this.lang())} — ${a.role.code}`]));
    }),
    units: computed(() => new Map(this.grantItems().map((g) => [g.unit.id, g.unit.name]))),
    users: computed(() => {
      const names = new Map<string, string>();
      for (const g of this.grantItems()) if (g.grantedBy) names.set(g.grantedBy.id, g.grantedBy.displayName);
      const person = this.user();
      if (person) names.set(person.id, person.displayName);
      return names;
    }),
  });

  // --- Reset two-step sign-in -----------------------------------------------------------------------------

  private readonly session = inject(Session);
  /** The API refuses to reset your own two-step sign-in: do not offer it. */
  protected readonly isSelf = computed(() => this.user()?.id === this.session.user()?.id);
  private readonly resetDialog = viewChild.required<ElementRef<HTMLDialogElement>>('resetDialog');
  protected readonly resetting = signal(false);
  protected readonly resetError = signal<string | null>(null);

  protected openReset(): void {
    this.feedback.set(null);
    this.resetError.set(null);
    this.resetDialog().nativeElement.showModal();
  }

  protected cancelReset(): void {
    this.resetDialog().nativeElement.close();
  }

  protected confirmReset(): void {
    const person = this.user();
    if (!person) return;
    this.resetError.set(null);
    this.resetting.set(true);
    this.api.resetMfa(person.id).subscribe({
      next: () => {
        this.resetting.set(false);
        this.resetDialog().nativeElement.close();
        this.feedback.set({ key: 'access.mfaReset.done', role: person.displayName });
      },
      error: (error: unknown) => {
        this.resetting.set(false);
        this.resetError.set(resetErrorKey(error));
      },
    });
  }

  // --- End dialog -------------------------------------------------------------------------------------------

  /** Signal query: the `<dialog #endDialog>` of this template. */
  private readonly endDialog = viewChild.required<ElementRef<HTMLDialogElement>>('endDialog');
  /** The grant being ended (null while the dialog is closed). */
  protected readonly ending = signal<GrantView | null>(null);
  protected readonly endSubmitting = signal(false);
  protected readonly endError = signal<FormMessage | null>(null);
  protected readonly fieldErrorKey = fieldErrorKey;

  /** Contract: the new end is ≥ validFrom and ≤ the current end. The validator reads `ending()` when it runs. */
  protected readonly endForm = inject(NonNullableFormBuilder).group({
    validTo: [
      '',
      [
        Validators.required,
        isoDate,
        dateWithin(() => {
          const grant = this.ending();
          return grant ? { min: grant.validFrom, max: grant.validTo } : null;
        }),
      ],
    ],
  });

  protected toggleEnded(event: Event): void {
    this.includeEnded.set(event.target instanceof HTMLInputElement && event.target.checked);
  }

  protected startAdd(): void {
    this.feedback.set(null);
    this.adding.set(true);
  }

  protected onGranted(grant: GrantView): void {
    this.adding.set(false);
    this.feedback.set({ key: 'access.grants.added', role: this.catalog.roleName(grant.role) });
    this.grants.reload();
    this.member.reload();
  }

  protected openEnd(grant: GrantView): void {
    this.feedback.set(null);
    this.endError.set(null);
    // Set the grant FIRST: resetting the value re-runs the validators, which read `ending()`.
    this.ending.set(grant);
    // Default: today — or the start date for a grant that has not started yet (ending it then cancels it).
    this.endForm.reset({ validTo: grant.validFrom > this.today ? grant.validFrom : this.today });
    this.endDialog().nativeElement.showModal();
  }

  protected cancelEnd(): void {
    this.endDialog().nativeElement.close();
  }

  /** `(close)` of the dialog: however it was closed (button, Escape, after a save). */
  protected onEndClosed(): void {
    this.ending.set(null);
    this.endSubmitting.set(false);
  }

  protected submitEnd(): void {
    const grant = this.ending();
    this.endError.set(null);
    if (!grant) return;
    if (this.endForm.invalid) {
      this.endForm.markAllAsTouched();
      return;
    }
    this.endSubmitting.set(true);
    this.api.endGrant(grant.id, this.endForm.getRawValue().validTo).subscribe({
      next: (ended) => {
        this.endDialog().nativeElement.close();
        this.feedback.set({ key: 'access.grants.ended', role: this.catalog.roleName(ended.role) });
        this.grants.reload();
        this.member.reload();
      },
      error: (error: unknown) => {
        this.endError.set(problemToForm(this.endForm, error, END_GRANT_SLUGS, 'access.problems.grantNotFound'));
        this.endSubmitting.set(false);
      },
    });
  }

  protected canEnd(grant: GrantView): boolean {
    // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
    return grant._actions.includes('end') && grantState(grant, this.today) !== 'ended';
  }
}
