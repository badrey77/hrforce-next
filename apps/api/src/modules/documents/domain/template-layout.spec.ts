import { describe, expect, it } from 'vitest';
import { builtinLayout } from './builtin-layouts.js';
import { blankLayout, hasPositions, layoutKeys, validateFields, validateLayout, type Block, type TemplateLayout, type ValidationContext } from './template-layout.js';

const employment: ValidationContext = { subject: 'employment', fieldKeys: new Set(['destination']) };
const leave: ValidationContext = { subject: 'leave_request', fieldKeys: new Set<string>() };

function layout(blocks: Block[]): TemplateLayout {
  return { ...blankLayout(), blocks };
}
const para = (id: string, text: string): Block => ({ id, type: 'paragraph', align: 'start', content: [{ t: 'text', text }] });
const codes = (input: unknown, context = employment) => validateLayout(input, context, 'layouts.fr').errors.map((e) => [e.field, e.code]);
const block = (key: string): Block => ({ id: 'a', type: 'paragraph', align: 'start', content: [{ t: 'var', key }] });
const row = (n: number) => Array.from({ length: n }, () => []);
const field = (over: Record<string, unknown> = {}) => ({ key: 'destination', kind: 'text', labels: { fr: 'Destination', ar: 'الوجهة' }, required: true, ...over });
const fieldCodes = (input: unknown) => validateFields(input).errors.map((e) => [e.field, e.code]);

describe('validateLayout', () => {
  it('accepts every designer copy of the built-ins, in both languages', () => {
    for (const code of ['attestation_travail', 'certificat_travail'] as const) {
      for (const lang of ['fr', 'ar'] as const) expect(codes(builtinLayout(code, lang))).toEqual([]);
    }
    for (const lang of ['fr', 'ar'] as const) expect(codes(builtinLayout('titre_conge', lang), leave)).toEqual([]);
  });

  it('refuses shapes the model does not have (unknown keys, block types, marks)', () => {
    expect(codes({ ...blankLayout(), extra: 1 })[0]?.[1]).toBe('invalid');
    expect(codes(layout([{ id: 'a', type: 'image' } as unknown as Block]))[0]).toEqual(['layouts.fr.blocks.0.type', 'invalid']);
    expect(codes(layout([{ id: 'a', type: 'paragraph', align: 'start', content: [{ t: 'text', text: 'x', bold: false }] } as unknown as Block]))[0]?.[1]).toBe('invalid');
    expect(codes({ v: 2, page: blankLayout().page, blocks: [] })[0]?.[1]).toBe('invalid');
  });

  it('block ids: format and uniqueness', () => {
    expect(codes(layout([para('a', 'x'), para('a', 'y')]))).toEqual([['layouts.fr.blocks.1.id', 'duplicate_id']]);
    expect(codes(layout([para('A-1', 'x')]))).toEqual([['layouts.fr.blocks.0.id', 'invalid_id']]);
  });

  it('variables must exist for the subject; fields must be declared', () => {
    expect(codes(layout([block('employee.fullName')]))).toEqual([]);
    expect(codes(layout([block('employee.salary')]))).toEqual([['layouts.fr.blocks.0.content.0.key', 'unknown_variable']]);
    expect(codes(layout([block('leave.days')]))).toEqual([['layouts.fr.blocks.0.content.0.key', 'unknown_variable']]);
    expect(codes(layout([block('leave.days')]), leave)).toEqual([]);
    expect(codes(layout([block('field.destination')]))).toEqual([]);
    expect(codes(layout([block('field.other')]))).toEqual([['layouts.fr.blocks.0.content.0.key', 'unknown_field']]);
    expect(codes(layout([{ id: 'a', type: 'paragraph', align: 'start', when: 'employee.nope', content: [] }]))).toEqual([['layouts.fr.blocks.0.when', 'unknown_variable']]);
    expect(codes(layout([{ id: 'a', type: 'paragraph', align: 'start', content: [{ t: 'optional', key: 'x.y', content: [{ t: 'var', key: 'z' }] }] }]))).toEqual([
      ['layouts.fr.blocks.0.content.0.key', 'unknown_variable'],
      ['layouts.fr.blocks.0.content.0.content.0.key', 'unknown_variable'],
    ]);
  });

  it('an optional run cannot contain another one', () => {
    const nested = { t: 'optional', key: 'employee.birthDate', content: [{ t: 'optional', key: 'employee.birthPlace', content: [] }] };
    expect(codes(layout([{ id: 'a', type: 'paragraph', align: 'start', content: [nested] } as unknown as Block]))[0]?.[1]).toBe('invalid');
  });

  it('texts: length, control characters; bidi controls are removed', () => {
    expect(codes(layout([para('a', 'x'.repeat(2001))]))).toEqual([['layouts.fr.blocks.0.content.0.text', 'text_too_long']]);
    expect(codes(layout([para('a', 'tab\there')]))).toEqual([['layouts.fr.blocks.0.content.0.text', 'invalid_text']]);
    expect(codes(layout([para('a', 'line\nbreak')]))).toEqual([]);
    const { layout: cleaned } = validateLayout(layout([para('a', 'a‮b⁦c')]), employment, 'layouts.fr');
    expect(cleaned?.blocks[0]).toMatchObject({ content: [{ text: 'abc' }] });
    expect(codes(layout([{ id: 'a', type: 'paragraph', align: 'start', content: [{ t: 'gender', m: '', f: '', x: '' }] }]))).toEqual([['layouts.fr.blocks.0.content.0', 'empty_gender']]);
  });

  it('limits: blocks, characters, list items, tables', () => {
    expect(codes(layout(Array.from({ length: 151 }, (_, i) => para(`b${i}`, 'x'))))).toEqual([['layouts.fr.blocks', 'too_many_blocks']]);
    expect(codes(layout(Array.from({ length: 11 }, (_, i) => para(`b${i}`, 'x'.repeat(2000)))))).toEqual([['layouts.fr.blocks', 'layout_too_large']]);
    const items = Array.from({ length: 31 }, () => [{ t: 'text' as const, text: 'x' }]);
    expect(codes(layout([{ id: 'a', type: 'list', ordered: false, items }]))).toEqual([['layouts.fr.blocks.0.items', 'too_many_items']]);
    expect(codes(layout([{ id: 'a', type: 'table', widths: [1], headerRow: false, borders: true, rows: [row(1)] }]))).toEqual([['layouts.fr.blocks.0', 'table_too_large']]);
    expect(codes(layout([{ id: 'a', type: 'table', widths: [1, 1, 1, 1, 1, 1, 1], headerRow: false, borders: true, rows: [] }]))).toEqual([['layouts.fr.blocks.0', 'table_too_large']]);
    expect(codes(layout([{ id: 'a', type: 'table', widths: [1, 1], headerRow: false, borders: true, rows: Array.from({ length: 41 }, () => row(2)) }]))).toEqual([['layouts.fr.blocks.0', 'table_too_large']]);
    expect(codes(layout([{ id: 'a', type: 'table', widths: [1, 11], headerRow: false, borders: true, rows: [row(3)] }]))).toEqual([
      ['layouts.fr.blocks.0.widths.1', 'invalid_width'],
      ['layouts.fr.blocks.0.rows.0', 'invalid_row'],
    ]);
  });

  it('the positions held exist for an employee document only', () => {
    expect(codes(layout([{ id: 'a', type: 'positions' }]))).toEqual([]);
    expect(codes(layout([{ id: 'a', type: 'positions' }]), leave)).toEqual([['layouts.fr.blocks.0', 'positions_not_allowed']]);
  });

  it('layoutKeys and hasPositions', () => {
    const l = builtinLayout('certificat_travail', 'fr');
    expect(hasPositions(l)).toBe(true);
    expect([...layoutKeys(l)]).toEqual(expect.arrayContaining(['company.legalName', 'employee.fullName', 'employee.birthDate', 'employee.birthPlace', 'employee.endDate']));
    expect(layoutKeys(builtinLayout('titre_conge', 'ar')).has('leave.daysText')).toBe(true);
  });
});

describe('validateFields', () => {

  it('accepts fields of every kind and trims labels', () => {
    const result = validateFields([
      field({ labels: { fr: '  Destination ', ar: 'الوجهة' } }),
      field({ key: 'objet', kind: 'longText' }),
      field({ key: 'depart', kind: 'date' }),
      field({ key: 'jours', kind: 'number', required: false }),
      field({ key: 'transport', kind: 'choice', options: [{ value: 'avion', labels: { fr: 'Avion', ar: 'طائرة' } }] }),
    ]);
    expect(result.errors).toEqual([]);
    expect(result.fields[0]?.labels.fr).toBe('Destination');
  });

  it('refuses bad keys, duplicates, labels, options and too many fields', () => {
    expect(fieldCodes([field({ key: 'Bad' })])).toEqual([['fields.0.key', 'invalid_key']]);
    expect(fieldCodes([field(), field()])).toEqual([['fields.1.key', 'duplicate_key']]);
    expect(fieldCodes([field({ labels: { fr: '', ar: 'x' } })])).toEqual([['fields.0.labels.fr', 'invalid_label']]);
    expect(fieldCodes([field({ kind: 'choice' })])).toEqual([['fields.0.options', 'invalid_options']]);
    expect(fieldCodes([field({ options: [] })])).toEqual([['fields.0.options', 'not_allowed']]);
    const options = [
      { value: 'a', labels: { fr: 'A', ar: 'أ' } },
      { value: 'a', labels: { fr: 'B', ar: 'ب' } },
    ];
    expect(fieldCodes([field({ kind: 'choice', options })])).toEqual([['fields.0.options.1.value', 'duplicate_value']]);
    expect(fieldCodes(Array.from({ length: 11 }, (_, i) => field({ key: `f${i}` })))).toEqual([['fields', 'too_many_fields']]);
    expect(fieldCodes([field({ kind: 'file' })])[0]?.[1]).toBe('invalid');
  });
});
