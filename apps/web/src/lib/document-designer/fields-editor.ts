/**
 * `<dd-fields-editor>` — the fields HR fills in when issuing (contract › TemplateField): code, kind, labels fr/ar,
 * required, and the choices of a choice list. Every edit emits the whole list.
 */
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { DesignerLabels } from './labels';
import { FIELD_KEY, FIELD_KINDS, type FieldKind, type FieldOption, LIMITS, OPTION_VALUE, type TemplateField } from './layout.model';

/** Why a field's code is refused, or null. */
export function fieldKeyError(fields: readonly TemplateField[], index: number): 'invalid' | 'taken' | null {
  const key = fields[index]?.key ?? '';
  if (!FIELD_KEY.test(key)) return 'invalid';
  return fields.some((f, i) => i !== index && f.key === key) ? 'taken' : null;
}

/** A code not used yet: `champ1`, `champ2`… */
export function freeFieldKey(fields: readonly TemplateField[], base = 'champ'): string {
  const taken = new Set(fields.map((f) => f.key));
  let n = fields.length + 1;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

@Component({
  selector: 'dd-fields-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './fields-editor.css',
  template: `
    @let l = labels();
    <p class="dd-hint">{{ l.fieldsHint }}</p>
    @for (field of fields(); track $index; let i = $index) {
      <fieldset class="dd-field" [attr.data-field-index]="i" [disabled]="readonly()">
        <legend>{{ field.labels[lang()] || field.key }}</legend>
        <label [attr.for]="id(i, 'key')">{{ l.fieldKey }}</label>
        <input [id]="id(i, 'key')" type="text" dir="ltr" [value]="field.key" maxlength="30" autocomplete="off"
          [attr.aria-invalid]="keyError(i) !== null" (input)="patch(i, { key: value($event) })" data-input="key" />
        @if (keyError(i); as e) {
          <p class="dd-error">{{ e === 'taken' ? l.fieldKeyTaken : l.fieldKeyInvalid }}</p>
        }
        <label [attr.for]="id(i, 'kind')">{{ l.fieldKind }}</label>
        <select [id]="id(i, 'kind')" (change)="setKind(i, value($event))" data-input="kind">
          @for (kind of kinds; track kind) {
            <option [value]="kind" [selected]="kind === field.kind">{{ l.fieldKinds[kind] }}</option>
          }
        </select>
        <label [attr.for]="id(i, 'fr')">{{ l.fieldLabelFr }}</label>
        <input [id]="id(i, 'fr')" type="text" dir="ltr" lang="fr" maxlength="80" [value]="field.labels.fr"
          (input)="patch(i, { labels: { fr: value($event), ar: field.labels.ar } })" data-input="label-fr" />
        <label [attr.for]="id(i, 'ar')">{{ l.fieldLabelAr }}</label>
        <input [id]="id(i, 'ar')" type="text" dir="rtl" lang="ar" maxlength="80" [value]="field.labels.ar"
          (input)="patch(i, { labels: { fr: field.labels.fr, ar: value($event) } })" data-input="label-ar" />
        <label class="dd-check">
          <input type="checkbox" [checked]="field.required" (change)="patch(i, { required: checked($event) })" data-input="required" />
          {{ l.fieldRequired }}
        </label>
        @if (field.kind === 'choice') {
          <div class="dd-options">
            <p class="dd-sub">{{ l.fieldOptions }}</p>
            @for (option of field.options ?? []; track $index; let j = $index) {
              <div class="dd-option" [attr.data-option-index]="j">
                <input type="text" dir="ltr" [attr.aria-label]="l.optionValue" [value]="option.value" maxlength="30"
                  [attr.aria-invalid]="!optionOk(option.value)" (input)="patchOption(i, j, { value: value($event) })" />
                <input type="text" dir="ltr" lang="fr" [attr.aria-label]="l.fieldLabelFr" [value]="option.labels.fr" maxlength="80"
                  (input)="patchOption(i, j, { labels: { fr: value($event), ar: option.labels.ar } })" />
                <input type="text" dir="rtl" lang="ar" [attr.aria-label]="l.fieldLabelAr" [value]="option.labels.ar" maxlength="80"
                  (input)="patchOption(i, j, { labels: { fr: option.labels.fr, ar: value($event) } })" />
                <button type="button" class="dd-icon" [attr.aria-label]="l.remove" (click)="removeOption(i, j)">×</button>
              </div>
            }
            @if ((field.options?.length ?? 0) < maxOptions) {
              <button type="button" class="dd-link" (click)="addOption(i)" data-action="add-option">{{ l.addOption }}</button>
            }
          </div>
        }
        <div class="dd-row">
          <button type="button" class="dd-icon" [attr.aria-label]="l.moveUp" [disabled]="i === 0" (click)="move(i, -1)">↑</button>
          <button type="button" class="dd-icon" [attr.aria-label]="l.moveDown" [disabled]="i === fields().length - 1" (click)="move(i, 1)">↓</button>
          <button type="button" class="dd-link dd-danger" (click)="remove(i)" data-action="remove-field">{{ l.remove }}</button>
        </div>
      </fieldset>
    } @empty {
      <p class="dd-muted">{{ l.noFields }}</p>
    }
    @if (!readonly() && fields().length < maxFields) {
      <button type="button" class="dd-btn" (click)="add()" data-action="add-field">{{ l.addField }}</button>
    }
  `,
})
export class FieldsEditor {
  readonly fields = input.required<readonly TemplateField[]>();
  readonly labels = input.required<DesignerLabels>();
  readonly lang = input<'fr' | 'ar'>('fr');
  readonly readonly = input(false);
  readonly fieldsChange = output<TemplateField[]>();

  protected readonly kinds = FIELD_KINDS;
  protected readonly maxFields = LIMITS.fields;
  protected readonly maxOptions = LIMITS.options;
  private readonly uid = Math.random().toString(36).slice(2, 8);
  protected readonly errors = computed(() => this.fields().map((_, i) => fieldKeyError(this.fields(), i)));

  protected id(i: number, part: string): string {
    return `dd-field-${this.uid}-${i}-${part}`;
  }

  protected keyError(i: number): 'invalid' | 'taken' | null {
    return this.errors()[i] ?? null;
  }

  protected optionOk(value: string): boolean {
    return OPTION_VALUE.test(value);
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  private emit(fields: TemplateField[]): void {
    this.fieldsChange.emit(fields);
  }

  protected patch(i: number, patch: Partial<TemplateField>): void {
    this.emit(this.fields().map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }

  protected setKind(i: number, kind: string): void {
    const field = this.fields()[i];
    if (!field) return;
    const next: TemplateField = { key: field.key, kind: kind as FieldKind, labels: field.labels, required: field.required };
    this.emit(
      this.fields().map((f, j) =>
        j === i ? (kind === 'choice' ? { ...next, options: field.options?.length ? field.options : [{ value: 'choix1', labels: { fr: '', ar: '' } }] } : next) : f,
      ),
    );
  }

  protected add(): void {
    this.emit([...this.fields(), { key: freeFieldKey(this.fields()), kind: 'text', labels: { fr: '', ar: '' }, required: true }]);
  }

  protected remove(i: number): void {
    this.emit(this.fields().filter((_, j) => j !== i));
  }

  protected move(i: number, delta: number): void {
    const list = [...this.fields()];
    const [field] = list.splice(i, 1);
    if (!field) return;
    list.splice(i + delta, 0, field);
    this.emit(list);
  }

  private options(i: number, update: (options: FieldOption[]) => FieldOption[]): void {
    const field = this.fields()[i];
    if (!field) return;
    this.patch(i, { options: update([...(field.options ?? [])]) });
  }

  protected addOption(i: number): void {
    this.options(i, (options) => {
      const taken = new Set(options.map((o) => o.value));
      let n = options.length + 1;
      while (taken.has(`choix${n}`)) n += 1;
      return [...options, { value: `choix${n}`, labels: { fr: '', ar: '' } }];
    });
  }

  protected patchOption(i: number, j: number, patch: Partial<FieldOption>): void {
    this.options(i, (options) => options.map((o, k) => (k === j ? { ...o, ...patch } : o)));
  }

  protected removeOption(i: number, j: number): void {
    this.options(i, (options) => options.filter((_, k) => k !== j));
  }
}
