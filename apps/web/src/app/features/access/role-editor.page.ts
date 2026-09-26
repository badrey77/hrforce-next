/**
 * /access/roles/new and /access/roles/:id — create a custom role, edit one, or read a system role.
 *
 * Angular concepts:
 * - **One component, two routes.** `roles/new` has no `:id`, so the `id` input stays `undefined` → create mode.
 *   `roles/:id` binds it → edit (or read-only) mode. `isNew` is a `computed()` of that input.
 * - **A nested FormGroup**: `names` is a group inside the form (`formGroupName="names"` in the template, then
 *   `formControlName="fr"` inside). Its value is `{ fr, ar, en }` — exactly the contract's `names` — and a 422
 *   `errors[].field` of `names.fr` finds the control through `form.get('names.fr')` (applyServerErrors).
 * - **`FormControl<string[]>` for the checklist** — see permission-checklist.ts for the FormArray trade-off.
 * - **`effect()` to push signal state INTO a non-signal API.** Reactive forms are not signals: when the role
 *   arrives (the catalogue loads, or reloads after a save) or the read-only state changes, something must call
 *   `form.reset()` / `form.disable()`. That is the job `effect()` is for — a side effect on the outside world —
 *   as opposed to deriving state (use `computed()`). `untracked()` around the form calls makes sure nothing the
 *   Forms API might read internally becomes a dependency of the effect: it re-runs only for `role`, `readOnly`
 *   and `isNew`.
 * - **`form.disable()`** disables every control (and the checklist through its CVA's `setDisabledState`);
 *   `getRawValue()` still reads disabled controls, which is why it is used for the body (`value` skips them —
 *   the code control is disabled in edit mode).
 *
 * Read-only when the role is a system role (contract: permissions immutable through the API) or when the user lacks
 * `access.manage_roles`. The server stays the authority: `role-system-immutable` is still mapped (form-level).
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { AccessApi } from '../../core/access/access-api';
import { AccessCatalog } from '../../core/access/access-catalog';
import type { LocalizedText, Role } from '../../core/access/access.models';
import { Session } from '../../core/auth/session';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { atLeastOne, fieldErrorKey, notBlank, ROLE_CODE_PATTERN, ROLE_NAME_MAX, ROLE_SLUGS } from './access-forms';
import { AccessNav } from './access-nav';
import { PermissionChecklist } from './permission-checklist';

@Component({
  selector: 'app-access-role-editor-page',
  imports: [TranslocoDirective, ReactiveFormsModule, RouterLink, AccessNav, PermissionChecklist],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './role-editor.page.html',
  styleUrl: './access.css',
})
export class RoleEditorPage {
  private readonly api = inject(AccessApi);
  private readonly router = inject(Router);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly catalog = inject(AccessCatalog);

  /** `:id` — absent on `roles/new`. */
  readonly id = input<string>();
  /** `?created=CODE` after a create (the editor re-opens on the new role). */
  readonly created = input<string>();

  private readonly canManage = inject(Session).allows('access.manage_roles');
  protected readonly isNew = computed(() => this.id() === undefined);
  protected readonly role = computed<Role | undefined>(() => {
    const id = this.id();
    return id === undefined ? undefined : this.catalog.roleById(id);
  });
  protected readonly notFound = computed(
    () => !this.isNew() && this.catalog.rolesLoaded() && !this.catalog.rolesLoading() && !this.role(),
  );
  protected readonly readOnly = computed(() => !this.canManage() || (this.role()?.isSystem ?? false));

  protected readonly form = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(ROLE_CODE_PATTERN), Validators.maxLength(32)]],
    names: this.fb.group({
      fr: ['', [Validators.required, notBlank, Validators.maxLength(ROLE_NAME_MAX)]],
      ar: ['', [Validators.required, notBlank, Validators.maxLength(ROLE_NAME_MAX)]],
      en: ['', [Validators.required, notBlank, Validators.maxLength(ROLE_NAME_MAX)]],
    }),
    permissions: this.fb.control<string[]>([], atLeastOne),
  });

  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly saved = signal(false);
  protected readonly fieldErrorKey = fieldErrorKey;
  protected readonly nameLanguages = ['fr', 'ar', 'en'] as const;

  constructor() {
    effect(() => {
      const role = this.role();
      const readOnly = this.readOnly();
      const isNew = this.isNew();
      untracked(() => {
        if (role) {
          this.form.reset({ code: role.code, names: { ...role.names }, permissions: [...role.permissions] });
        }
        if (readOnly) {
          this.form.disable();
        } else {
          this.form.enable();
          if (!isNew) this.form.controls.code.disable(); // codes are immutable
        }
      });
    });
  }

  protected submit(): void {
    this.formError.set(null);
    this.saved.set(false);
    if (this.readOnly()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    const names: LocalizedText = { fr: value.names.fr.trim(), ar: value.names.ar.trim(), en: value.names.en.trim() };
    const id = this.id();
    this.submitting.set(true);
    const request =
      id === undefined
        ? this.api.createRole({ code: value.code.trim(), names, permissions: value.permissions })
        : this.api.updateRole(id, { names, permissions: value.permissions });
    request.subscribe({
      next: (role) => {
        this.submitting.set(false);
        this.catalog.reloadRoles();
        if (id === undefined) {
          void this.router.navigate(['/access/roles', role.id], { queryParams: { created: role.code } });
        } else {
          this.saved.set(true);
        }
      },
      error: (error: unknown) => {
        this.formError.set(problemToForm(this.form, error, ROLE_SLUGS, 'access.roles.notFound'));
        this.submitting.set(false);
      },
    });
  }
}
