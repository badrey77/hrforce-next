/**
 * Form to create a site: `<app-create-site-form (saved)="…" (cancelled)="…" />` → `POST /org/sites`.
 *
 * Same typed-reactive-form pattern as create-unit-form.ts (see its header). What is new here:
 * - **An optional field in a non-nullable form.** `address` is a `FormControl<string>` like the others (initial
 *   `''`); "optional" is decided when building the body: a blank address is left out of the request (the contract
 *   says `address?`), rather than making the control `string | null` and handling `null` in the template.
 * - Server errors go through the same `orgWriteError()` as the unit forms: a 409 `site-code-taken` lands on the
 *   `code` field, translated, even when the server sends no `errors[]`.
 *
 * Wilaya is free text for now; a reference list (and a select) can replace it later without changing the API shape.
 */
import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { OrgApi } from '../../core/org/org-api';
import type { CreateSite, Site } from '../../core/org/org.models';
import { fieldErrorKey, type FormError, notBlank, ORG_CODE_PATTERN, ORG_NAME_MAX, orgWriteError } from './org-forms';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

@Component({
  selector: 'app-create-site-form',
  imports: [RevealAlert, ReactiveFormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './create-site-form.html',
})
export class CreateSiteForm {
  private readonly api = inject(OrgApi);
  private readonly fb = inject(NonNullableFormBuilder);

  readonly saved = output<Site>();
  readonly cancelled = output<void>();

  protected readonly form = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(ORG_CODE_PATTERN)]],
    name: ['', [Validators.required, notBlank, Validators.maxLength(ORG_NAME_MAX)]],
    wilaya: ['', [Validators.required, notBlank, Validators.maxLength(ORG_NAME_MAX)]],
    address: [''],
  });

  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormError | null>(null);
  protected readonly fieldErrorKey = fieldErrorKey;

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    const address = value.address.trim();
    const body: CreateSite = {
      code: value.code.trim(),
      name: value.name.trim(),
      wilaya: value.wilaya.trim(),
      ...(address ? { address } : {}),
    };
    this.submitting.set(true);
    this.api.createSite(body).subscribe({
      next: (site) => {
        this.submitting.set(false);
        this.saved.emit(site);
      },
      error: (error: unknown) => {
        this.formError.set(orgWriteError(this.form, error));
        this.submitting.set(false);
      },
    });
  }
}
