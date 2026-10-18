import { docToInlines, inlinesToDoc, sameInlines } from './inline-schema';
import type { Inline } from './layout.model';

describe('inline schema', () => {
  it('round-trips every inline kind with its marks', () => {
    const inlines: Inline[] = [
      { t: 'text', text: 'Nous attestons que ' },
      { t: 'var', key: 'employee.civility' },
      { t: 'text', text: ' ' },
      { t: 'var', key: 'employee.fullName', bold: true },
      { t: 'text', text: ', ' },
      { t: 'gender', m: 'né', f: 'née', x: 'né(e)' },
      { t: 'optional', key: 'employee.birthDate', content: [{ t: 'text', text: ' le ' }, { t: 'var', key: 'employee.birthDate' }] },
      { t: 'break' },
      { t: 'text', text: 'souligné', underline: true, italic: true },
    ];
    expect(docToInlines(inlinesToDoc(inlines))).toEqual(inlines);
  });

  it('merges adjacent text with the same marks and drops empty runs', () => {
    const inlines: Inline[] = [
      { t: 'text', text: 'a' },
      { t: 'text', text: '' },
      { t: 'text', text: 'b' },
      { t: 'text', text: 'c', bold: true },
    ];
    expect(docToInlines(inlinesToDoc(inlines))).toEqual([
      { t: 'text', text: 'ab' },
      { t: 'text', text: 'c', bold: true },
    ]);
    expect(sameInlines(inlines, [{ t: 'text', text: 'ab' }, { t: 'text', text: 'c', bold: true }])).toBe(true);
  });

  it('keeps Arabic text and markup-looking text as plain text', () => {
    const inlines: Inline[] = [{ t: 'text', text: 'يعمل لدى مؤسستنا #panic("x") *b* $x$' }];
    expect(docToInlines(inlinesToDoc(inlines))).toEqual(inlines);
  });
});
