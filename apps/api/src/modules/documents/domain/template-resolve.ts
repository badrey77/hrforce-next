/**
 * Resolution of a designed layout into what `designed.typ` lays out (docs/contracts/document-templates.md ›
 * Rendering): every placeholder replaced by its formatted value, the gender form chosen from the employee's sex,
 * `optional` runs and `when` blocks dropped when their variable is unknown, the positions held expanded into lines.
 * The result holds only plain strings with formatting flags: Typst receives them as JSON strings and never evaluates
 * them as markup. Pure: no Nest, no Kysely.
 */
import { stripBidiControls, type Align, type Inline, type LeafInline, type Marks, type PageSettings, type TemplateLayout } from './template-layout.js';
import type { DocumentLanguage } from './types.js';

/** A run of text with its formatting; `\n` is a line break. */
export interface Run {
  t: string;
  b?: true;
  i?: true;
  u?: true;
}

export type ResolvedBlock =
  | { type: 'title' | 'heading' | 'paragraph'; align: Align; runs: Run[] }
  | { type: 'list'; ordered: boolean; items: Run[][] }
  | { type: 'table'; widths: number[]; headerRow: boolean; borders: boolean; rows: Run[][][] }
  | { type: 'positions'; items: Run[][] }
  | { type: 'signature'; align: 'start' | 'center' | 'end' }
  | { type: 'spacer'; size: 'small' | 'medium' | 'large' }
  | { type: 'divider' }
  | { type: 'pageBreak' };

export interface ResolvedLayout {
  v: 1;
  page: PageSettings;
  blocks: ResolvedBlock[];
}

export interface ResolveInput {
  lang: DocumentLanguage;
  /** variable values (catalogue keys and `field.<key>`); null or missing = unknown */
  values: Readonly<Record<string, string | null>>;
  sex: 'M' | 'F' | null;
  /** the employee's job title (one position) and the positions held, formatted (certificat rule) */
  jobTitle: string;
  positions: readonly { jobTitle: string; fromText: string; toText: string }[];
}

const known = (value: string | null | undefined): value is string => typeof value === 'string' && value !== '';

function withMarks(text: string, marks: Marks): Run {
  return { t: stripBidiControls(text), ...(marks.bold ? { b: true as const } : {}), ...(marks.italic ? { i: true as const } : {}), ...(marks.underline ? { u: true as const } : {}) };
}

/** Adjacent runs with the same formatting become one (Arabic letters join only inside one run). */
function merge(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (run.t === '') continue;
    const last = out.at(-1);
    if (last && last.b === run.b && last.i === run.i && last.u === run.u) last.t += run.t;
    else out.push({ ...run });
  }
  return out;
}

export function resolveRuns(nodes: readonly Inline[], input: ResolveInput): Run[] {
  const leaf = (node: LeafInline): Run[] => {
    switch (node.t) {
      case 'text':
        return [withMarks(node.text, node)];
      case 'var': {
        const value = input.values[node.key];
        return known(value) ? [withMarks(value, node)] : [];
      }
      case 'gender':
        return [withMarks(input.sex === 'M' ? node.m : input.sex === 'F' ? node.f : node.x, {})];
      case 'break':
        return [{ t: '\n' }];
    }
  };
  const runs = nodes.flatMap((node) => {
    if (node.t !== 'optional') return leaf(node);
    return known(input.values[node.key]) ? node.content.flatMap(leaf) : [];
  });
  return merge(runs);
}

const FROM_TO: Readonly<Record<DocumentLanguage, [string, string]>> = { fr: [' du ', ' au '], ar: [' من ', ' إلى '] };

export function resolveLayout(layout: TemplateLayout, input: ResolveInput): ResolvedLayout {
  const runs = (nodes: readonly Inline[]) => resolveRuns(nodes, input);
  const blocks = layout.blocks.flatMap((b): ResolvedBlock[] => {
    switch (b.type) {
      case 'title':
      case 'heading':
        return [{ type: b.type, align: b.align, runs: runs(b.content) }];
      case 'paragraph':
        if (b.when !== undefined && !known(input.values[b.when])) return [];
        return [{ type: 'paragraph', align: b.align, runs: runs(b.content) }];
      case 'list':
        return [{ type: 'list', ordered: b.ordered, items: b.items.map(runs) }];
      case 'table':
        return [{ type: 'table', widths: b.widths, headerRow: b.headerRow, borders: b.borders, rows: b.rows.map((row) => row.map(runs)) }];
      case 'positions': {
        // the certificat's rule: one position (or none recorded) → its title in bold; several → « title du … au … »
        const [from, to] = FROM_TO[input.lang];
        const items =
          input.positions.length <= 1
            ? [[{ t: stripBidiControls(input.positions[0]?.jobTitle ?? input.jobTitle), b: true as const }]]
            : input.positions.map((p) => merge([{ t: stripBidiControls(p.jobTitle), b: true }, { t: stripBidiControls(`${from}${p.fromText}${to}${p.toText}`) }]));
        return [{ type: 'positions', items }];
      }
      default:
        return [b.type === 'signature' ? { type: 'signature', align: b.align } : b.type === 'spacer' ? { type: 'spacer', size: b.size } : { type: b.type }];
    }
  });
  return { v: 1, page: layout.page, blocks };
}
