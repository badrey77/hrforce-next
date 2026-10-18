/**
 * Pure operations on a layout (no Angular): insert, move, duplicate, remove, update a block, and an undo/redo history.
 * Every operation returns a new layout; the input is never mutated.
 */
import { type Block, type BlockType, type Inline, newBlock, newBlockId, type PageSettings, type TemplateLayout } from './layout.model';

function ids(layout: TemplateLayout): Set<string> {
  return new Set(layout.blocks.map((block) => block.id));
}

/** Inserts a new block of `type` after `afterId` (at the end when null/unknown); returns the layout and the new id. */
export function insertBlock(layout: TemplateLayout, type: BlockType, afterId: string | null, random?: () => number): { layout: TemplateLayout; id: string } {
  const id = newBlockId(ids(layout), random);
  const block = newBlock(type, id);
  const at = afterId === null ? -1 : layout.blocks.findIndex((b) => b.id === afterId);
  const blocks = [...layout.blocks];
  blocks.splice(at < 0 ? blocks.length : at + 1, 0, block);
  return { layout: { ...layout, blocks }, id };
}

/** Moves a block by `delta` positions (clamped). */
export function moveBlock(layout: TemplateLayout, id: string, delta: number): TemplateLayout {
  const from = layout.blocks.findIndex((b) => b.id === id);
  if (from < 0) return layout;
  const to = Math.max(0, Math.min(layout.blocks.length - 1, from + delta));
  if (to === from) return layout;
  return moveBlockTo(layout, id, to);
}

/** Moves a block to index `to` (drag and drop). */
export function moveBlockTo(layout: TemplateLayout, id: string, to: number): TemplateLayout {
  const from = layout.blocks.findIndex((b) => b.id === id);
  if (from < 0) return layout;
  const blocks = [...layout.blocks];
  const [block] = blocks.splice(from, 1);
  if (!block) return layout;
  blocks.splice(Math.max(0, Math.min(blocks.length, to)), 0, block);
  return { ...layout, blocks };
}

export function duplicateBlock(layout: TemplateLayout, id: string, random?: () => number): { layout: TemplateLayout; id: string | null } {
  const at = layout.blocks.findIndex((b) => b.id === id);
  const source = layout.blocks[at];
  if (!source) return { layout, id: null };
  const copyId = newBlockId(ids(layout), random);
  const copy = { ...structuredClone(source), id: copyId } as Block;
  const blocks = [...layout.blocks];
  blocks.splice(at + 1, 0, copy);
  return { layout: { ...layout, blocks }, id: copyId };
}

/** Removes a block; returns the id to select next (the following block, else the previous one). */
export function removeBlock(layout: TemplateLayout, id: string): { layout: TemplateLayout; next: string | null } {
  const at = layout.blocks.findIndex((b) => b.id === id);
  if (at < 0) return { layout, next: null };
  const blocks = layout.blocks.filter((b) => b.id !== id);
  const next = blocks[at] ?? blocks[at - 1] ?? null;
  return { layout: { ...layout, blocks }, next: next?.id ?? null };
}

/** Replaces block `id` by `update(block)` (same id). */
export function updateBlock(layout: TemplateLayout, id: string, update: (block: Block) => Block): TemplateLayout {
  return { ...layout, blocks: layout.blocks.map((b) => (b.id === id ? { ...update(b), id } : b)) };
}

export function updatePage(layout: TemplateLayout, page: Partial<PageSettings>): TemplateLayout {
  return { ...layout, page: { ...layout.page, ...page } };
}

// --- Tables and lists -------------------------------------------------------------------------------------------

export function setTableColumns(block: Extract<Block, { type: 'table' }>, count: number): Extract<Block, { type: 'table' }> {
  const n = Math.max(2, Math.min(6, count));
  const widths = Array.from({ length: n }, (_, i) => block.widths[i] ?? 1);
  const rows = block.rows.map((row) => Array.from({ length: n }, (_, i) => row[i] ?? ([] as readonly Inline[])));
  return { ...block, widths, rows };
}

export function setTableRows(block: Extract<Block, { type: 'table' }>, count: number): Extract<Block, { type: 'table' }> {
  const n = Math.max(1, Math.min(40, count));
  const cols = block.widths.length;
  const rows = Array.from({ length: n }, (_, i) => block.rows[i] ?? Array.from({ length: cols }, () => [] as readonly Inline[]));
  return { ...block, rows };
}

export function setTableCell(block: Extract<Block, { type: 'table' }>, row: number, col: number, content: readonly Inline[]): Extract<Block, { type: 'table' }> {
  return { ...block, rows: block.rows.map((r, i) => (i === row ? r.map((c, j) => (j === col ? content : c)) : r)) };
}

export function setListItem(block: Extract<Block, { type: 'list' }>, index: number, content: readonly Inline[]): Extract<Block, { type: 'list' }> {
  return { ...block, items: block.items.map((item, i) => (i === index ? content : item)) };
}

export function addListItem(block: Extract<Block, { type: 'list' }>, after: number): Extract<Block, { type: 'list' }> {
  if (block.items.length >= 30) return block;
  const items = [...block.items];
  items.splice(after + 1, 0, []);
  return { ...block, items };
}

export function removeListItem(block: Extract<Block, { type: 'list' }>, index: number): Extract<Block, { type: 'list' }> {
  if (block.items.length <= 1) return block;
  return { ...block, items: block.items.filter((_, i) => i !== index) };
}

// --- History ----------------------------------------------------------------------------------------------------

export const HISTORY_LIMIT = 100;

/**
 * Undo/redo over immutable states. `push` with a `group` key merges consecutive pushes of the same group made within
 * `mergeMs` (typing in one block is one step, not one step per keystroke).
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastGroup: string | null = null;
  private lastAt = 0;

  constructor(
    private present: T,
    private readonly limit = HISTORY_LIMIT,
    private readonly mergeMs = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get current(): T {
    return this.present;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  push(next: T, group: string | null = null): void {
    if (next === this.present) return;
    const at = this.now();
    const merge = group !== null && group === this.lastGroup && at - this.lastAt <= this.mergeMs && this.past.length > 0;
    if (!merge) {
      this.past.push(this.present);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.present = next;
    this.future = [];
    this.lastGroup = group;
    this.lastAt = at;
  }

  undo(): T {
    const previous = this.past.pop();
    if (previous === undefined) return this.present;
    this.future.push(this.present);
    this.present = previous;
    this.lastGroup = null;
    return previous;
  }

  redo(): T {
    const next = this.future.pop();
    if (next === undefined) return this.present;
    this.past.push(this.present);
    this.present = next;
    this.lastGroup = null;
    return next;
  }

  /** Starts over from `state` (a version loaded from the server). */
  reset(state: T): void {
    this.present = state;
    this.past = [];
    this.future = [];
    this.lastGroup = null;
  }
}
