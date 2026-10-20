import { TestBed } from '@angular/core/testing';
import { DocumentDesigner } from './document-designer';
import { DEFAULT_DESIGNER_LABELS } from './labels';
import { emptyLayout, type TemplateField, type TemplateLayout, type TemplateVariable } from './layout.model';

// jsdom has no layout: ProseMirror measures positions when it scrolls the selection into view.
function emptyRects(): DOMRectList {
  return { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList;
}

beforeAll(() => {
  Element.prototype.getClientRects ??= emptyRects;
  Range.prototype.getClientRects ??= emptyRects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

const VARIABLES: TemplateVariable[] = [
  { key: 'employee.fullName', labels: { fr: 'nom', ar: 'الاسم', en: 'name' }, group: 'employee', sample: { fr: 'Amine Benali', ar: 'أمين بن علي' } },
  { key: 'signatory.name', labels: { fr: 'nom du signataire', ar: 'اسم الموقع', en: 'signatory' }, group: 'signatory', sample: { fr: null, ar: null } },
  { key: 'signatory.title', labels: { fr: 'titre du signataire', ar: 'صفة الموقع', en: 'title' }, group: 'signatory', sample: { fr: null, ar: null } },
];

const LAYOUT: TemplateLayout = {
  ...emptyLayout(),
  blocks: [
    { id: 'a', type: 'title', align: 'center', content: [{ t: 'text', text: 'ORDRE DE MISSION' }] },
    { id: 'b', type: 'paragraph', align: 'justify', content: [{ t: 'text', text: 'Le salarié ' }, { t: 'var', key: 'employee.fullName' }] },
    { id: 'c', type: 'signature', align: 'end' },
  ],
};

async function mount(layout: TemplateLayout = LAYOUT, extra: Record<string, unknown> = {}) {
  const fixture = TestBed.createComponent(DocumentDesigner);
  fixture.componentRef.setInput('layout', layout);
  fixture.componentRef.setInput('variables', VARIABLES);
  for (const [name, value] of Object.entries(extra)) fixture.componentRef.setInput(name, value);
  const layouts: TemplateLayout[] = [];
  const fields: TemplateField[][] = [];
  const previews: string[] = [];
  fixture.componentInstance.layoutChange.subscribe((value) => {
    layouts.push(value);
    // the host echoes every change back (as the HRForce page does)
    fixture.componentRef.setInput('layout', value);
  });
  fixture.componentInstance.fieldsChange.subscribe((value) => fields.push(value));
  fixture.componentInstance.previewRequested.subscribe((value) => previews.push(value));
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const ids = () => [...el.querySelectorAll<HTMLElement>('[data-block-id]')].map((b) => b.dataset['blockId']);
  const click = (selector: string) => {
    (el.querySelector(selector) as HTMLElement).click();
    fixture.detectChanges();
  };
  return { fixture, el, layouts, fields, previews, ids, click };
}

describe('DocumentDesigner', () => {
  it('renders the blocks, the letterhead and footer areas, and the signature with its placeholders', async () => {
    const { el, ids } = await mount();
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(el.textContent).toContain(DEFAULT_DESIGNER_LABELS.fr.letterheadArea);
    expect(el.querySelector('[data-block-id="b"] .dd-chip')?.textContent).toBe('[nom]');
    expect(el.querySelector('[data-block-id="c"]')?.textContent).toContain('[titre du signataire]');
  });

  it('adds a block from the palette after the selection and emits the layout', async () => {
    const { ids, click, layouts } = await mount();
    click('[data-block-id="a"]');
    click('[data-add="table"]');
    expect(ids()).toHaveLength(4);
    expect(layouts.at(-1)?.blocks[1]?.type).toBe('table');
  });

  it('moves, duplicates and deletes with the block tools, and undoes / redoes', async () => {
    const { ids, click } = await mount();
    click('[data-block-id="a"]');
    click('[data-block-id="a"] [data-action="down"]');
    expect(ids()).toEqual(['b', 'a', 'c']);
    click('[data-action="undo"]');
    expect(ids()).toEqual(['a', 'b', 'c']);
    click('[data-action="redo"]');
    expect(ids()).toEqual(['b', 'a', 'c']);
    click('[data-block-id="c"]');
    click('[data-block-id="c"] [data-action="remove"]');
    expect(ids()).toEqual(['b', 'a']);
    click('[data-block-id="a"] [data-action="duplicate"]');
    expect(ids()).toHaveLength(3);
  });

  it('moves the selected block with Alt+Arrow and deletes it with Delete', async () => {
    const { el, fixture, ids } = await mount();
    const block = el.querySelector('[data-block-id="b"]') as HTMLElement;
    block.click();
    fixture.detectChanges();
    block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    fixture.detectChanges();
    expect(ids()).toEqual(['b', 'a', 'c']);
    (el.querySelector('[data-block-id="b"]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    fixture.detectChanges();
    expect(ids()).toEqual(['a', 'c']);
  });

  it('changes page settings and block properties', async () => {
    const { el, fixture, layouts, click } = await mount();
    const letterhead = el.querySelector('[data-page="letterhead"]') as HTMLInputElement;
    letterhead.checked = false;
    letterhead.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(layouts.at(-1)?.page.letterhead).toBe(false);
    expect(el.textContent).not.toContain(DEFAULT_DESIGNER_LABELS.fr.letterheadArea);

    click('[data-block-id="b"]');
    click('[data-panel-tab="properties"]');
    const when = el.querySelector('[data-prop="when"]') as HTMLSelectElement;
    when.value = 'employee.fullName';
    when.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(layouts.at(-1)?.blocks[1]).toMatchObject({ id: 'b', when: 'employee.fullName' });
  });

  it('inserts a placeholder from the panel into the focused text', async () => {
    const { el, fixture, layouts } = await mount();
    const editable = el.querySelector('[data-block-id="a"] .ProseMirror') as HTMLElement;
    editable.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    (el.querySelector('[data-insert="employee.fullName"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const title = layouts.at(-1)?.blocks[0];
    expect(title && 'content' in title ? title.content.some((run) => run.t === 'var' && run.key === 'employee.fullName') : false).toBe(true);
  });

  it('offers the fields as placeholders and edits them', async () => {
    const field: TemplateField = { key: 'destination', kind: 'text', labels: { fr: 'destination', ar: 'الوجهة' }, required: true };
    const { el, click, fields } = await mount(LAYOUT, { fields: [field] });
    expect(el.querySelector('[data-insert="field.destination"]')).not.toBeNull();
    click('[data-panel-tab="fields"]');
    click('[data-action="add-field"]');
    expect(fields.at(-1)?.map((f) => f.key)).toEqual(['destination', 'champ2']);
  });

  it('lays out Arabic right to left, highlights blocks with problems, and asks for a preview', async () => {
    const { el, click, previews } = await mount(LAYOUT, {
      lang: 'ar',
      problems: [{ field: 'layouts.ar.blocks.1.content.1', message: 'unknown_variable' }],
    });
    expect(el.querySelector('[data-canvas]')?.getAttribute('dir')).toBe('rtl');
    expect(el.querySelector('[data-block-id="b"]')?.classList).toContain('dd-has-problem');
    expect(el.querySelector('[data-problems]')?.textContent).toContain('unknown_variable');
    expect(el.querySelector('[data-block-id="b"] .dd-chip')?.textContent).toBe('[الاسم]');
    click('[data-action="preview"]');
    expect(previews).toEqual(['ar']);
  });

  it('hides the palette and tools when read-only, and edits nothing', async () => {
    const { el, layouts } = await mount(LAYOUT, { readonly: true, uiLang: 'ar' });
    expect(el.querySelector('[data-add]')).toBeNull();
    expect(el.querySelector('[data-action="remove"]')).toBeNull();
    expect(el.querySelector('[data-state="readonly"]')?.textContent).toContain(DEFAULT_DESIGNER_LABELS.ar.readonly);
    expect(layouts).toEqual([]);
  });

  it('offers « positions » only for an employment subject', async () => {
    const { el } = await mount(LAYOUT, { subject: 'leave_request' });
    expect(el.querySelector('[data-add="positions"]')).toBeNull();
    expect(el.querySelector('[data-add="signature"]')).not.toBeNull();
  });
});
