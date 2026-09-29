/**
 * /access/security — the company's two-step sign-in policy (docs/contracts/mfa.md › Endpoints, `access.manage_roles`):
 * an "enforce" switch and the permissions whose holders must use two-step sign-in.
 *
 * Angular concepts:
 * - **Reusing a ControlValueAccessor in a new form.** The permission list is the same `<app-permission-checklist>` as
 *   the role editor (permission-checklist.ts): bound with `formControlName="mfaRequiredPermissions"` to a
 *   `FormControl<string[]>`, the API's own shape. Nothing in the checklist knows about roles or policies — that is
 *   the pay-off of writing it as a CVA with a plain `string[]` value.
 * - **`effect()` + `untracked()` to load server data into a reactive form**, as in the role editor: when the resource
 *   answers (first load, or after a save), `form.reset(policy)` — reset, not setValue, so the form is pristine again.
 * - **Saving marks the resource**: after the PUT the page `set()`s the resource to the saved policy (the effect then
 *   resets the form), and reloads the session — turning enforcement on may make the admin THEMSELF require two-step
 *   sign-in, and the guard / user-menu dot read the session.
 * - **A checkbox as a `FormControl<boolean>`**: `formControlName` on `<input type="checkbox">` binds `checked`.
 */
import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { AccessApi } from '../../core/access/access-api';
import type { SecurityPolicy } from '../../core/access/access.models';
import { Session } from '../../core/auth/session';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { AccessNav } from './access-nav';
import { PermissionChecklist } from './permission-checklist';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

@Component({
  selector: 'app-access-security-policy-page',
  imports: [RevealAlert, TranslocoDirective, ReactiveFormsModule, AccessNav, PermissionChecklist],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './access.css',
  template: `
    <ng-container *transloco="let t">
      <app-access-nav />
      <h2>{{ t('access.security.title') }}</h2>
      <p class="muted">{{ t('access.security.intro') }}</p>

      @if (policy.error() && !policy.hasValue()) {
        <div class="form-error" role="alert">
          <p>{{ t('access.security.loadError') }}</p>
          <button class="btn secondary" type="button" (click)="policy.reload()">{{ t('common.retry') }}</button>
        </div>
      } @else if (policy.hasValue()) {
        <form [formGroup]="form" (ngSubmit)="save()" novalidate>
          @if (formError(); as error) {
            <p class="form-error" role="alert" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
          }
          @if (saved()) {
            <p class="feedback" role="status">{{ t('access.security.saved') }}</p>
          }
          <div class="check">
            <input id="policy-enforced" type="checkbox" formControlName="mfaEnforced" aria-describedby="policy-enforced-hint" />
            <label for="policy-enforced">{{ t('access.security.enforce') }}</label>
          </div>
          <p class="field-hint" id="policy-enforced-hint">{{ t('access.security.enforceHint') }}</p>

          <h3 id="policy-permissions-title">{{ t('access.security.permissions') }}</h3>
          <p class="muted">{{ t('access.security.permissionsHint') }}</p>
          <app-permission-checklist formControlName="mfaRequiredPermissions" idPrefix="policy-perm" />

          <div class="form-actions">
            <button class="btn" type="submit" data-action="save-policy" [disabled]="saving()">
              {{ saving() ? t('access.form.saving') : t('common.save') }}
            </button>
          </div>
        </form>
      } @else {
        <p class="muted">{{ t('common.loading') }}</p>
      }
    </ng-container>
  `,
})
export class SecurityPolicyPage {
  private readonly api = inject(AccessApi);
  private readonly session = inject(Session);
  private readonly fb = inject(NonNullableFormBuilder);

  private readonly canManage = this.session.allows('access.manage_roles');
  protected readonly policy = this.api.securityPolicyResource(this.canManage);

  protected readonly form = this.fb.group({
    mfaEnforced: [false],
    mfaRequiredPermissions: this.fb.control<string[]>([]),
  });

  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  constructor() {
    effect(() => {
      const value = this.policy.hasValue() ? this.policy.value() : undefined;
      if (!value) return;
      untracked(() =>
        this.form.reset({ mfaEnforced: value.mfaEnforced, mfaRequiredPermissions: [...value.mfaRequiredPermissions] }),
      );
    });
  }

  protected save(): void {
    this.formError.set(null);
    this.saved.set(false);
    const body: SecurityPolicy = this.form.getRawValue();
    this.saving.set(true);
    this.api.updateSecurityPolicy(body).subscribe({
      next: (answer) => {
        this.saving.set(false);
        this.saved.set(true);
        this.policy.set(answer ?? body);
        void this.session.load();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(problemToForm(this.form, error, {}));
      },
    });
  }
}
