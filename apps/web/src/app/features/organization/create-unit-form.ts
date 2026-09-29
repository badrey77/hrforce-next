/**
 * Form to create a unit under a given parent: `<app-create-unit-form [parent]="…" [sites]="…" (saved)="…" />`.
 *
 * Angular concepts:
 * - **Typed reactive forms.** `NonNullableFormBuilder.group({...})` builds a `FormGroup` whose type is inferred
 *   from the initial values: `form.controls.code` is a `FormControl<string>`, `getRawValue()` returns
 *   `{ kind: string; code: string; siteId: string | null; … }`. "Non-nullable" means `reset()` goes back to the
 *   initial value instead of `null`. The template connects with `[formGroup]` on `<form>` and `formControlName`.
 * - **Dependent select options.** The kind `<select>` offers `kindOptions()`, a `computed()` over the `parent`
 *   input AND the kind catalogue (`KindCatalog.allowedChildKinds(parent.kind)`): a department parent offers
 *   region and service, an agency only service. The options are data, so no kind name is written in this file.
 * - **A `null` option in a typed form ("inherit").** `siteId` is `FormControl<string | null>`, and `null` means
 *   "no own site, inherit the parent's". A `<select>` can only hold strings in the DOM, so the template uses
 *   `[ngValue]` (not `[value]`) on each `<option>`: Angular keeps the real value (`null` or an id) in the model
 *   and maps it to the DOM for us. See docs/angular/07-forms.md.
 * - **`output()`** declares an event the parent listens to with `(saved)="…"`; `this.saved.emit(value)` fires it.
 * - **`OnInit` / `ngOnInit()`**: a lifecycle hook that runs once, after the first input values are set. Inputs are
 *   NOT available in field initializers or the constructor, so presetting the form from inputs happens here.
 * - **`(ngSubmit)`** fires on submit (Enter or the submit button) and suppresses the browser's page reload.
 *   `novalidate` turns off native browser validation bubbles: Angular validators and our messages take over.
 *
 * `nameAr` (optional Arabic name) is a plain text input with `dir="rtl" lang="ar"`: the caret, punctuation and
 * the screen reader's voice follow Arabic even in the French UI.
 *
 * Server errors: `orgWriteError()` maps 422/409 `errors[]` onto controls (e.g. a taken code → `code`, an unknown
 * site → `siteId`) and returns a form-level message for problems not tied to a field.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { KindCatalog } from '../../core/org/kind-catalog';
import { OrgApi } from '../../core/org/org-api';
import type { OrgUnitDetail, Site } from '../../core/org/org.models';
import {
  fieldErrorKey,
  type FormError,
  isoDate,
  notBlank,
  ORG_CODE_PATTERN,
  ORG_NAME_MAX,
  orgWriteError,
} from './org-forms';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

@Component({
  selector: 'app-create-unit-form',
  imports: [RevealAlert, ReactiveFormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './create-unit-form.html',
})
export class CreateUnitForm implements OnInit {
  private readonly api = inject(OrgApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly kindCatalog = inject(KindCatalog);

  readonly parent = input.required<OrgUnitDetail>();
  /** Sites to choose from (`GET /org/sites`, loaded by the page). */
  readonly sites = input<readonly Site[]>([]);
  /** Preset of the "effective date" field (the page's as-of date). */
  readonly defaultValidFrom = input.required<string>();
  readonly saved = output<OrgUnitDetail>();
  readonly cancelled = output<void>();

  protected readonly form = this.fb.group({
    // '' = nothing chosen yet (only when several kinds are possible); `required` rejects it.
    kind: ['', Validators.required],
    code: ['', [Validators.required, Validators.pattern(ORG_CODE_PATTERN)]],
    name: ['', [Validators.required, notBlank, Validators.maxLength(ORG_NAME_MAX)]],
    // Optional Arabic name (employment contract); blank = none, sent as null.
    nameAr: ['', [Validators.maxLength(ORG_NAME_MAX)]],
    // The generic widens the type to `string | null`: null = inherit the parent's site (the default).
    siteId: this.fb.control<string | null>(null),
    validFrom: ['', [Validators.required, isoDate]],
  });

  /** Kinds allowed under this parent, from the catalogue (in sortOrder). */
  protected readonly kindOptions = computed(() => this.kindCatalog.allowedChildKinds(this.parent().kind));
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormError | null>(null);
  protected readonly fieldErrorKey = fieldErrorKey;

  ngOnInit(): void {
    const options = this.kindOptions();
    // One possible kind: preselect it. Several: make the user choose (no silent default).
    this.form.patchValue({ kind: options.length === 1 ? options[0] : '', validFrom: this.defaultValidFrom() });
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    this.submitting.set(true);
    this.api
      .create({
        kind: value.kind,
        code: value.code.trim(),
        name: value.name.trim(),
        nameAr: value.nameAr.trim() || null,
        parentId: this.parent().id,
        siteId: value.siteId,
        validFrom: value.validFrom,
      })
      .subscribe({
        next: (unit) => {
          this.submitting.set(false);
          this.saved.emit(unit);
        },
        error: (error: unknown) => {
          // Setting a signal the template reads is what re-renders this OnPush view with the new control errors.
          this.formError.set(orgWriteError(this.form, error));
          this.submitting.set(false);
        },
      });
  }
}
