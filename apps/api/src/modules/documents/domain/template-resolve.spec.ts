import { describe, expect, it } from 'vitest';
import { checkFieldValues, formatFieldValues, sampleFieldValues } from './template-fields.js';
import { blankLayout, type Inline, type TemplateField } from './template-layout.js';
import { resolveLayout, resolveRuns, type ResolveInput } from './template-resolve.js';
import { daysPhrase } from './snapshot.js';

const input = (over: Partial<ResolveInput> = {}): ResolveInput => ({
  lang: 'fr',
  values: { 'employee.fullName': 'Amina Benali', 'employee.birthPlace': null, 'employee.birthDate': '1er mars 1990', 'field.destination': 'Oran' },
  sex: 'F',
  jobTitle: 'Agent',
  positions: [],
  ...over,
});

describe('resolveRuns', () => {
  it('replaces variables, keeps marks, merges runs of the same formatting', () => {
    const nodes: Inline[] = [
      { t: 'text', text: 'Mme ' },
      { t: 'var', key: 'employee.fullName', bold: true },
      { t: 'text', text: ' part pour ' },
      { t: 'var', key: 'field.destination' },
      { t: 'text', text: '.' },
    ];
    expect(resolveRuns(nodes, input())).toEqual([{ t: 'Mme ' }, { t: 'Amina Benali', b: true }, { t: ' part pour Oran.' }]);
  });

  it('chooses the gender form from the sex (unknown → the neutral form)', () => {
    const nodes: Inline[] = [{ t: 'gender', m: 'né', f: 'née', x: 'né(e)' }];
    expect(resolveRuns(nodes, input({ sex: 'M' }))).toEqual([{ t: 'né' }]);
    expect(resolveRuns(nodes, input({ sex: 'F' }))).toEqual([{ t: 'née' }]);
    expect(resolveRuns(nodes, input({ sex: null }))).toEqual([{ t: 'né(e)' }]);
  });

  it('optional runs print only when their variable is known; unknown variables print nothing', () => {
    const nodes: Inline[] = [
      { t: 'text', text: 'X' },
      { t: 'optional', key: 'employee.birthDate', content: [{ t: 'text', text: ', née le ' }, { t: 'var', key: 'employee.birthDate' }] },
      { t: 'optional', key: 'employee.birthPlace', content: [{ t: 'text', text: ' à ' }, { t: 'var', key: 'employee.birthPlace' }] },
      { t: 'var', key: 'company.rc' },
      { t: 'break' },
      { t: 'text', text: 'Y' },
    ];
    expect(resolveRuns(nodes, input())).toEqual([{ t: 'X, née le 1er mars 1990\nY' }]);
  });

  it('removes bidi controls from values', () => {
    expect(resolveRuns([{ t: 'var', key: 'x' }], input({ values: { x: 'a‮b' } }))).toEqual([{ t: 'ab' }]);
  });
});

describe('resolveLayout', () => {
  it('drops `when` paragraphs of unknown variables and expands the positions held', () => {
    const layout = {
      ...blankLayout(),
      blocks: [
        { id: 'a', type: 'paragraph' as const, align: 'start' as const, when: 'employee.endDate', content: [{ t: 'text' as const, text: 'fin' }] },
        { id: 'b', type: 'positions' as const },
        { id: 'c', type: 'signature' as const, align: 'end' as const },
      ],
    };
    const one = resolveLayout(layout, input());
    expect(one.blocks).toEqual([{ type: 'positions', items: [[{ t: 'Agent', b: true }]] }, { type: 'signature', align: 'end' }]);
    const positions = [
      { jobTitle: 'Agent', fromText: '1er septembre 2019', toText: '31 mars 2022' },
      { jobTitle: 'Chef', fromText: '1er avril 2022', toText: '30 juin 2026' },
    ];
    expect(resolveLayout(layout, input({ positions })).blocks[0]).toEqual({
      type: 'positions',
      items: [
        [{ t: 'Agent', b: true }, { t: ' du 1er septembre 2019 au 31 mars 2022' }],
        [{ t: 'Chef', b: true }, { t: ' du 1er avril 2022 au 30 juin 2026' }],
      ],
    });
    expect(resolveLayout(layout, input({ lang: 'ar', positions, values: { 'employee.endDate': '30 جوان 2026' } })).blocks[1]).toMatchObject({
      items: [[{ t: 'Agent', b: true }, { t: ' من 1er septembre 2019 إلى 31 mars 2022' }], expect.anything()],
    });
  });
});

describe('field values', () => {
  const fields: TemplateField[] = [
    { key: 'destination', kind: 'text', labels: { fr: 'Destination', ar: 'الوجهة' }, required: true },
    { key: 'objet', kind: 'longText', labels: { fr: 'Objet', ar: 'الموضوع' }, required: false },
    { key: 'depart', kind: 'date', labels: { fr: 'Départ', ar: 'الذهاب' }, required: false },
    { key: 'jours', kind: 'number', labels: { fr: 'Jours', ar: 'الأيام' }, required: false },
    { key: 'transport', kind: 'choice', labels: { fr: 'Transport', ar: 'النقل' }, required: false, options: [{ value: 'avion', labels: { fr: 'Avion', ar: 'طائرة' } }] },
  ];
  const errs = (values: Record<string, unknown>) => checkFieldValues(fields, values).errors.map((e) => [e.field, e.code]);

  it('required, unknown, kinds', () => {
    expect(errs({})).toEqual([['fields.destination', 'required']]);
    expect(errs({ destination: '  ' })).toEqual([['fields.destination', 'required']]);
    expect(errs({ destination: 'Oran', nope: 'x' })).toEqual([['fields.nope', 'unknown_field']]);
    expect(errs({ destination: 'a\nb' })).toEqual([['fields.destination', 'invalid_value']]);
    expect(errs({ destination: 'x'.repeat(501) })).toEqual([['fields.destination', 'invalid_value']]);
    expect(errs({ destination: 'Oran', objet: 'ligne 1\r\nligne 2' })).toEqual([]);
    expect(errs({ destination: 'Oran', objet: 'x'.repeat(2001) })).toEqual([['fields.objet', 'invalid_value']]);
    expect(errs({ destination: 'Oran', depart: '2026-02-30' })).toEqual([['fields.depart', 'invalid_value']]);
    expect(errs({ destination: 'Oran', jours: '1e3' })).toEqual([['fields.jours', 'invalid_value']]);
    expect(errs({ destination: 'Oran', transport: 'train' })).toEqual([['fields.transport', 'invalid_value']]);
    expect(errs({ destination: 42 })).toEqual([['fields.destination', 'invalid_value']]);
  });

  it('formats per language', () => {
    const { values } = checkFieldValues(fields, { destination: ' Oran ', objet: 'a\r\nb', depart: '2026-10-01', jours: '2,5', transport: 'avion' });
    expect(values).toEqual({ destination: 'Oran', objet: 'a\nb', depart: '2026-10-01', jours: '2.5', transport: 'avion' });
    expect(formatFieldValues(fields, values, 'fr')).toEqual({ destination: 'Oran', objet: 'a\nb', depart: '1er octobre 2026', jours: '2,5', transport: 'Avion' });
    expect(formatFieldValues(fields, values, 'ar')).toMatchObject({ depart: '1 أكتوبر 2026', jours: '2.5', transport: 'طائرة' });
    expect(formatFieldValues(fields, { destination: 'Oran' }, 'fr')['objet']).toBeNull();
  });

  it('a field called `constructor` (a key every object inherits) may be left empty', () => {
    const inherited: TemplateField[] = [{ key: 'constructor', kind: 'text', labels: { fr: 'Constructeur', ar: 'الصانع' }, required: false }];
    expect(checkFieldValues(inherited, {})).toEqual({ values: {}, errors: [] });
    expect(formatFieldValues(inherited, {}, 'fr')).toEqual({ constructor: null });
    const { values } = checkFieldValues(inherited, { constructor: 'Renault' });
    expect(formatFieldValues(inherited, values, 'fr')).toEqual({ constructor: 'Renault' });
  });

  it('sample values pass their own checks', () => {
    expect(checkFieldValues(fields, sampleFieldValues(fields, 'ar')).errors).toEqual([]);
  });
});

describe('daysPhrase', () => {
  it.each([
    ['1', 'fr', '1 jour'],
    ['0,5', 'fr', '0,5 jour'],
    ['15', 'fr', '15 jours'],
    ['1', 'ar', 'يوم واحد'],
    ['2', 'ar', 'يومان'],
    ['10', 'ar', '10 أيام'],
    ['11', 'ar', '11 يومًا'],
    ['100', 'ar', '100 يوم'],
    ['103', 'ar', '103 أيام'],
    ['115', 'ar', '115 يومًا'],
    ['0.5', 'ar', 'نصف يوم'],
    ['2.5', 'ar', '2.5 يوم'],
  ] as const)('%s (%s) → %s', (days, lang, phrase) => {
    expect(daysPhrase(days, lang)).toBe(phrase);
  });
});
