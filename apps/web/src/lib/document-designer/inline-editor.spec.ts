import { TestBed } from '@angular/core/testing';
import { bracketQuery, filterPlaceholders, fold, InlineEditor } from './inline-editor';
import type { Inline } from './layout.model';

// jsdom has no layout: ProseMirror measures positions when it scrolls the selection into view.
function emptyRects(): DOMRectList {
  return { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList;
}

beforeAll(() => {
  Element.prototype.getClientRects ??= emptyRects;
  Range.prototype.getClientRects ??= emptyRects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

describe('placeholder suggestions', () => {
  it('finds an open [ query before the caret', () => {
    expect(bracketQuery('Né le [dat')).toEqual({ query: 'dat', back: 4 });
    expect(bracketQuery('Né le [')).toEqual({ query: '', back: 1 });
    expect(bracketQuery('Né le [date]')).toBeNull();
    expect(bracketQuery('sans crochet')).toBeNull();
    expect(bracketQuery(`[${'x'.repeat(31)}`)).toBeNull();
    expect(bracketQuery('[a￼b')).toBeNull();
  });

  it('matches labels without accents or Arabic short vowels, prefix first', () => {
    const options = [
      { key: 'employee.hireDate', label: 'date d’embauche' },
      { key: 'document.issueDate', label: 'date d’émission' },
      { key: 'employee.birthDate', label: 'né(e) le' },
      { key: 'employee.fullName', label: 'الاسم' },
    ];
    expect(filterPlaceholders(options, 'emi').map((o) => o.key)).toEqual(['document.issueDate']);
    expect(filterPlaceholders(options, 'date').map((o) => o.key)).toEqual(['employee.hireDate', 'document.issueDate', 'employee.birthDate']);
    expect(filterPlaceholders(options, 'الاسم').map((o) => o.key)).toEqual(['employee.fullName']);
    expect(filterPlaceholders(options, '')).toHaveLength(4);
    expect(fold('Élément يَعمل')).toBe('element يعمل');
  });
});

async function mount(content: Inline[], extra: Record<string, unknown> = {}) {
  const fixture = TestBed.createComponent(InlineEditor);
  fixture.componentRef.setInput('content', content);
  fixture.componentRef.setInput('placeholders', [{ key: 'employee.fullName', label: 'nom' }]);
  for (const [name, value] of Object.entries(extra)) fixture.componentRef.setInput(name, value);
  const emitted: Inline[][] = [];
  fixture.componentInstance.contentChange.subscribe((value) => emitted.push(value));
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, emitted, el: fixture.nativeElement as HTMLElement };
}

describe('InlineEditor', () => {
  it('shows text and placeholders as chips with their label', async () => {
    const { el } = await mount([{ t: 'text', text: 'Bonjour ' }, { t: 'var', key: 'employee.fullName' }]);
    expect(el.querySelector('.ProseMirror')?.textContent).toBe('Bonjour [nom]');
    expect(el.querySelector('.dd-chip')?.getAttribute('contenteditable')).toBe('false');
  });

  it('inserts a placeholder and a gender form, emitting the new content', async () => {
    const { fixture, emitted } = await mount([{ t: 'text', text: 'A' }]);
    fixture.componentInstance.insertVar('employee.fullName');
    fixture.componentInstance.insertGender('né', 'née', 'né(e)');
    const last = emitted.at(-1) ?? [];
    expect(last.map((run) => run.t)).toContain('var');
    expect(last.find((run) => run.t === 'gender')).toEqual({ t: 'gender', m: 'né', f: 'née', x: 'né(e)' });
  });

  it('reloads when the content input changes from outside (undo), not on its own echo', async () => {
    const { fixture, el, emitted } = await mount([{ t: 'text', text: 'A' }]);
    fixture.componentRef.setInput('content', [{ t: 'text', text: 'Autre' }]);
    fixture.detectChanges();
    expect(el.querySelector('.ProseMirror')?.textContent).toBe('Autre');
    expect(emitted).toEqual([]);
  });

  it('is read-only on request and follows the direction', async () => {
    const { el } = await mount([{ t: 'text', text: 'نص' }], { readonly: true, dir: 'rtl', lang: 'ar' });
    expect(el.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe('false');
    expect(el.querySelector('.dd-editable')?.getAttribute('dir')).toBe('rtl');
  });
});
