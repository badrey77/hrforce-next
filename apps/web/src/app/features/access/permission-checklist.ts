/**
 * `<app-permission-checklist formControlName="permissions" />` — the permission catalogue as checkboxes grouped by
 * catalogue group, sensitive permissions flagged. Its form value is the list of CHECKED CODES (`string[]`).
 *
 * Why `FormControl<string[]>` + this ControlValueAccessor, not a `FormArray`:
 * - A `FormArray<FormControl<boolean>>` gives one control per checkbox, bound with `[formControlName]="i"`. But the
 *   index ↔ code mapping must then match the catalogue order, which arrives asynchronously and could change
 *   (a new permission in the catalogue shifts every index); the form value is `[true, false, …]` and must be
 *   converted to codes before sending and from codes when loading a role. Per-item controls pay off when each item
 *   has its own validators or state (a list of phone numbers with their own `pattern`, add/remove rows).
 * - A `FormControl<string[]>` holds the value in the API's own shape: `role.permissions` goes in with
 *   `setValue()`, `getRawValue().permissions` goes out unchanged, and "at least one" is one validator on one
 *   control. The cost is that plain checkboxes cannot bind to it with `formControlName` — hence this small CVA,
 *   which reads the list (`writeValue`) and reports a NEW list on every tick (`onChange`), in catalogue order.
 *   A server error for the whole list (`role-escalation`) also has an obvious home: this one control.
 *
 * Angular concepts:
 * - **ControlValueAccessor** (introduced in shared/org-unit-picker/org-unit-picker.ts): `writeValue` /
 *   `registerOnChange` / `registerOnTouched` / `setDisabledState`. `form.disable()` on a system role reaches
 *   `setDisabledState(true)`, and every checkbox becomes `[disabled]`.
 * - **`<fieldset>` + `<legend>`** per group: native grouping that screen readers announce with each checkbox.
 * - **`[checked]` + `(change)`** on native checkboxes: the component, not the Forms API, drives them; the Set of
 *   checked codes is a `computed()` over the value signal, so lookups stay O(1) per checkbox.
 */
import { ChangeDetectionStrategy, Component, computed, forwardRef, inject, input, signal } from '@angular/core';
import { type ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { AccessCatalog } from '../../core/access/access-catalog';

/** Catalogue groups with a translated heading (`access.groups.<code>`); any other group shows its code. */
const KNOWN_GROUPS: ReadonlySet<string> = new Set(['organization', 'access', 'employee', 'sensitive', 'leave']);

@Component({
  selector: 'app-permission-checklist',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => PermissionChecklist), multi: true }],
  host: { '(focusout)': 'onTouched()' },
  template: `
    <ng-container *transloco="let t">
      @for (group of catalog.groups(); track group.group) {
        <fieldset [attr.data-group]="group.group" [attr.aria-invalid]="invalid() || null" [attr.aria-describedby]="describedBy()">
          <legend>{{ knownGroup(group.group) ? t('access.groups.' + group.group) : group.group }}</legend>
          @for (permission of group.permissions; track permission.code) {
            <div class="item">
              <input
                type="checkbox"
                [id]="idPrefix() + '-' + permission.code"
                [checked]="checked().has(permission.code)"
                [disabled]="disabled()"
                (change)="toggle(permission.code, $event)"
              />
              <label [for]="idPrefix() + '-' + permission.code">
                {{ catalog.permissionLabel(permission.code) }} <span class="code">{{ permission.code }}</span>
                @if (permission.sensitive) {
                  &ngsp;<span class="badge sensitive">{{ t('access.roles.sensitive') }}</span>
                }
              </label>
            </div>
          }
        </fieldset>
      } @empty {
        <p class="muted">{{ t('common.loading') }}</p>
      }
    </ng-container>
  `,
  styles: `
    fieldset { margin-block: 0 var(--space-3); padding-block: var(--space-2); padding-inline: var(--space-3);
      border: 1px solid var(--color-border); border-radius: var(--radius); }
    fieldset[aria-invalid='true'] { border-color: var(--color-danger); }
    legend { font-weight: 600; padding-inline: var(--space-1); }
    .item { display: flex; align-items: baseline; gap: var(--space-2); padding-block: var(--space-1); }
    .code { font-family: ui-monospace, monospace; font-size: 0.8125rem; color: var(--color-text-muted); }
    .badge.sensitive { border-color: var(--color-danger); color: var(--color-danger); }
    .muted { color: var(--color-text-muted); }
  `,
})
export class PermissionChecklist implements ControlValueAccessor {
  protected readonly catalog = inject(AccessCatalog);

  /** Prefix of the checkbox ids (unique per page). */
  readonly idPrefix = input('perm');
  /** Mirrors the control's invalid+touched state (the CVA cannot see its FormControl). */
  readonly invalid = input(false);
  readonly describedBy = input<string | null>(null);

  private readonly value = signal<readonly string[]>([]);
  protected readonly checked = computed(() => new Set(this.value()));
  protected readonly disabled = signal(false);

  private onChange: (value: string[]) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  writeValue(value: readonly string[] | null | undefined): void {
    this.value.set(value ?? []);
  }

  registerOnChange(fn: (value: string[]) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  protected knownGroup(group: string): boolean {
    return KNOWN_GROUPS.has(group);
  }

  protected toggle(code: string, event: Event): void {
    const on = event.target instanceof HTMLInputElement && event.target.checked;
    const next = new Set(this.value());
    if (on) next.add(code);
    else next.delete(code);
    // Catalogue order, then any code the catalogue does not know (kept, never silently dropped).
    const known = this.catalog.permissions().map((p) => p.code);
    const list = [...known.filter((c) => next.has(c)), ...[...next].filter((c) => !known.includes(c))];
    this.value.set(list);
    this.onChange(list);
  }
}
