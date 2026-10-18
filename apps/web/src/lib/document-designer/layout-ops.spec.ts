import {
  addListItem,
  duplicateBlock,
  History,
  HISTORY_LIMIT,
  insertBlock,
  moveBlock,
  moveBlockTo,
  removeBlock,
  removeListItem,
  setTableColumns,
  setTableRows,
  updateBlock,
  updatePage,
} from './layout-ops';
import { emptyLayout, inlineText, layoutTextLength, newBlock, problemBlockIndex, type TemplateLayout } from './layout.model';

function layoutOf(...ids: string[]): TemplateLayout {
  return { ...emptyLayout(), blocks: ids.map((id) => newBlock('paragraph', id)) };
}

const order = (layout: TemplateLayout) => layout.blocks.map((b) => b.id);

describe('layout operations', () => {
  it('inserts after the given block, at the end without one, with defaults', () => {
    let n = 0;
    const random = () => (++n * 0.01) % 1;
    const a = insertBlock(layoutOf('a', 'b'), 'table', 'a', random);
    expect(order(a.layout)).toEqual(['a', a.id, 'b']);
    expect(a.layout.blocks[1]).toMatchObject({ type: 'table', widths: [1, 2], headerRow: false, borders: true });
    const end = insertBlock(layoutOf('a'), 'signature', null, random);
    expect(order(end.layout)).toEqual(['a', end.id]);
    expect(end.layout.blocks[1]).toEqual({ id: end.id, type: 'signature', align: 'end' });
    expect(end.id).toMatch(/^[a-z0-9]{1,16}$/);
  });

  it('never reuses an id', () => {
    const values = [0.5, 0.5, 0.25];
    const random = () => values.shift() ?? Math.random();
    const first = insertBlock(emptyLayout(), 'paragraph', null, random);
    const second = insertBlock(first.layout, 'paragraph', null, random);
    expect(second.id).not.toBe(first.id);
  });

  it('moves by a delta (clamped) and to an index', () => {
    const layout = layoutOf('a', 'b', 'c');
    expect(order(moveBlock(layout, 'a', 1))).toEqual(['b', 'a', 'c']);
    expect(order(moveBlock(layout, 'a', -1))).toEqual(['a', 'b', 'c']);
    expect(moveBlock(layout, 'a', -1)).toBe(layout);
    expect(order(moveBlock(layout, 'c', -5))).toEqual(['c', 'a', 'b']);
    expect(order(moveBlockTo(layout, 'a', 2))).toEqual(['b', 'c', 'a']);
  });

  it('duplicates a block right after it with a new id, deep-copied', () => {
    const layout = { ...emptyLayout(), blocks: [{ id: 'a', type: 'paragraph' as const, align: 'start' as const, content: [{ t: 'text' as const, text: 'x' }] }] };
    const { layout: next, id } = duplicateBlock(layout, 'a');
    expect(order(next)).toEqual(['a', id]);
    expect(next.blocks[1]).toEqual({ ...layout.blocks[0], id });
    expect(next.blocks[1]).not.toBe(layout.blocks[0]);
  });

  it('removes a block and names the next one to select', () => {
    expect(removeBlock(layoutOf('a', 'b', 'c'), 'b')).toEqual({ layout: layoutOf('a', 'c'), next: 'c' });
    expect(removeBlock(layoutOf('a', 'b'), 'b').next).toBe('a');
    expect(removeBlock(layoutOf('a'), 'a').next).toBeNull();
  });

  it('updates a block keeping its id, and the page settings', () => {
    const next = updateBlock(layoutOf('a'), 'a', (b) => ({ ...b, id: 'other', align: 'center' }) as typeof b);
    expect(next.blocks[0]).toMatchObject({ id: 'a', align: 'center' });
    expect(updatePage(emptyLayout(), { fontSize: 'large' }).page).toEqual({ letterhead: true, footer: true, fontSize: 'large', margins: 'normal' });
  });

  it('resizes tables within 2–6 columns and 1–40 rows, keeping cells', () => {
    const table = newBlock('table', 't') as Extract<ReturnType<typeof newBlock>, { type: 'table' }>;
    const filled = { ...table, rows: [[[{ t: 'text' as const, text: 'A' }], []], [[], []]] };
    const wide = setTableColumns(filled, 9);
    expect(wide.widths).toEqual([1, 2, 1, 1, 1, 1]);
    expect(wide.rows[0]?.[0]).toEqual([{ t: 'text', text: 'A' }]);
    expect(setTableColumns(filled, 1).widths).toHaveLength(2);
    expect(setTableRows(filled, 50).rows).toHaveLength(40);
    expect(setTableRows(filled, 1).rows).toHaveLength(1);
  });

  it('adds and removes list items, keeping at least one', () => {
    const list = newBlock('list', 'l') as Extract<ReturnType<typeof newBlock>, { type: 'list' }>;
    const two = addListItem(list, 0);
    expect(two.items).toHaveLength(2);
    expect(removeListItem(removeListItem(two, 0), 0).items).toHaveLength(1);
  });
});

describe('layout model helpers', () => {
  it('counts typed text only and prints placeholders as [label]', () => {
    const layout: TemplateLayout = {
      ...emptyLayout(),
      blocks: [
        { id: 'a', type: 'paragraph', align: 'start', content: [{ t: 'text', text: 'Né' }, { t: 'var', key: 'employee.fullName' }, { t: 'gender', m: 'é', f: 'ée', x: 'é(e)' }] },
        { id: 'b', type: 'list', ordered: false, items: [[{ t: 'text', text: 'abc' }]] },
      ],
    };
    expect(layoutTextLength(layout)).toBe(2 + 1 + 2 + 4 + 3);
    expect(inlineText([{ t: 'text', text: 'Nom : ' }, { t: 'var', key: 'k' }, { t: 'break' }], () => 'nom')).toBe('Nom : [nom]\n');
  });

  it('finds the block a problem names in a language', () => {
    expect(problemBlockIndex('layouts.ar.blocks.3.content.2', 'ar')).toBe(3);
    expect(problemBlockIndex('layouts.ar.blocks.3', 'fr')).toBeNull();
    expect(problemBlockIndex('fields.0.key', 'fr')).toBeNull();
  });
});

describe('History', () => {
  it('undoes and redoes, and a new change clears the redo stack', () => {
    const history = new History('a');
    history.push('b');
    history.push('c');
    expect(history.undo()).toBe('b');
    expect(history.undo()).toBe('a');
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toBe('b');
    history.push('d');
    expect(history.canRedo).toBe(false);
    expect(history.current).toBe('d');
  });

  it('merges pushes of one group within the delay (typing is one step)', () => {
    let now = 0;
    const history = new History('', HISTORY_LIMIT, 1000, () => now);
    history.push('h', 'text:a');
    now = 500;
    history.push('he', 'text:a');
    now = 900;
    history.push('hel', 'text:a');
    now = 5000;
    history.push('hell', 'text:a');
    expect(history.undo()).toBe('hel');
    expect(history.undo()).toBe('');
  });

  it('keeps at most the limit of steps and starts over on reset', () => {
    const history = new History(0, 3);
    for (let i = 1; i <= 5; i++) history.push(i);
    expect([history.undo(), history.undo(), history.undo(), history.undo()]).toEqual([4, 3, 2, 2]);
    history.reset(9);
    expect(history.canUndo).toBe(false);
    expect(history.current).toBe(9);
  });
});
