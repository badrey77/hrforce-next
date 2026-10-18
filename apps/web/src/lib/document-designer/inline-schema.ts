/**
 * ProseMirror schema for one run of inlines (the content of a title, heading, paragraph, list item or table cell), and
 * the conversion between a ProseMirror document and the layout's `Inline[]`.
 *
 * The document is a single textblock: text with the marks bold / italic / underline, and atom nodes for the
 * placeholders (`var`), gender forms (`gender`), conditional runs (`optional`) and line breaks (`hard_break`).
 */
import { type Mark, type MarkType, type Node as PmNode, type NodeType, Schema } from 'prosemirror-model';
import type { Inline, TextRun, VarRun } from './layout.model';

export const inlineSchema = new Schema({
  nodes: {
    doc: { content: 'inline*' },
    text: { group: 'inline' },
    var: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: { key: { default: '' } },
      toDOM: (node) => ['span', { class: 'dd-chip', 'data-var': node.attrs['key'] as string }, `[${node.attrs['key'] as string}]`],
      parseDOM: [{ tag: 'span[data-var]', getAttrs: (dom) => ({ key: (dom as HTMLElement).dataset['var'] ?? '' }) }],
    },
    gender: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      marks: '',
      attrs: { m: { default: '' }, f: { default: '' }, x: { default: '' } },
      toDOM: (node) => ['span', { class: 'dd-chip dd-gender' }, `${node.attrs['m'] as string}/${node.attrs['f'] as string}`],
    },
    optional: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      marks: '',
      attrs: { key: { default: '' }, content: { default: [] } },
      toDOM: (node) => ['span', { class: 'dd-chip dd-optional' }, `[? ${node.attrs['key'] as string}]`],
    },
    hard_break: {
      group: 'inline',
      inline: true,
      selectable: false,
      toDOM: () => ['br'],
      parseDOM: [{ tag: 'br' }],
    },
  },
  marks: {
    bold: { toDOM: () => ['strong', 0], parseDOM: [{ tag: 'strong' }, { tag: 'b' }] },
    italic: { toDOM: () => ['em', 0], parseDOM: [{ tag: 'em' }, { tag: 'i' }] },
    underline: { toDOM: () => ['u', 0], parseDOM: [{ tag: 'u' }] },
  },
});

/** The schema's node and mark types, named (the schema defines every one of them). */
export const NODE = {
  var: inlineSchema.nodes['var'] as NodeType,
  gender: inlineSchema.nodes['gender'] as NodeType,
  optional: inlineSchema.nodes['optional'] as NodeType,
  hardBreak: inlineSchema.nodes['hard_break'] as NodeType,
} as const;

type MarkName = 'bold' | 'italic' | 'underline';
const MARK_NAMES: readonly MarkName[] = ['bold', 'italic', 'underline'];

export const MARK: Readonly<Record<MarkName, MarkType>> = {
  bold: inlineSchema.marks['bold'] as MarkType,
  italic: inlineSchema.marks['italic'] as MarkType,
  underline: inlineSchema.marks['underline'] as MarkType,
};

function marksOf(run: { bold?: true; italic?: true; underline?: true }): Mark[] {
  return MARK_NAMES.filter((name) => run[name]).map((name) => MARK[name].create());
}

function flagsOf(marks: readonly Mark[]): { bold?: true; italic?: true; underline?: true } {
  const flags: { bold?: true; italic?: true; underline?: true } = {};
  for (const mark of marks) {
    const name = mark.type.name as MarkName;
    if (MARK_NAMES.includes(name)) flags[name] = true;
  }
  return flags;
}

/** `Inline[]` → the ProseMirror nodes of a doc. Empty text runs are dropped. */
export function inlinesToNodes(inlines: readonly Inline[]): PmNode[] {
  const nodes: PmNode[] = [];
  for (const run of inlines) {
    switch (run.t) {
      case 'text':
        if (run.text) nodes.push(inlineSchema.text(run.text, marksOf(run)));
        break;
      case 'var':
        nodes.push(NODE.var.create({ key: run.key }, null, marksOf(run)));
        break;
      case 'gender':
        nodes.push(NODE.gender.create({ m: run.m, f: run.f, x: run.x }));
        break;
      case 'optional':
        nodes.push(NODE.optional.create({ key: run.key, content: structuredClone(run.content) }));
        break;
      case 'break':
        nodes.push(NODE.hardBreak.create());
        break;
    }
  }
  return nodes;
}

export function inlinesToDoc(inlines: readonly Inline[]): PmNode {
  return inlineSchema.node('doc', null, inlinesToNodes(inlines));
}

function sameFlags(a: TextRun, b: { bold?: true; italic?: true; underline?: true }): boolean {
  return MARK_NAMES.every((name) => Boolean(a[name]) === Boolean(b[name]));
}

/** A ProseMirror doc → `Inline[]` (adjacent text with the same marks merged). */
export function docToInlines(doc: PmNode): Inline[] {
  const out: Inline[] = [];
  doc.forEach((node) => {
    const name = node.type.name;
    if (node.isText) {
      const flags = flagsOf(node.marks);
      const last = out.at(-1);
      if (last?.t === 'text' && sameFlags(last, flags)) out[out.length - 1] = { ...last, text: last.text + (node.text ?? '') };
      else out.push({ t: 'text', text: node.text ?? '', ...flags });
    } else if (name === 'var') {
      const run: VarRun = { t: 'var', key: node.attrs['key'] as string, ...flagsOf(node.marks) };
      out.push(run);
    } else if (name === 'gender') {
      out.push({ t: 'gender', m: node.attrs['m'] as string, f: node.attrs['f'] as string, x: node.attrs['x'] as string });
    } else if (name === 'optional') {
      out.push({ t: 'optional', key: node.attrs['key'] as string, content: node.attrs['content'] as Inline[] });
    } else if (name === 'hard_break') {
      out.push({ t: 'break' });
    }
  });
  return out;
}

/** Structural equality of two inline runs (after normalisation). */
export function sameInlines(a: readonly Inline[], b: readonly Inline[]): boolean {
  return JSON.stringify(docToInlines(inlinesToDoc(a))) === JSON.stringify(docToInlines(inlinesToDoc(b)));
}
