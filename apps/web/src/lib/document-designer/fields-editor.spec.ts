import { TestBed } from '@angular/core/testing';
import { FieldsEditor, fieldKeyError, freeFieldKey } from './fields-editor';
import { DEFAULT_DESIGNER_LABELS } from './labels';
import type { TemplateField } from './layout.model';

const field = (key: string, extra: Partial<TemplateField> = {}): TemplateField => ({ key, kind: 'text', labels: { fr: key, ar: key }, required: true, ...extra });

describe('fields editor helpers', () => {
  it('checks codes: format and uniqueness', () => {
    const fields = [field('destination'), field('destination'), field('Bad-Key'), field('ok_2')];
    expect(fieldKeyError(fields, 0)).toBe('taken');
    expect(fieldKeyError(fields, 2)).toBe('invalid');
    expect(fieldKeyError(fields, 3)).toBeNull();
  });

  it('proposes a free code', () => {
    expect(freeFieldKey([])).toBe('champ1');
    expect(freeFieldKey([field('champ2'), field('x')])).toBe('champ3');
  });
});

function mount(fields: TemplateField[]) {
  const fixture = TestBed.createComponent(FieldsEditor);
  fixture.componentRef.setInput('fields', fields);
  fixture.componentRef.setInput('labels', DEFAULT_DESIGNER_LABELS.fr);
  const emitted: TemplateField[][] = [];
  fixture.componentInstance.fieldsChange.subscribe((value) => emitted.push(value));
  fixture.detectChanges();
  return { fixture, emitted, el: fixture.nativeElement as HTMLElement };
}

describe('FieldsEditor', () => {
  it('adds a field and edits its labels', () => {
    const { el, emitted } = mount([]);
    (el.querySelector('[data-action="add-field"]') as HTMLButtonElement).click();
    expect(emitted.at(-1)).toEqual([{ key: 'champ1', kind: 'text', labels: { fr: '', ar: '' }, required: true }]);
  });

  it('turns a field into a choice list with a first option, and shows an invalid code', () => {
    const { el, emitted, fixture } = mount([field('Mauvais')]);
    expect(el.textContent).toContain(DEFAULT_DESIGNER_LABELS.fr.fieldKeyInvalid);
    const kind = el.querySelector('[data-input="kind"]') as HTMLSelectElement;
    kind.value = 'choice';
    kind.dispatchEvent(new Event('change'));
    expect(emitted.at(-1)?.[0]).toMatchObject({ kind: 'choice', options: [{ value: 'choix1' }] });
    fixture.componentRef.setInput('fields', emitted.at(-1));
    fixture.detectChanges();
    (el.querySelector('[data-action="add-option"]') as HTMLButtonElement).click();
    expect(emitted.at(-1)?.[0]?.options?.map((o) => o.value)).toEqual(['choix1', 'choix2']);
  });

  it('removes a field', () => {
    const { el, emitted } = mount([field('a'), field('b')]);
    (el.querySelectorAll('[data-action="remove-field"]')[0] as HTMLButtonElement).click();
    expect(emitted.at(-1)?.map((f) => f.key)).toEqual(['b']);
  });
});
