/**
 * `<dd-inline-editor>` — edits one run of inlines with ProseMirror: text with bold / italic / underline, and
 * placeholders as non-editable chips. Typing `[` opens the placeholder list (↑/↓, Entrée or Tab to insert, Échap to
 * close). The content is an input; every change is emitted as `Inline[]`. Undo/redo keys are forwarded to the
 * designer, which keeps one history for the whole layout.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  effect,
  input,
  type OnDestroy,
  output,
  signal,
  untracked,
  viewChild,
  afterNextRender,
  ViewEncapsulation,
} from '@angular/core';
import { toggleMark, baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import type { Node as PmNode } from 'prosemirror-model';
import { EditorState, NodeSelection, type Transaction } from 'prosemirror-state';
import { EditorView, type NodeView } from 'prosemirror-view';
import { docToInlines, inlinesToDoc, MARK, NODE } from './inline-schema';
import { type Inline, inlineText } from './layout.model';

export type MarkName = 'bold' | 'italic' | 'underline';

/** The chip the selection is on, for the properties panel. */
export type SelectedChip =
  | { readonly kind: 'var'; readonly key: string }
  | { readonly kind: 'gender'; readonly m: string; readonly f: string; readonly x: string }
  | { readonly kind: 'optional'; readonly key: string; readonly content: readonly Inline[] };

/** A placeholder offered by the `[` list. */
export interface PlaceholderOption {
  readonly key: string;
  readonly label: string;
}

const SUGGEST_MAX_QUERY = 30;

const markCommand = (name: MarkName) => toggleMark(MARK[name]);

function lineBreak(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  dispatch?.(state.tr.replaceSelectionWith(NODE.hardBreak.create()).scrollIntoView());
  return true;
}

function chip(text: string, cls: string): HTMLElement {
  const span = document.createElement('span');
  span.className = `dd-chip ${cls}`;
  span.setAttribute('contenteditable', 'false');
  span.textContent = text;
  return span;
}
const SUGGEST_MAX_ITEMS = 8;

/** Lower-case without accents (Latin) and without Arabic short vowels, for matching. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ًͯ-ٟ]/g, '')
    .toLowerCase();
}

/**
 * The open `[` query before position `pos` in `textBefore` (the text of the block up to the caret; chips are
 * U+FFFC), or null: a `[` not closed by `]`, at most 30 characters back, without a chip or a line break after it.
 */
export function bracketQuery(textBefore: string): { query: string; back: number } | null {
  const at = textBefore.lastIndexOf('[');
  if (at < 0) return null;
  const query = textBefore.slice(at + 1);
  if (query.length > SUGGEST_MAX_QUERY || /[\]\n￼]/.test(query)) return null;
  return { query, back: query.length + 1 };
}

export function filterPlaceholders(options: readonly PlaceholderOption[], query: string): PlaceholderOption[] {
  const q = fold(query.trim());
  const scored = options
    .map((option) => {
      const label = fold(option.label);
      const key = option.key.toLowerCase();
      const rank = !q ? 1 : label.startsWith(q) ? 0 : label.includes(q) || key.includes(q) ? 1 : -1;
      return { option, rank };
    })
    .filter((x) => x.rank >= 0);
  return scored.toSorted((a, b) => a.rank - b.rank).map((x) => x.option);
}

@Component({
  selector: 'dd-inline-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // ProseMirror creates the editable DOM itself (no Angular style scoping): the rules are prefixed instead.
  encapsulation: ViewEncapsulation.None,
  styleUrl: './inline-editor.css',
  host: { class: 'dd-inline-editor' },
  template: `
    <div #host class="dd-editable" [attr.dir]="dir()" [attr.lang]="lang()" [class.dd-empty]="empty()" [attr.data-placeholder]="hint()"></div>
    @if (suggest(); as s) {
      <ul class="dd-suggest" role="listbox" [attr.aria-label]="listLabel()" [style.inset-block-start.px]="s.top" [style.inset-inline-start.px]="s.left"
        [attr.dir]="dir()" data-suggest>
        @for (item of s.items; track item.key; let i = $index) {
          <li role="option" [attr.aria-selected]="i === s.active" [class.active]="i === s.active" [attr.data-key]="item.key"
            (mousedown)="$event.preventDefault(); pick(item)">{{ item.label }}</li>
        } @empty {
          <li class="dd-muted" role="option" aria-disabled="true">{{ emptyLabel() }}</li>
        }
      </ul>
    }
  `,
})
export class InlineEditor implements OnDestroy {
  readonly content = input.required<readonly Inline[]>();
  readonly dir = input<'ltr' | 'rtl'>('ltr');
  readonly lang = input<string>('fr');
  readonly readonly = input(false);
  readonly placeholders = input<readonly PlaceholderOption[]>([]);
  /** Shown while empty (e.g. « Tapez [ pour insérer un champ »). */
  readonly hint = input('');
  readonly ariaLabel = input('');
  readonly listLabel = input('');
  readonly emptyLabel = input('');
  /** A title or a table cell: single line-ish; Enter still inserts a line break. */
  readonly multiline = input(true);

  readonly contentChange = output<Inline[]>();
  readonly focused = output<InlineEditor>();
  readonly chipChange = output<SelectedChip | null>();
  readonly undoRequested = output<void>();
  readonly redoRequested = output<void>();

  private readonly hostRef = viewChild.required<ElementRef<HTMLElement>>('host');
  private view: EditorView | null = null;
  /** JSON of the last content emitted or loaded: an input equal to it is our own echo. */
  private known = '';
  private dismissedAt = -1;

  protected readonly empty = signal(true);
  readonly activeMarks = signal<ReadonlySet<MarkName>>(new Set());
  protected readonly suggest = signal<{ items: PlaceholderOption[]; active: number; top: number; left: number; from: number } | null>(null);

  private readonly labelByKey = computed(() => new Map(this.placeholders().map((p) => [p.key, p.label])));

  constructor() {
    afterNextRender(() => this.mount());
    effect(() => {
      const content = this.content();
      const json = JSON.stringify(content);
      if (!this.view || json === this.known) return;
      this.known = json;
      untracked(() => this.load(content));
    });
    effect(() => {
      // re-draw the chips when their labels change (language switch)
      this.labelByKey();
      if (this.view) untracked(() => this.load(this.current()));
    });
    effect(() => {
      const editable = !this.readonly();
      this.view?.setProps({ editable: () => editable });
    });
  }

  ngOnDestroy(): void {
    this.view?.destroy();
    this.view = null;
  }

  private plugins() {
    return [
      keymap({
        'Mod-b': markCommand('bold'),
        'Mod-i': markCommand('italic'),
        'Mod-u': markCommand('underline'),
        'Mod-z': () => {
          this.undoRequested.emit();
          return true;
        },
        'Mod-Shift-z': () => {
          this.redoRequested.emit();
          return true;
        },
        'Mod-y': () => {
          this.redoRequested.emit();
          return true;
        },
        Enter: lineBreak,
        'Shift-Enter': lineBreak,
      }),
      keymap(baseKeymap),
    ];
  }

  private nodeViews(): Record<string, (node: PmNode) => NodeView> {
    return {
      var: (node) => {
        const key = node.attrs['key'] as string;
        const dom = chip(`[${this.labelByKey().get(key) ?? key}]`, '');
        dom.dataset['var'] = key;
        for (const m of node.marks) dom.classList.add(`dd-${m.type.name}`);
        return { dom };
      },
      gender: (node) => ({ dom: chip(`${node.attrs['m'] as string}/${node.attrs['f'] as string}`, 'dd-gender') }),
      optional: (node) => {
        const key = node.attrs['key'] as string;
        const text = inlineText(node.attrs['content'] as Inline[], (k) => this.labelByKey().get(k) ?? k);
        return { dom: chip(`[? ${this.labelByKey().get(key) ?? key}] ${text.length > 30 ? `${text.slice(0, 30)}…` : text}`, 'dd-optional') };
      },
    };
  }

  private mount(): void {
    const content = this.content();
    this.known = JSON.stringify(content);
    this.view = new EditorView(this.hostRef().nativeElement, {
      state: EditorState.create({ doc: inlinesToDoc(content), plugins: this.plugins() }),
      nodeViews: this.nodeViews(),
      editable: () => !this.readonly(),
      attributes: { role: 'textbox', 'aria-multiline': String(this.multiline()), 'aria-label': this.ariaLabel(), spellcheck: 'true' },
      dispatchTransaction: (tr) => this.apply(tr),
      handleDOMEvents: {
        focus: () => {
          this.focused.emit(this);
          // an open `[` query is offered again when the focus comes back
          queueMicrotask(() => this.view && this.updateSuggest(this.view.state));
          return false;
        },
        blur: () => {
          this.suggest.set(null);
          return false;
        },
      },
      handleKeyDown: (_view, event) => this.suggestKey(event),
    });
    this.empty.set(this.view.state.doc.content.size === 0);
  }

  private load(content: readonly Inline[]): void {
    if (!this.view) return;
    this.view.setProps({ nodeViews: this.nodeViews() });
    this.view.updateState(EditorState.create({ doc: inlinesToDoc(content), plugins: this.plugins() }));
    this.empty.set(this.view.state.doc.content.size === 0);
    this.suggest.set(null);
  }

  private apply(tr: Transaction): void {
    const view = this.view;
    if (!view) return;
    const state = view.state.apply(tr);
    view.updateState(state);
    this.empty.set(state.doc.content.size === 0);
    this.activeMarks.set(this.marksAt(state));
    if (tr.docChanged) {
      const inlines = docToInlines(state.doc);
      this.known = JSON.stringify(inlines);
      this.contentChange.emit(inlines);
    }
    if (tr.selectionSet || tr.docChanged) this.chipChange.emit(this.selectedChip(state));
    this.updateSuggest(state);
  }

  private marksAt(state: EditorState): Set<MarkName> {
    const marks = state.storedMarks ?? state.selection.$from.marks();
    return new Set(marks.map((m) => m.type.name as MarkName));
  }

  private selectedChip(state: EditorState): SelectedChip | null {
    const sel = state.selection;
    if (!(sel instanceof NodeSelection)) return null;
    const node = sel.node;
    switch (node.type.name) {
      case 'var':
        return { kind: 'var', key: node.attrs['key'] as string };
      case 'gender':
        return { kind: 'gender', m: node.attrs['m'] as string, f: node.attrs['f'] as string, x: node.attrs['x'] as string };
      case 'optional':
        return { kind: 'optional', key: node.attrs['key'] as string, content: node.attrs['content'] as Inline[] };
      default:
        return null;
    }
  }

  // --- `[` suggestions -----------------------------------------------------------------------------------------

  private updateSuggest(state: EditorState): void {
    const view = this.view;
    const sel = state.selection;
    if (!view || !sel.empty || !view.hasFocus()) {
      this.suggest.set(null);
      return;
    }
    const before = state.doc.textBetween(0, sel.from, '\n', '￼');
    const found = bracketQuery(before);
    const from = found ? sel.from - found.back : -1;
    if (!found || from === this.dismissedAt) {
      this.suggest.set(null);
      return;
    }
    const items = filterPlaceholders(this.placeholders(), found.query).slice(0, SUGGEST_MAX_ITEMS);
    let top = 0;
    let left = 0;
    try {
      const coords = view.coordsAtPos(from);
      const box = this.hostRef().nativeElement.getBoundingClientRect();
      top = coords.bottom - box.top + 4;
      left = this.dir() === 'rtl' ? box.right - coords.right : coords.left - box.left;
    } catch {
      // no layout (tests): keep 0, 0
    }
    const previous = this.suggest();
    const active = previous && previous.from === from ? Math.min(previous.active, Math.max(0, items.length - 1)) : 0;
    this.suggest.set({ items, active, top, left, from });
  }

  private suggestKey(event: KeyboardEvent): boolean {
    const s = this.suggest();
    if (!s) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const n = s.items.length;
      if (n) this.suggest.set({ ...s, active: (s.active + (event.key === 'ArrowDown' ? 1 : n - 1)) % n });
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const item = s.items[s.active];
      if (!item) return false;
      this.pick(item);
      return true;
    }
    if (event.key === 'Escape') {
      this.dismissedAt = s.from;
      this.suggest.set(null);
      return true;
    }
    return false;
  }

  protected pick(item: PlaceholderOption): void {
    const view = this.view;
    const s = this.suggest();
    if (!view || !s) return;
    const node = NODE.var.create({ key: item.key });
    const tr = view.state.tr.replaceWith(s.from, view.state.selection.from, node);
    this.suggest.set(null);
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }

  // --- Commands for the designer's toolbar and panels ----------------------------------------------------------

  /** The current content (what was last emitted or loaded). */
  current(): Inline[] {
    return this.view ? docToInlines(this.view.state.doc) : [...this.content()];
  }

  focus(): void {
    this.view?.focus();
  }

  toggle(mark: MarkName): void {
    const view = this.view;
    if (!view || this.readonly()) return;
    toggleMark(MARK[mark])(view.state, view.dispatch);
    view.focus();
  }

  private insertNode(node: PmNode): void {
    const view = this.view;
    if (!view || this.readonly()) return;
    view.dispatch(view.state.tr.replaceSelectionWith(node, true).scrollIntoView());
    view.focus();
  }

  insertVar(key: string): void {
    this.insertNode(NODE.var.create({ key }));
  }

  insertGender(m: string, f: string, x: string): void {
    this.insertNode(NODE.gender.create({ m, f, x }));
  }

  insertOptional(key: string, content: readonly Inline[] = []): void {
    this.insertNode(NODE.optional.create({ key, content: structuredClone(content) }));
  }

  /** Changes the attributes of the selected chip (gender forms, optional key/content, variable key). */
  updateChip(attrs: Readonly<Record<string, unknown>>): void {
    const view = this.view;
    const sel = view?.state.selection;
    if (!view || !(sel instanceof NodeSelection) || this.readonly()) return;
    const tr = view.state.tr.setNodeMarkup(sel.from, undefined, { ...sel.node.attrs, ...attrs });
    tr.setSelection(NodeSelection.create(tr.doc, sel.from));
    view.dispatch(tr);
  }

  removeChip(): void {
    const view = this.view;
    const sel = view?.state.selection;
    if (!view || !(sel instanceof NodeSelection) || this.readonly()) return;
    view.dispatch(view.state.tr.deleteSelection());
    view.focus();
  }
}
