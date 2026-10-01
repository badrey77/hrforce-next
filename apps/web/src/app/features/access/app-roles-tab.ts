/**
 * « Rôles » tab of a connected app (docs/contracts/sso.md › Web): the app's roles (code, names, users), create one,
 * edit its names, delete an unused one. The role CODES are what the app receives in the ID token (`roles` claim);
 * the names are for HRForce screens only.
 *
 * Angular concepts:
 * - **One form for "new" and "edit", driven by a signal.** `editing` is `null` (no form), `'new'` or the role being
 *   edited. Opening the form `reset()`s it and enables/disables the immutable `code` control. A second component
 *   would duplicate the markup; a second route would be too heavy for a three-field form inside a tab.
 * - **Buttons from the server's `_actions`** (chapter 12): « Nouveau rôle » when the app's `_actions` has `add_role`,
 *   « Modifier » / « Supprimer » per role from the role's own `_actions`. When `delete` is absent because the role is
 *   still assigned, the button is shown DISABLED with the reason as a tooltip (`title` on a wrapper — a disabled
 *   button receives no mouse events in every browser, its wrapper does) and as text for screen readers
 *   (`aria-describedby`).
 * - **Native `<dialog>` for the destructive action** (chapter 19): `viewChild.required('deleteDialog')` + `showModal()`,
 *   focus starting on Cancel.
 * - `output()` `changed` tells the page to reload the app (roles and counts live in `SsoClientView`).
 */
import { ChangeDetectionStrategy, Component, type ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { LocalizedText } from '../../core/access/access.models';
import type { FormMessage } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { SsoApi } from '../../core/sso/sso-api';
import type { SsoAppRoleView, SsoClientView } from '../../core/sso/sso.models';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { APP_NAME_MAX, APP_ROLE_CODE_PATTERN, notBlank, ROLE_SLUGS, ssoFieldErrorKey, ssoProblemToForm } from './sso-forms';

@Component({
  selector: 'app-sso-roles-tab',
  imports: [RevealAlert, TranslocoDirective, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-roles-tab.html',
})
export class SsoRolesTab {
  private readonly api = inject(SsoApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;

  readonly client = input.required<SsoClientView>();
  readonly changed = output<void>();

  protected readonly editing = signal<SsoAppRoleView | 'new' | null>(null);
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly feedback = signal<{ key: string; code: string } | null>(null);
  protected readonly fieldErrorKey = ssoFieldErrorKey;
  protected readonly nameLanguages = ['fr', 'ar', 'en'] as const;

  protected readonly form = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(APP_ROLE_CODE_PATTERN)]],
    names: this.fb.group({
      fr: ['', [Validators.required, notBlank, Validators.maxLength(APP_NAME_MAX)]],
      ar: ['', [Validators.required, notBlank, Validators.maxLength(APP_NAME_MAX)]],
      en: ['', [Validators.required, notBlank, Validators.maxLength(APP_NAME_MAX)]],
    }),
  });

  private readonly deleteDialog = viewChild.required<ElementRef<HTMLDialogElement>>('deleteDialog');
  protected readonly deleting = signal<SsoAppRoleView | null>(null);
  protected readonly deleteError = signal<FormMessage | null>(null);

  protected can(role: SsoAppRoleView, action: 'update' | 'delete'): boolean {
    // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
    return role._actions.includes(action);
  }

  protected roleName(role: SsoAppRoleView): string {
    return role.names[this.lang()];
  }

  protected startNew(): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({ code: '', names: { fr: '', ar: '', en: '' } });
    this.form.controls.code.enable();
    this.editing.set('new');
  }

  protected startEdit(role: SsoAppRoleView): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({ code: role.code, names: { ...role.names } });
    this.form.controls.code.disable(); // the code travels in tokens: immutable
    this.editing.set(role);
  }

  protected cancel(): void {
    this.editing.set(null);
  }

  protected submit(): void {
    const editing = this.editing();
    this.formError.set(null);
    if (!editing) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    const names: LocalizedText = { fr: value.names.fr.trim(), ar: value.names.ar.trim(), en: value.names.en.trim() };
    this.submitting.set(true);
    const request =
      editing === 'new'
        ? this.api.createRole(this.client().id, { code: value.code.trim(), names })
        : this.api.updateRole(editing.id, names);
    request.subscribe({
      next: (role) => {
        this.submitting.set(false);
        this.editing.set(null);
        this.feedback.set({ key: editing === 'new' ? 'sso.roles.created' : 'sso.roles.saved', code: role.code });
        this.changed.emit();
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.formError.set(ssoProblemToForm(this.form, error, ROLE_SLUGS));
      },
    });
  }

  protected openDelete(role: SsoAppRoleView): void {
    this.feedback.set(null);
    this.deleteError.set(null);
    this.deleting.set(role);
    this.deleteDialog().nativeElement.showModal();
  }

  protected closeDelete(): void {
    this.deleteDialog().nativeElement.close();
  }

  protected confirmDelete(): void {
    const role = this.deleting();
    if (!role) return;
    this.submitting.set(true);
    this.api.deleteRole(role.id).subscribe({
      next: () => {
        this.submitting.set(false);
        this.closeDelete();
        this.feedback.set({ key: 'sso.roles.deleted', code: role.code });
        this.changed.emit();
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.deleteError.set(ssoProblemToForm(this.form, error, ROLE_SLUGS));
      },
    });
  }
}
