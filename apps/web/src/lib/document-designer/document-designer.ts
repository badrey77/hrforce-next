/**
 * `<dd-document-designer>` — the document template designer (docs/contracts/document-templates.md › Web › Designer).
 *
 * Self-contained: it knows the layout model, not the app. Inputs: the layout of one language, the template's fields,
 * the placeholder catalogue, the subject, the editing language, read-only; outputs: every layout and fields change,
 * and a preview request. Loading, saving and errors are the host's job.
 *
 * One undo history covers the whole layout (block operations and text typing, merged per block while typing).
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChildren,
  afterNextRender,
  Injector,
} from '@angular/core';
import { FieldsEditor } from './fields-editor';
import { InlineEditor, type MarkName, type PlaceholderOption, type SelectedChip } from './inline-editor';
import { DEFAULT_DESIGNER_LABELS, DESIGNER_LABELS, type DesignerLabels, fill } from './labels';
import {
  addListItem,
  duplicateBlock,
  History,
  insertBlock,
  moveBlock,
  moveBlockTo,
  removeBlock,
  removeListItem,
  setListItem,
  setTableCell,
  setTableColumns,
  setTableRows,
  updateBlock,
  updatePage,
} from './layout-ops';
import {
  type Align,
  type Block,
  BLOCK_TYPES,
  type BlockType,
  type Inline,
  isTextBlock,
  type Lang,
  type LayoutProblem,
  layoutTextLength,
  LIMITS,
  type PageSettings,
  problemBlockIndex,
  type Subject,
  type TemplateField,
  type TemplateLayout,
  type TemplateVariable,
} from './layout.model';

const DRAG_NEW = 'application/x-dd-new-block';
const DRAG_MOVE = 'application/x-dd-move-block';

interface PlaceholderGroup {
  readonly group: string;
  readonly items: readonly (PlaceholderOption & { readonly sample: string | null })[];
}

@Component({
  selector: 'dd-document-designer',
  imports: [InlineEditor, FieldsEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './document-designer.html',
  styleUrls: ['./document-designer.css', './document-designer.canvas.css'],
  host: { class: 'dd-root', '(keydown)': 'onKey($event)' },
})
export class DocumentDesigner {
  readonly layout = input.required<TemplateLayout>();
  readonly fields = input<readonly TemplateField[]>([]);
  readonly variables = input<readonly TemplateVariable[]>([]);
  readonly subject = input<Subject>('employment');
  /** The language of the layout being edited (direction of the canvas). */
  readonly lang = input<Lang>('fr');
  /** The UI language (the designer's own texts). */
  readonly uiLang = input<'fr' | 'ar' | 'en'>('fr');
  readonly labels = input<DesignerLabels | null>(null);
  readonly readonly = input(false);
  /** API problems on this version (`errors[]` of a 422); those of this language highlight their block. */
  readonly problems = input<readonly LayoutProblem[]>([]);

  readonly layoutChange = output<TemplateLayout>();
  readonly fieldsChange = output<TemplateField[]>();
  readonly previewRequested = output<Lang>();

  private readonly injector = inject(Injector);
  private readonly overrides = inject(DESIGNER_LABELS, { optional: true });
  protected readonly texts = computed<DesignerLabels>(() => this.labels() ?? this.overrides?.[this.uiLang()] ?? DEFAULT_DESIGNER_LABELS[this.uiLang()]);
  protected readonly uiDir = computed(() => (this.uiLang() === 'ar' ? 'rtl' : 'ltr'));
  protected readonly docDir = computed(() => (this.lang() === 'ar' ? 'rtl' : 'ltr'));

  private readonly history = new History<TemplateLayout>({ v: 1, page: { letterhead: true, footer: true, fontSize: 'normal', margins: 'normal' }, blocks: [] });
  protected readonly doc = signal<TemplateLayout>(this.history.current);
  protected readonly canUndo = signal(false);
  protected readonly canRedo = signal(false);

  protected readonly selectedId = signal<string | null>(null);
  protected readonly selected = computed(() => this.doc().blocks.find((b) => b.id === this.selectedId()) ?? null);
  protected readonly panel = signal<'placeholders' | 'fields' | 'properties'>('placeholders');
  protected readonly status = signal<string | null>(null);

  /** The editor that had the focus last: placeholders and formatting go there. */
  private activeEditor: InlineEditor | null = null;
  protected readonly hasEditor = signal(false);
  protected readonly activeMarks = signal<ReadonlySet<MarkName>>(new Set());
  protected readonly chip = signal<SelectedChip | null>(null);

  protected readonly search = signal('');
  protected readonly gender = signal({ m: '', f: '', x: '' });
  protected readonly optionalKey = signal('');
  protected readonly dropIndex = signal<number | null>(null);

  protected readonly blockTypes = computed(() => BLOCK_TYPES.filter((type) => type !== 'positions' || this.subject() === 'employment'));
  protected readonly limits = LIMITS;
  protected readonly textLength = computed(() => layoutTextLength(this.doc()));

  private readonly blockEls = viewChildren<ElementRef<HTMLElement>>('blockEl');

  /** Every placeholder (catalogue + `field.<key>`) with its chip label in the editing language. */
  protected readonly placeholderOptions = computed<PlaceholderOption[]>(() => {
    const lang = this.lang();
    return [
      ...this.variables().map((v) => ({ key: v.key, label: v.labels[lang] || v.key })),
      ...this.fields().map((f) => ({ key: `field.${f.key}`, label: f.labels[lang] || f.key })),
    ];
  });

  protected readonly placeholderGroups = computed<PlaceholderGroup[]>(() => {
    const lang = this.lang();
    const query = this.search().trim().toLowerCase();
    const match = (label: string, key: string) => !query || label.toLowerCase().includes(query) || key.toLowerCase().includes(query);
    const groups = new Map<string, (PlaceholderOption & { sample: string | null })[]>();
    for (const v of this.variables()) {
      const label = v.labels[lang] || v.key;
      if (!match(label, v.key)) continue;
      const list = groups.get(v.group) ?? [];
      list.push({ key: v.key, label, sample: v.sample[lang] });
      groups.set(v.group, list);
    }
    const fieldItems = this.fields()
      .map((f) => ({ key: `field.${f.key}`, label: f.labels[lang] || f.key, sample: null }))
      .filter((f) => match(f.label, f.key));
    if (fieldItems.length) groups.set('fields', fieldItems);
    return [...groups.entries()].map(([group, items]) => ({ group, items }));
  });

  private readonly labelByKey = computed(() => new Map(this.placeholderOptions().map((p) => [p.key, p.label])));

  /** Indices of blocks with an API problem in this language. */
  protected readonly problemBlocks = computed(() => {
    const set = new Set<number>();
    for (const p of this.problems()) {
      const index = problemBlockIndex(p.field, this.lang());
      if (index !== null) set.add(index);
    }
    return set;
  });

  constructor() {
    // A layout from outside (load, language switch, conflict reload) starts a new history; our own echo does not.
    effect(() => {
      const incoming = this.layout();
      untracked(() => {
        if (incoming === this.history.current) return;
        this.history.reset(incoming);
        this.doc.set(incoming);
        this.syncHistory();
        if (!incoming.blocks.some((b) => b.id === this.selectedId())) this.selectedId.set(null);
      });
    });
  }

  // --- State --------------------------------------------------------------------------------------------------

  private syncHistory(): void {
    this.canUndo.set(this.history.canUndo);
    this.canRedo.set(this.history.canRedo);
  }

  private commit(next: TemplateLayout, group: string | null = null): void {
    if (this.readonly()) return;
    this.history.push(next, group);
    this.doc.set(next);
    this.syncHistory();
    this.layoutChange.emit(next);
  }

  undo(): void {
    if (this.readonly() || !this.history.canUndo) return;
    const state = this.history.undo();
    this.doc.set(state);
    this.syncHistory();
    this.layoutChange.emit(state);
  }

  redo(): void {
    if (this.readonly() || !this.history.canRedo) return;
    const state = this.history.redo();
    this.doc.set(state);
    this.syncHistory();
    this.layoutChange.emit(state);
  }

  // --- Blocks -------------------------------------------------------------------------------------------------

  protected blockLabel(type: BlockType): string {
    return this.texts().blockType[type] ?? type;
  }

  add(type: BlockType, afterId: string | null = this.selectedId()): void {
    if (this.readonly() || this.doc().blocks.length >= LIMITS.blocks) return;
    const { layout, id } = insertBlock(this.doc(), type, afterId);
    this.commit(layout);
    this.select(id, true);
  }

  protected select(id: string | null, focus = false): void {
    this.selectedId.set(id);
    if (id && this.panel() === 'placeholders' && !this.hasEditor()) this.panel.set('properties');
    if (focus && id) this.focusBlock(id);
  }

  private focusBlock(id: string): void {
    afterNextRender(
      () => {
        const el = this.blockEls().find((ref) => ref.nativeElement.dataset['blockId'] === id)?.nativeElement;
        const editable = el?.querySelector<HTMLElement>('[contenteditable="true"]');
        (editable ?? el)?.focus();
      },
      { injector: this.injector },
    );
  }

  move(id: string, delta: number): void {
    this.commit(moveBlock(this.doc(), id, delta));
    this.focusBlock(id);
  }

  duplicate(id: string): void {
    const { layout, id: copy } = duplicateBlock(this.doc(), id);
    if (copy) {
      this.commit(layout);
      this.select(copy, true);
    }
  }

  remove(id: string): void {
    const { layout, next } = removeBlock(this.doc(), id);
    this.commit(layout);
    this.status.set(this.texts().removed);
    this.selectedId.set(next);
    if (next) this.focusBlock(next);
  }

  protected update(id: string, change: (block: Block) => Block, group: string | null = null): void {
    this.commit(updateBlock(this.doc(), id, change), group);
  }

  protected setContent(id: string, content: Inline[]): void {
    this.update(id, (b) => (isTextBlock(b) ? { ...b, content } : b), `text:${id}`);
  }

  protected setItem(id: string, index: number, content: Inline[]): void {
    this.update(id, (b) => (b.type === 'list' ? setListItem(b, index, content) : b), `item:${id}:${index}`);
  }

  protected addItem(id: string, after: number): void {
    this.update(id, (b) => (b.type === 'list' ? addListItem(b, after) : b));
  }

  protected removeItem(id: string, index: number): void {
    this.update(id, (b) => (b.type === 'list' ? removeListItem(b, index) : b));
  }

  protected setCell(id: string, row: number, col: number, content: Inline[]): void {
    this.update(id, (b) => (b.type === 'table' ? setTableCell(b, row, col, content) : b), `cell:${id}:${row}:${col}`);
  }

  protected setColumns(id: string, count: number): void {
    this.update(id, (b) => (b.type === 'table' ? setTableColumns(b, count) : b));
  }

  protected setRows(id: string, count: number): void {
    this.update(id, (b) => (b.type === 'table' ? setTableRows(b, count) : b));
  }

  protected setWidth(id: string, col: number, width: number): void {
    const w = Math.max(1, Math.min(10, Math.round(width) || 1));
    this.update(id, (b) => (b.type === 'table' ? { ...b, widths: b.widths.map((x, i) => (i === col ? w : x)) } : b));
  }

  protected setAlign(id: string, align: Align): void {
    this.update(id, (b) => {
      if (isTextBlock(b)) return { ...b, align };
      if (b.type === 'signature' && align !== 'justify') return { ...b, align };
      return b;
    });
  }

  protected setWhen(id: string, key: string): void {
    this.update(id, (b) => {
      if (b.type !== 'paragraph') return b;
      const { when: _drop, ...rest } = b;
      return key ? { ...rest, when: key } : rest;
    });
  }

  protected patchBlock(id: string, patch: Readonly<Record<string, unknown>>): void {
    this.update(id, (b) => ({ ...b, ...patch }) as Block);
  }

  protected setPage(patch: Partial<PageSettings>): void {
    this.commit(updatePage(this.doc(), patch));
  }

  protected gridColumns(widths: readonly number[]): string {
    return widths.map((w) => `${w}fr`).join(' ');
  }

  protected labelOf(key: string): string {
    return this.labelByKey().get(key) ?? key;
  }

  protected fillText(text: string, values: Readonly<Record<string, string | number>>): string {
    return fill(text, values);
  }

  // --- Editors, marks, placeholders ---------------------------------------------------------------------------

  protected onEditorFocus(editor: InlineEditor, blockId: string): void {
    this.activeEditor = editor;
    this.hasEditor.set(true);
    this.activeMarks.set(editor.activeMarks());
    this.selectedId.set(blockId);
  }

  protected onChip(chip: SelectedChip | null): void {
    this.chip.set(chip);
    if (this.activeEditor) this.activeMarks.set(this.activeEditor.activeMarks());
    if (chip) this.panel.set('properties');
  }

  protected toggleMark(mark: MarkName): void {
    this.activeEditor?.toggle(mark);
    if (this.activeEditor) this.activeMarks.set(this.activeEditor.activeMarks());
  }

  protected insertVar(key: string): void {
    if (!this.activeEditor) return;
    this.activeEditor.insertVar(key);
  }

  protected insertGender(): void {
    const g = this.gender();
    if (!this.activeEditor || !g.m || !g.f) return;
    this.activeEditor.insertGender(g.m, g.f, g.x || `${g.m}/${g.f}`);
    this.gender.set({ m: '', f: '', x: '' });
  }

  protected insertOptional(): void {
    const key = this.optionalKey();
    if (!this.activeEditor || !key) return;
    this.activeEditor.insertOptional(key);
  }

  protected updateChip(attrs: Readonly<Record<string, unknown>>): void {
    this.activeEditor?.updateChip(attrs);
  }

  protected removeChip(): void {
    this.activeEditor?.removeChip();
    this.chip.set(null);
  }

  protected setGender(part: 'm' | 'f' | 'x', value: string): void {
    this.gender.update((g) => ({ ...g, [part]: value }));
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected numberOf(event: Event): number {
    return Number((event.target as HTMLInputElement).value);
  }

  protected setFields(fields: TemplateField[]): void {
    if (!this.readonly()) this.fieldsChange.emit(fields);
  }

  // --- Keyboard -----------------------------------------------------------------------------------------------

  protected onKey(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    const mod = event.ctrlKey || event.metaKey;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const inEditor = Boolean(target?.closest('.ProseMirror'));
    const inInput = /^(INPUT|SELECT|TEXTAREA)$/.test(target?.tagName ?? '');
    if (mod && !inInput && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && !inInput && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    const id = this.selectedId();
    if (!id || this.readonly() || inInput) return;
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      this.move(id, event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    const onBlock = target?.dataset['blockId'] === id;
    if (!inEditor && onBlock && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      this.remove(id);
    }
  }

  // --- Drag and drop ------------------------------------------------------------------------------------------

  protected dragNew(event: DragEvent, type: BlockType): void {
    event.dataTransfer?.setData(DRAG_NEW, type);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
  }

  protected dragMove(event: DragEvent, id: string): void {
    event.dataTransfer?.setData(DRAG_MOVE, id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected dragOver(event: DragEvent, index: number): void {
    if (this.readonly()) return;
    const types = event.dataTransfer?.types ?? [];
    if (!types.includes(DRAG_NEW) && !types.includes(DRAG_MOVE)) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const box = target.getBoundingClientRect();
    this.dropIndex.set(event.clientY > box.top + box.height / 2 ? index + 1 : index);
  }

  protected drop(event: DragEvent): void {
    const at = this.dropIndex();
    this.dropIndex.set(null);
    if (at === null || this.readonly()) return;
    event.preventDefault();
    const type = event.dataTransfer?.getData(DRAG_NEW) as BlockType | '';
    const moving = event.dataTransfer?.getData(DRAG_MOVE) ?? '';
    if (type && BLOCK_TYPES.includes(type)) {
      const blocks = this.doc().blocks;
      const after = at === 0 ? null : (blocks[at - 1]?.id ?? null);
      if (at === 0 && blocks.length) {
        const { layout, id } = insertBlock(this.doc(), type, null);
        this.commit(moveBlockTo(layout, id, 0));
        this.select(id, true);
      } else {
        this.add(type, after);
      }
    } else if (moving) {
      const from = this.doc().blocks.findIndex((b) => b.id === moving);
      this.commit(moveBlockTo(this.doc(), moving, from < at ? at - 1 : at));
      this.select(moving, true);
    }
  }

  protected dragEnd(): void {
    this.dropIndex.set(null);
  }
}
