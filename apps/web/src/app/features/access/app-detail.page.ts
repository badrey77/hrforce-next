/**
 * /access/apps/:id — one connected app (docs/contracts/sso.md › Web › Detail): header with status and actions
 * (« Régénérer le secret », « Désactiver », « Réactiver »), then four tabs — Paramètres (the form + « Comment connecter
 * l'application »), Rôles, Utilisateurs, Historique (`audit.read`).
 *
 * Angular concepts:
 * - **Header actions from `_actions`** (chapter 12): the API decides (company-wide `sso.manage_apps`); a regional
 *   admin reads the same page with `_actions: []` and sees no button.
 * - **Tabs as a local signal** (chapter 14): `tab` is a `linkedSignal()` of the route's `id` — back to « Paramètres »
 *   when another app is opened, settable by the tab buttons in between. Each panel is created only when shown
 *   (`@switch`), so the Users tab's request is sent the first time it is opened, not on page load. The history panel
 *   is additionally a `@defer` block (chapter 13): the timeline's code is a separate chunk.
 * - **A destructive action behind a confirmation `<dialog>`** — rotating the secret cuts the app off AT ONCE (contract
 *   assumption 7), so the dialog says so before `POST …/rotate-secret`. The answer carries the new secret, shown with
 *   the same panel and the same rules as on creation: a component signal, cleared on « Terminer » and on destroy, and
 *   `canDeactivate` (`secretLeaveGuard`) while it is on screen.
 * - **A dialog with its own small form** (disable: a required reason, 3–500 characters) — `Validators.minLength` /
 *   `maxLength` plus the API's 422 codes mapped by `ssoProblemToForm()`.
 * - **`resource.reload()`** after every write: the view (status, roles, counts, `credentialSetAt`) is the server's.
 */
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { AccessCatalog } from '../../core/access/access-catalog';
import { Session } from '../../core/auth/session';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import type { FormMessage } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { SsoApi } from '../../core/sso/sso-api';
import type { SsoClientView } from '../../core/sso/sso.models';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { Timeline } from '../../shared/timeline/timeline';
import { AccessNav } from './access-nav';
import { SsoConnectPanel } from './app-connect-panel';
import { SsoRolesTab } from './app-roles-tab';
import { SsoAppForm } from './app-settings-form';
import { SsoUsersTab } from './app-users-tab';
import { accessAuditNames } from './audit-names';
import { type SecretHolder, SsoSecretPanel } from './secret-panel';
import { CLIENT_STATUS_SLUGS, notBlank, REASON_MAX, REASON_MIN, ssoFieldErrorKey, ssoProblemToForm } from './sso-forms';

export type AppTab = 'settings' | 'roles' | 'users' | 'history';

@Component({
  selector: 'app-access-app-detail-page',
  imports: [
    DatePipe,
    ReactiveFormsModule,
    RevealAlert,
    RouterLink,
    TranslocoDirective,
    AccessNav,
    SsoAppForm,
    SsoConnectPanel,
    SsoRolesTab,
    SsoSecretPanel,
    SsoUsersTab,
    Timeline,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-detail.page.html',
  styleUrls: ['./access.css', './app-detail.page.css'],
})
export class AppDetailPage implements SecretHolder {
  private readonly api = inject(SsoApi);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly canReadAudit = inject(Session).allows('audit.read');

  /** `:id` of the route (the app's uuid). */
  readonly id = input.required<string>();

  protected readonly client = this.api.clientResource(this.id);
  protected readonly app = computed<SsoClientView | undefined>(() => (this.client.hasValue() ? this.client.value() : undefined));
  protected readonly notFound = computed(() => {
    const error = this.client.error();
    return isApiProblemError(error) && error.status === 404;
  });
  protected readonly errorKey = computed(() => {
    const error = this.client.error();
    if (isApiProblemError(error)) {
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 404) return 'sso.apps.notFound';
      if (error.status === 403) return 'errors.forbidden';
    }
    return 'sso.apps.loadError';
  });

  protected readonly tab = linkedSignal<string, AppTab>({ source: this.id, computation: () => 'settings' });
  protected readonly tabs = computed<readonly AppTab[]>(() =>
    this.canReadAudit() ? ['settings', 'roles', 'users', 'history'] : ['settings', 'roles', 'users'],
  );

  protected readonly feedback = signal<string | null>(null);
  protected readonly actionError = signal<FormMessage | null>(null);
  protected readonly working = signal(false);

  /** Names in the history: the app's role ids → codes; people → the creator. */
  protected readonly auditNames = accessAuditNames(inject(AccessCatalog), {
    appRoles: computed(() => new Map((this.app()?.roles ?? []).map((role) => [role.id, role.code]))),
    users: computed(() => {
      const creator = this.app()?.createdBy;
      return new Map(creator ? [[creator.id, creator.displayName]] : []);
    }),
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.secret.set(null));
  }

  protected can(action: SsoClientView['_actions'][number]): boolean {
    // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
    return this.app()?._actions.includes(action) ?? false;
  }

  protected selectTab(tab: AppTab): void {
    this.tab.set(tab);
  }

  protected onSaved(): void {
    this.client.reload();
  }

  // --- Show-once secret after a rotation ------------------------------------------------------------------------

  protected readonly secret = signal<string | null>(null);

  holdsSecret(): boolean {
    return this.secret() !== null;
  }

  protected finishSecret(): void {
    this.secret.set(null);
  }

  // --- Rotate ---------------------------------------------------------------------------------------------------

  private readonly rotateDialog = viewChild.required<ElementRef<HTMLDialogElement>>('rotateDialog');

  protected openRotate(): void {
    this.clearMessages();
    this.rotateDialog().nativeElement.showModal();
  }

  protected closeRotate(): void {
    this.rotateDialog().nativeElement.close();
  }

  protected confirmRotate(): void {
    const app = this.app();
    if (!app) return;
    this.working.set(true);
    this.api.rotateSecret(app.id).subscribe({
      next: (view) => {
        this.working.set(false);
        this.closeRotate();
        this.secret.set(view.clientSecret);
        this.feedback.set('sso.actions.rotated');
        this.client.reload();
      },
      error: (error: unknown) => {
        this.working.set(false);
        this.closeRotate();
        this.actionError.set(ssoProblemToForm(this.disableForm, error, CLIENT_STATUS_SLUGS));
      },
    });
  }

  // --- Disable / enable -----------------------------------------------------------------------------------------

  private readonly disableDialog = viewChild.required<ElementRef<HTMLDialogElement>>('disableDialog');
  protected readonly disableError = signal<FormMessage | null>(null);
  protected readonly reasonMax = REASON_MAX;
  protected readonly fieldErrorKey = ssoFieldErrorKey;
  protected readonly disableForm = inject(NonNullableFormBuilder).group({
    reason: ['', [Validators.required, notBlank, Validators.minLength(REASON_MIN), Validators.maxLength(REASON_MAX)]],
  });

  protected openDisable(): void {
    this.clearMessages();
    this.disableError.set(null);
    this.disableForm.reset({ reason: '' });
    this.disableDialog().nativeElement.showModal();
  }

  protected closeDisable(): void {
    this.disableDialog().nativeElement.close();
  }

  protected confirmDisable(): void {
    const app = this.app();
    this.disableError.set(null);
    if (!app) return;
    if (this.disableForm.invalid) {
      this.disableForm.markAllAsTouched();
      return;
    }
    this.working.set(true);
    this.api.disableClient(app.id, this.disableForm.getRawValue().reason.trim()).subscribe({
      next: () => {
        this.working.set(false);
        this.closeDisable();
        this.feedback.set('sso.actions.disabled');
        this.client.reload();
      },
      error: (error: unknown) => {
        this.working.set(false);
        this.disableError.set(ssoProblemToForm(this.disableForm, error, CLIENT_STATUS_SLUGS));
      },
    });
  }

  protected enable(): void {
    const app = this.app();
    if (!app) return;
    this.clearMessages();
    this.working.set(true);
    this.api.enableClient(app.id).subscribe({
      next: () => {
        this.working.set(false);
        this.feedback.set('sso.actions.enabled');
        this.client.reload();
      },
      error: (error: unknown) => {
        this.working.set(false);
        this.actionError.set(ssoProblemToForm(this.disableForm, error, CLIENT_STATUS_SLUGS));
      },
    });
  }

  private clearMessages(): void {
    this.feedback.set(null);
    this.actionError.set(null);
  }
}
