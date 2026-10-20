/**
 * The template layout model (docs/contracts/document-templates.md › Layout model). The API validates and renders it;
 * the designer edits it. Plain TypeScript: this file is the package's data contract.
 */

export type Lang = 'fr' | 'ar';
export type Subject = 'employment' | 'leave_request';
export type Align = 'start' | 'center' | 'end' | 'justify';

export interface PageSettings {
  readonly letterhead: boolean;
  readonly footer: boolean;
  readonly fontSize: 'small' | 'normal' | 'large';
  readonly margins: 'narrow' | 'normal' | 'wide';
}

export interface TextRun {
  readonly t: 'text';
  readonly text: string;
  readonly bold?: true;
  readonly italic?: true;
  readonly underline?: true;
}
export interface VarRun {
  readonly t: 'var';
  readonly key: string;
  readonly bold?: true;
  readonly italic?: true;
  readonly underline?: true;
}
export interface GenderRun {
  readonly t: 'gender';
  readonly m: string;
  readonly f: string;
  readonly x: string;
}
export interface OptionalRun {
  readonly t: 'optional';
  readonly key: string;
  readonly content: readonly Inline[];
}
export interface BreakRun {
  readonly t: 'break';
}
export type Inline = TextRun | VarRun | GenderRun | OptionalRun | BreakRun;

export interface TitleBlock {
  readonly id: string;
  readonly type: 'title';
  readonly align: Align;
  readonly content: readonly Inline[];
}
export interface HeadingBlock {
  readonly id: string;
  readonly type: 'heading';
  readonly align: Align;
  readonly content: readonly Inline[];
}
export interface ParagraphBlock {
  readonly id: string;
  readonly type: 'paragraph';
  readonly align: Align;
  readonly content: readonly Inline[];
  readonly when?: string;
}
export interface ListBlock {
  readonly id: string;
  readonly type: 'list';
  readonly ordered: boolean;
  readonly items: readonly (readonly Inline[])[];
}
export interface TableBlock {
  readonly id: string;
  readonly type: 'table';
  readonly widths: readonly number[];
  readonly headerRow: boolean;
  readonly borders: boolean;
  readonly rows: readonly (readonly (readonly Inline[])[])[];
}
export interface PositionsBlock {
  readonly id: string;
  readonly type: 'positions';
}
export interface SignatureBlock {
  readonly id: string;
  readonly type: 'signature';
  readonly align: 'start' | 'center' | 'end';
}
export interface SpacerBlock {
  readonly id: string;
  readonly type: 'spacer';
  readonly size: 'small' | 'medium' | 'large';
}
export interface DividerBlock {
  readonly id: string;
  readonly type: 'divider';
}
export interface PageBreakBlock {
  readonly id: string;
  readonly type: 'pageBreak';
}

export type Block =
  | TitleBlock
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | TableBlock
  | PositionsBlock
  | SignatureBlock
  | SpacerBlock
  | DividerBlock
  | PageBreakBlock;
export type BlockType = Block['type'];

/** Blocks whose content is one run of inlines, edited in place. */
export type TextBlock = TitleBlock | HeadingBlock | ParagraphBlock;

export interface TemplateLayout {
  readonly v: 1;
  readonly page: PageSettings;
  readonly blocks: readonly Block[];
}

export type FieldKind = 'text' | 'longText' | 'date' | 'number' | 'choice';
export const FIELD_KINDS: readonly FieldKind[] = ['text', 'longText', 'date', 'number', 'choice'];

export interface FieldOption {
  readonly value: string;
  readonly labels: { readonly fr: string; readonly ar: string };
}

export interface TemplateField {
  readonly key: string;
  readonly kind: FieldKind;
  readonly labels: { readonly fr: string; readonly ar: string };
  readonly required: boolean;
  readonly options?: readonly FieldOption[];
}

/** One placeholder of the catalogue (`GET /documents/template-variables`). */
export interface TemplateVariable {
  readonly key: string;
  readonly labels: { readonly fr: string; readonly ar: string; readonly en: string };
  readonly group: string;
  readonly sample: { readonly fr: string | null; readonly ar: string | null };
}

/** A problem the API reported on a part of the layout (`errors[].field`, e.g. `layouts.ar.blocks.3.content.2`). */
export interface LayoutProblem {
  readonly field: string;
  readonly message: string;
}

// --- Limits (contract › assumption 7; the API is the authority) --------------------------------------------------

export const LIMITS = {
  blocks: 150,
  textChars: 20_000,
  runChars: 2_000,
  tableColumns: 6,
  tableRows: 40,
  listItems: 30,
  fields: 10,
  options: 20,
} as const;

export const BLOCK_TYPES: readonly BlockType[] = ['title', 'heading', 'paragraph', 'list', 'table', 'positions', 'signature', 'spacer', 'divider', 'pageBreak'];

export const FIELD_KEY = /^[a-z][a-z0-9_]{0,29}$/;
export const OPTION_VALUE = /^[a-z0-9_]{1,30}$/;

export const DEFAULT_PAGE: PageSettings = { letterhead: true, footer: true, fontSize: 'normal', margins: 'normal' };

export function emptyLayout(): TemplateLayout {
  return { v: 1, page: DEFAULT_PAGE, blocks: [] };
}

export function isTextBlock(block: Block): block is TextBlock {
  return block.type === 'title' || block.type === 'heading' || block.type === 'paragraph';
}

/** A short id unique in `taken` (`^[a-z0-9]{1,16}$`). */
export function newBlockId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (;;) {
    const id = Math.floor(random() * 36 ** 8)
      .toString(36)
      .padStart(8, '0')
      .slice(0, 8);
    if (!taken.has(id)) return id;
  }
}

/** A new block of `type` with its defaults. */
export function newBlock(type: BlockType, id: string): Block {
  switch (type) {
    case 'title':
      return { id, type, align: 'center', content: [] };
    case 'heading':
      return { id, type, align: 'start', content: [] };
    case 'paragraph':
      return { id, type, align: 'justify', content: [] };
    case 'list':
      return { id, type, ordered: false, items: [[]] };
    case 'table':
      return { id, type, widths: [1, 2], headerRow: false, borders: true, rows: [[[], []], [[], []]] };
    case 'signature':
      return { id, type, align: 'end' };
    case 'spacer':
      return { id, type, size: 'medium' };
    case 'positions':
    case 'divider':
    case 'pageBreak':
      return { id, type };
  }
}

/** Every `var`/`optional` key used in inlines (deep). */
export function inlineKeys(inlines: readonly Inline[]): string[] {
  return inlines.flatMap((run) => (run.t === 'var' ? [run.key] : run.t === 'optional' ? [run.key, ...inlineKeys(run.content)] : []));
}

/** Plain text of inlines (variables as `[label]`), for summaries and counting. */
export function inlineText(inlines: readonly Inline[], label: (key: string) => string = (key) => key): string {
  return inlines
    .map((run) => {
      switch (run.t) {
        case 'text':
          return run.text;
        case 'var':
          return `[${label(run.key)}]`;
        case 'gender':
          return run.m;
        case 'optional':
          return inlineText(run.content, label);
        case 'break':
          return '\n';
      }
    })
    .join('');
}

/** Characters of text in a layout (assumption 7 counts typed text; placeholders do not count). */
function count(inlines: readonly Inline[]): number {
  return inlines.reduce((sum, run) => {
    if (run.t === 'text') return sum + run.text.length;
    if (run.t === 'gender') return sum + run.m.length + run.f.length + run.x.length;
    if (run.t === 'optional') return sum + count(run.content);
    return sum;
  }, 0);
}

export function layoutTextLength(layout: TemplateLayout): number {
  return layout.blocks.reduce((sum, block) => {
    if (isTextBlock(block)) return sum + count(block.content);
    if (block.type === 'list') return sum + block.items.reduce((s, item) => s + count(item), 0);
    if (block.type === 'table') return sum + block.rows.reduce((s, row) => s + row.reduce((c, cell) => c + count(cell), 0), 0);
    return sum;
  }, 0);
}

/** The block index a problem path names in `lang`'s layout (`layouts.<lang>.blocks.<n>…`), or null. */
export function problemBlockIndex(field: string, lang: Lang): number | null {
  const match = new RegExp(`^layouts\\.${lang}\\.blocks\\.(\\d+)`).exec(field);
  return match ? Number(match[1]) : null;
}
