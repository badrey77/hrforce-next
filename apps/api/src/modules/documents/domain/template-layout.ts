/**
 * Designed templates — the layout model and its validation (docs/contracts/document-templates.md › Layout model,
 * Data). A layout is DATA, never Typst code (ADR 008 amendment 2026-10-09): it is checked here, resolved to plain text
 * runs by template-resolve.ts and laid out by the fixed `designed.typ`. Pure: no Nest, no Kysely.
 */
import { z } from 'zod';
import type { DocumentLanguage, DocumentSubject } from './types.js';
import { isVariableFor } from './template-variables.js';

// ── the model (shared with the web, final) ─────────────────────────────────────────────────────────────────────────

export type Align = 'start' | 'center' | 'end' | 'justify';

export interface Marks {
  bold?: true;
  italic?: true;
  underline?: true;
}

export type LeafInline =
  | ({ t: 'text'; text: string } & Marks)
  | ({ t: 'var'; key: string } & Marks)
  | { t: 'gender'; m: string; f: string; x: string }
  | { t: 'break' };

export type Inline = LeafInline | { t: 'optional'; key: string; content: LeafInline[] };

export type Block =
  | { id: string; type: 'title'; align: Align; content: Inline[] }
  | { id: string; type: 'heading'; align: Align; content: Inline[] }
  | { id: string; type: 'paragraph'; align: Align; content: Inline[]; when?: string }
  | { id: string; type: 'list'; ordered: boolean; items: Inline[][] }
  | { id: string; type: 'table'; widths: number[]; headerRow: boolean; borders: boolean; rows: Inline[][][] }
  | { id: string; type: 'positions' }
  | { id: string; type: 'signature'; align: 'start' | 'center' | 'end' }
  | { id: string; type: 'spacer'; size: 'small' | 'medium' | 'large' }
  | { id: string; type: 'divider' }
  | { id: string; type: 'pageBreak' };

export interface PageSettings {
  letterhead: boolean;
  footer: boolean;
  fontSize: 'small' | 'normal' | 'large';
  margins: 'narrow' | 'normal' | 'wide';
}

export interface TemplateLayout {
  v: 1;
  page: PageSettings;
  blocks: Block[];
}

export type TemplateLayouts = Partial<Record<DocumentLanguage, TemplateLayout>>;

export const FIELD_KINDS = ['text', 'longText', 'date', 'number', 'choice'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface TemplateField {
  key: string;
  kind: FieldKind;
  labels: { fr: string; ar: string };
  required: boolean;
  options?: { value: string; labels: { fr: string; ar: string } }[];
}

// ── limits (contract assumption 7) ─────────────────────────────────────────────────────────────────────────────────

export const LAYOUT_LIMITS = {
  blocks: 150,
  characters: 20_000,
  run: 2_000,
  genderForm: 200,
  listItems: 30,
  tableColumns: { min: 2, max: 6 },
  tableRows: 40,
  widthWeight: { min: 1, max: 10 },
  /** the whole version (layouts + fields) as JSON */
  versionBytes: 256 * 1024,
  fields: 10,
  fieldOptions: 20,
  /** a rendered document */
  pages: 5,
} as const;

export const BLOCK_ID = /^[a-z0-9]{1,16}$/;
export const FIELD_KEY = /^[a-z][a-z0-9_]{0,29}$/;
export const OPTION_VALUE = /^[a-z0-9_]{1,30}$/;

/**
 * Unicode bidi embedding, override and isolate controls: removed from every text (as from the snapshot): an
 * unterminated RLO typed into a template would print the rest of the document mirrored.
 */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;
/** C0/C1 controls except the line feed (a line break inside a block), and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

export function stripBidiControls(value: string): string {
  return value.replace(BIDI_CONTROLS, '');
}

// ── shapes (zod: structure and generous caps; the contract's limits and codes come after) ──────────────────────────

const marks = { bold: z.literal(true).optional(), italic: z.literal(true).optional(), underline: z.literal(true).optional() };
const str = z.string().max(100_000);
const leafInline = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('text'), text: str, ...marks }),
  z.strictObject({ t: z.literal('var'), key: z.string().max(80), ...marks }),
  z.strictObject({ t: z.literal('gender'), m: str, f: str, x: str }),
  z.strictObject({ t: z.literal('break') }),
]);
const inline = z.union([leafInline, z.strictObject({ t: z.literal('optional'), key: z.string().max(80), content: z.array(leafInline).max(2_000) })]);
const inlines = z.array(inline).max(2_000);
const align = z.enum(['start', 'center', 'end', 'justify']);
const id = z.string().max(64);
const block = z.discriminatedUnion('type', [
  z.strictObject({ id, type: z.literal('title'), align, content: inlines }),
  z.strictObject({ id, type: z.literal('heading'), align, content: inlines }),
  z.strictObject({ id, type: z.literal('paragraph'), align, content: inlines, when: z.string().max(80).optional() }),
  z.strictObject({ id, type: z.literal('list'), ordered: z.boolean(), items: z.array(inlines).max(1_000) }),
  z.strictObject({
    id,
    type: z.literal('table'),
    widths: z.array(z.number()).max(100),
    headerRow: z.boolean(),
    borders: z.boolean(),
    rows: z.array(z.array(inlines).max(100)).max(1_000),
  }),
  z.strictObject({ id, type: z.literal('positions') }),
  z.strictObject({ id, type: z.literal('signature'), align: z.enum(['start', 'center', 'end']) }),
  z.strictObject({ id, type: z.literal('spacer'), size: z.enum(['small', 'medium', 'large']) }),
  z.strictObject({ id, type: z.literal('divider') }),
  z.strictObject({ id, type: z.literal('pageBreak') }),
]);
export const layoutShape = z.strictObject({
  v: z.literal(1),
  page: z.strictObject({
    letterhead: z.boolean(),
    footer: z.boolean(),
    fontSize: z.enum(['small', 'normal', 'large']),
    margins: z.enum(['narrow', 'normal', 'wide']),
  }),
  blocks: z.array(block).max(10_000),
});
export const layoutsShape = z.strictObject({ fr: layoutShape.optional(), ar: layoutShape.optional() });
const pairShape = z.strictObject({ fr: z.string().max(10_000), ar: z.string().max(10_000) });
export const fieldShape = z.strictObject({
  key: z.string().max(100),
  kind: z.enum(FIELD_KINDS),
  labels: pairShape,
  required: z.boolean(),
  options: z.array(z.strictObject({ value: z.string().max(100), labels: pairShape })).max(1_000).optional(),
});
export const fieldsShape = z.array(fieldShape).max(1_000);

// ── semantic validation ────────────────────────────────────────────────────────────────────────────────────────────

export interface LayoutError {
  field: string;
  code: string;
  message: string;
}

export interface ValidationContext {
  subject: DocumentSubject;
  /** the version's field keys */
  fieldKeys: ReadonlySet<string>;
}

function issuePath(prefix: string, path: readonly PropertyKey[]): string {
  return [prefix, ...path.map(String)].filter(Boolean).join('.');
}

/** zod issues → `errors[]` (code `invalid`: a shape the model does not have). */
export function shapeErrors(prefix: string, error: z.ZodError): LayoutError[] {
  return error.issues.slice(0, 50).map((issue) => ({ field: issuePath(prefix, issue.path), code: 'invalid', message: issue.message }));
}

/** Fields: keys, kinds, labels, options; limits. Returns cleaned fields (labels trimmed) and errors. */
export function validateFields(input: unknown): { fields: TemplateField[]; errors: LayoutError[] } {
  const parsed = fieldsShape.safeParse(input);
  if (!parsed.success) return { fields: [], errors: shapeErrors('fields', parsed.error) };
  const errors: LayoutError[] = [];
  const fields: TemplateField[] = [];
  if (parsed.data.length > LAYOUT_LIMITS.fields) errors.push({ field: 'fields', code: 'too_many_fields', message: `At most ${LAYOUT_LIMITS.fields} fields.` });
  const keys = new Set<string>();
  parsed.data.forEach((f, i) => {
    const at = `fields.${i}`;
    if (!FIELD_KEY.test(f.key)) errors.push({ field: `${at}.key`, code: 'invalid_key', message: 'Lower-case letters, digits and _, starting with a letter (at most 30).' });
    else if (keys.has(f.key)) errors.push({ field: `${at}.key`, code: 'duplicate_key', message: 'Each field needs its own key.' });
    keys.add(f.key);
    const labels = { fr: stripBidiControls(f.labels.fr).trim(), ar: stripBidiControls(f.labels.ar).trim() };
    for (const lang of ['fr', 'ar'] as const) {
      if (labels[lang].length < 1 || labels[lang].length > 80 || CONTROL.test(labels[lang])) {
        errors.push({ field: `${at}.labels.${lang}`, code: 'invalid_label', message: '1 to 80 characters, no control characters.' });
      }
    }
    let options: TemplateField['options'];
    if (f.kind === 'choice') {
      const list = f.options ?? [];
      if (list.length < 1 || list.length > LAYOUT_LIMITS.fieldOptions) {
        errors.push({ field: `${at}.options`, code: 'invalid_options', message: `1 to ${LAYOUT_LIMITS.fieldOptions} options.` });
      }
      const values = new Set<string>();
      options = list.map((o, j) => {
        if (!OPTION_VALUE.test(o.value)) errors.push({ field: `${at}.options.${j}.value`, code: 'invalid_value', message: 'Lower-case letters, digits and _ (at most 30).' });
        else if (values.has(o.value)) errors.push({ field: `${at}.options.${j}.value`, code: 'duplicate_value', message: 'Each option needs its own value.' });
        values.add(o.value);
        const optionLabels = { fr: stripBidiControls(o.labels.fr).trim(), ar: stripBidiControls(o.labels.ar).trim() };
        for (const lang of ['fr', 'ar'] as const) {
          if (optionLabels[lang].length < 1 || optionLabels[lang].length > 80 || CONTROL.test(optionLabels[lang])) {
            errors.push({ field: `${at}.options.${j}.labels.${lang}`, code: 'invalid_label', message: '1 to 80 characters, no control characters.' });
          }
        }
        return { value: o.value, labels: optionLabels };
      });
    } else if (f.options !== undefined) {
      errors.push({ field: `${at}.options`, code: 'not_allowed', message: 'Only a choice field has options.' });
    }
    fields.push({ key: f.key, kind: f.kind, labels, required: f.required, ...(options ? { options } : {}) });
  });
  return { fields, errors };
}

/**
 * One layout: block ids, texts, variables and fields, limits (contract › Layout model, assumption 7). Returns the
 * layout with bidi controls removed from every text, and the errors (paths under `prefix`, e.g. `layouts.ar`).
 */
export function validateLayout(input: unknown, context: ValidationContext, prefix: string): { layout: TemplateLayout | null; errors: LayoutError[] } {
  const parsed = layoutShape.safeParse(input);
  if (!parsed.success) return { layout: null, errors: shapeErrors(prefix, parsed.error) };
  const layout = parsed.data as TemplateLayout;
  const errors: LayoutError[] = [];
  let characters = 0;
  const push = (field: string, code: string, message: string) => {
    if (errors.length < 100) errors.push({ field: `${prefix}.${field}`, code, message });
  };

  const checkText = (value: string, at: string, max: number): string => {
    const cleaned = stripBidiControls(value);
    characters += cleaned.length;
    if (cleaned.length > max) push(at, 'text_too_long', `At most ${max} characters.`);
    if (CONTROL.test(cleaned)) push(at, 'invalid_text', 'Control characters are not allowed (line breaks are).');
    return cleaned;
  };
  const checkKey = (key: string, at: string) => {
    if (key.startsWith('field.')) {
      if (!context.fieldKeys.has(key.slice('field.'.length))) push(at, 'unknown_field', `No field « ${key.slice(6)} » in this template.`);
    } else if (!isVariableFor(key, context.subject)) {
      push(at, 'unknown_variable', `Unknown placeholder « ${key} » for this kind of document.`);
    }
  };
  const leaf = (node: LeafInline, at: string): LeafInline => {
    switch (node.t) {
      case 'text':
        return { ...node, text: checkText(node.text, `${at}.text`, LAYOUT_LIMITS.run) };
      case 'var':
        checkKey(node.key, `${at}.key`);
        return node;
      case 'gender': {
        const forms = {
          m: checkText(node.m, `${at}.m`, LAYOUT_LIMITS.genderForm),
          f: checkText(node.f, `${at}.f`, LAYOUT_LIMITS.genderForm),
          x: checkText(node.x, `${at}.x`, LAYOUT_LIMITS.genderForm),
        };
        if (!forms.m && !forms.f && !forms.x) push(at, 'empty_gender', 'At least one of the three forms is needed.');
        return { t: 'gender', ...forms };
      }
      case 'break':
        return node;
    }
  };
  const content = (nodes: Inline[], at: string): Inline[] =>
    nodes.map((node, i) => {
      if (node.t !== 'optional') return leaf(node, `${at}.${i}`);
      checkKey(node.key, `${at}.${i}.key`);
      return { ...node, content: node.content.map((child, j) => leaf(child, `${at}.${i}.content.${j}`)) };
    });

  if (layout.blocks.length > LAYOUT_LIMITS.blocks) push('blocks', 'too_many_blocks', `At most ${LAYOUT_LIMITS.blocks} blocks.`);
  const ids = new Set<string>();
  const blocks = layout.blocks.map((b, i): Block => {
    const at = `blocks.${i}`;
    if (!BLOCK_ID.test(b.id)) push(`${at}.id`, 'invalid_id', 'Lower-case letters and digits (1 to 16).');
    else if (ids.has(b.id)) push(`${at}.id`, 'duplicate_id', 'Block ids must be unique.');
    ids.add(b.id);
    switch (b.type) {
      case 'title':
      case 'heading':
        return { ...b, content: content(b.content, `${at}.content`) };
      case 'paragraph':
        if (b.when !== undefined) checkKey(b.when, `${at}.when`);
        return { ...b, content: content(b.content, `${at}.content`) };
      case 'list':
        if (b.items.length > LAYOUT_LIMITS.listItems) push(`${at}.items`, 'too_many_items', `At most ${LAYOUT_LIMITS.listItems} items.`);
        return { ...b, items: b.items.map((item, j) => content(item, `${at}.items.${j}`)) };
      case 'table': {
        const { min, max } = LAYOUT_LIMITS.tableColumns;
        if (b.widths.length < min || b.widths.length > max || b.rows.length > LAYOUT_LIMITS.tableRows) {
          push(at, 'table_too_large', `${min} to ${max} columns and at most ${LAYOUT_LIMITS.tableRows} rows.`);
        }
        b.widths.forEach((w, j) => {
          if (!Number.isInteger(w) || w < LAYOUT_LIMITS.widthWeight.min || w > LAYOUT_LIMITS.widthWeight.max) {
            push(`${at}.widths.${j}`, 'invalid_width', `A whole number from ${LAYOUT_LIMITS.widthWeight.min} to ${LAYOUT_LIMITS.widthWeight.max}.`);
          }
        });
        b.rows.forEach((row, j) => {
          if (row.length !== b.widths.length) push(`${at}.rows.${j}`, 'invalid_row', 'Each row has one cell per column.');
        });
        return { ...b, rows: b.rows.map((row, j) => row.map((cell, k) => content(cell, `${at}.rows.${j}.${k}`))) };
      }
      case 'positions':
        if (context.subject !== 'employment') push(at, 'positions_not_allowed', 'The positions held exist for an employee document only.');
        return b;
      default:
        return b;
    }
  });
  if (characters > LAYOUT_LIMITS.characters) push('blocks', 'layout_too_large', `At most ${LAYOUT_LIMITS.characters} characters of text.`);
  return { layout: { v: 1, page: layout.page, blocks }, errors };
}

/** Every variable key a layout uses (var, optional, when), fields included (`field.<key>`). */
export function layoutKeys(layout: TemplateLayout): Set<string> {
  const keys = new Set<string>();
  const walk = (nodes: readonly Inline[]) => {
    for (const node of nodes) {
      if (node.t === 'var') keys.add(node.key);
      if (node.t === 'optional') {
        keys.add(node.key);
        walk(node.content);
      }
    }
  };
  for (const b of layout.blocks) {
    if (b.type === 'title' || b.type === 'heading') walk(b.content);
    if (b.type === 'paragraph') {
      if (b.when) keys.add(b.when);
      walk(b.content);
    }
    if (b.type === 'list') b.items.forEach(walk);
    if (b.type === 'table') b.rows.forEach((row) => row.forEach(walk));
  }
  return keys;
}

export function hasPositions(layout: TemplateLayout): boolean {
  return layout.blocks.some((b) => b.type === 'positions');
}

/** An empty layout (a new blank draft). */
export function blankLayout(): TemplateLayout {
  return { v: 1, page: { letterhead: true, footer: true, fontSize: 'normal', margins: 'normal' }, blocks: [] };
}
