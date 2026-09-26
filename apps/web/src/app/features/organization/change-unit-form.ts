/**
 * Form to rename, move and/or re-site a unit from an effective date:
 * `<app-change-unit-form [unit]="…" [sites]="…" (saved)="…" />`.
 * The API records it as a new version (`PATCH /org/units/:id`); only the fields that changed are sent.
 *
 * Angular concepts (see create-unit-form.ts for typed reactive forms, `[ngValue]`, `output()` and `ngOnInit`):
 * - **Custom form control in a reactive form**: the parent unit is chosen with `<app-org-unit-picker
 *   formControlName="parentId">`. Because the picker implements ControlValueAccessor, the form treats it exactly
 *   like an `<input>`: its value is the chosen unit id, `required` applies, `applyServerErrors` can flag it.
 *   Its `[kinds]` input is `allowedParentKinds(unit.kind)` from the kind catalogue, so the picker only offers
 *   valid parents (a service may move under a department, a region or an agency).
 * - **Validators that depend on inputs.** The root cannot move and must keep a site. Inputs are known only in
 *   `ngOnInit`, so that is where `addValidators(Validators.required)` is applied to the right control
 *   (`parentId` for a non-root unit, `siteId` for the root).
 * - **`toSignal()`** (from `@angular/core/rxjs-interop`) turns an Observable into a signal. The effective date
 *   control's `valueChanges` becomes `validFrom()`, which feeds the picker's `[asOf]` so it only offers parents that
 *   exist on that date. `toSignal` subscribes immediately and unsubscribes when the component is destroyed.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { KindCatalog } from '../../core/org/kind-catalog';
import { OrgApi } from '../../core/org/org-api';
import type { ChangeOrgUnit, OrgUnitDetail, Site } from '../../core/org/org.models';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { fieldErrorKey, type FormError, isoDate, notBlank, ORG_NAME_MAX, orgWriteError } from './org-forms';

@Component({
  selector: 'app-change-unit-form',
  imports: [ReactiveFormsModule, TranslocoDirective, OrgUnitPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './change-unit-form.html',
})
export class ChangeUnitForm implements OnInit {
  private readonly api = inject(OrgApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly kindCatalog = inject(KindCatalog);

  readonly unit = input.required<OrgUnitDetail>();
  /** Sites to choose from (`GET /org/sites`, loaded by the page). */
  readonly sites = input<readonly Site[]>([]);
  readonly defaultValidFrom = input.required<string>();
  readonly saved = output<OrgUnitDetail>();
  readonly cancelled = output<void>();

  protected readonly form = this.fb.group({
    name: ['', [Validators.required, notBlank, Validators.maxLength(ORG_NAME_MAX)]],
    // Optional Arabic name; clearing it sends `nameAr: null` (removes it from `validFrom`).
    nameAr: ['', [Validators.maxLength(ORG_NAME_MAX)]],
    // `string | null`: "no parent chosen" is null, which is what the picker writes.
    parentId: this.fb.control<string | null>(null),
    // `string | null`: null = inherit the parent's site (not offered for the root).
    siteId: this.fb.control<string | null>(null),
    validFrom: ['', [Validators.required, isoDate]],
  });

  protected readonly validFrom = toSignal(this.form.controls.validFrom.valueChanges, { initialValue: '' });
  /** The root is the unit with no ancestors (contract: `path` excludes self). */
  protected readonly isRoot = computed(() => this.unit().path.length === 0);
  /** Kinds the unit may move under (from the catalogue). */
  protected readonly parentKinds = computed(() => this.kindCatalog.allowedParentKinds(this.unit().kind));
  private readonly currentParentId = computed(() => this.unit().path.at(-1)?.id ?? null);
  /** The unit's OWN site (null when inherited), i.e. what "no change" means for the site select. */
  private readonly currentSiteId = computed(() => (this.unit().siteInherited ? null : (this.unit().site?.id ?? null)));

  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormError | null>(null);
  protected readonly fieldErrorKey = fieldErrorKey;

  ngOnInit(): void {
    const { controls } = this.form;
    (this.isRoot() ? controls.siteId : controls.parentId).addValidators(Validators.required);
    this.form.reset({
      name: this.unit().name,
      nameAr: this.unit().nameAr ?? '',
      parentId: this.currentParentId(),
      siteId: this.currentSiteId(),
      validFrom: this.defaultValidFrom(),
    });
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    const name = value.name.trim();
    const body: { -readonly [K in keyof ChangeOrgUnit]: ChangeOrgUnit[K] } = { validFrom: value.validFrom };
    if (name !== this.unit().name) body.name = name;
    const nameAr = value.nameAr.trim() || null;
    if (nameAr !== (this.unit().nameAr ?? null)) body.nameAr = nameAr;
    if (!this.isRoot() && value.parentId && value.parentId !== this.currentParentId()) body.parentId = value.parentId;
    // `null` is a real change here ("inherit from now on"), so compare, don't test truthiness.
    if (value.siteId !== this.currentSiteId()) body.siteId = value.siteId;
    if (body.name === undefined && body.nameAr === undefined && body.parentId === undefined && body.siteId === undefined) {
      this.formError.set({ key: 'org.form.errors.nothingChanged' });
      return;
    }

    this.submitting.set(true);
    this.api.change(this.unit().id, body).subscribe({
      next: (unit) => {
        this.submitting.set(false);
        this.saved.emit(unit);
      },
      error: (error: unknown) => {
        this.formError.set(orgWriteError(this.form, error));
        this.submitting.set(false);
      },
    });
  }
}
