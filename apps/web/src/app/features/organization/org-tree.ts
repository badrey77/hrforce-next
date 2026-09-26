/**
 * The collapsible org tree: `<app-org-tree [root]="…" [(selectedId)]="…" />`.
 *
 * Angular concepts:
 * - **Recursive component.** `OrgTreeItem` renders one node and, for its children, `<app-org-tree-item>` again —
 *   a standalone component may use its own selector in its template without importing itself. We chose this
 *   over `<ng-template>` + `ngTemplateOutlet` recursion because template-outlet contexts are untyped
 *   (`let-node` would be `any` under strictTemplates); a component input is fully type-checked.
 * - **Hierarchical DI: injecting an ancestor component.** Every component instance is itself available for
 *   injection to the components *inside* its template. So each `OrgTreeItem`, however deep, can
 *   `inject(OrgTree)` and share the tree-wide state (selection, collapsed nodes) — no need to pass inputs down
 *   and re-emit outputs up through every level. Both classes live in this file: they reference each other,
 *   and two files importing each other would be a circular dependency (forbidden by the boundaries guard).
 * - **`model()`** declares a *two-way* bindable signal: the parent writes it with `[selectedId]` and listens with
 *   `(selectedIdChange)`, or both at once with the "banana in a box" syntax `[(selectedId)]="signal"`.
 *   Calling `this.selectedId.set(id)` inside updates the parent's signal.
 * - **`input.required<T>()`**: the template must bind it; reading it before binding throws.
 * - **Data labels vs i18n labels**: the kind badge is `kindCatalog.labelOf(kind)` — a label that comes from the API
 *   (the kind catalogue) in the active language — while fixed UI texts still come from `t()`.
 *
 * - **Context nodes** (`inScope: false`, docs/contracts/authorization.md › Scope rules): ancestors the API sends only
 *   so the user sees WHERE their units sit. The row is muted and its button `[disabled]` — a disabled button cannot
 *   be clicked or focused, so nothing can select it for edits (its detail would be a 404 anyway). A visually hidden
 *   text tells screen-reader users why. `[disabled]` is a PROPERTY binding: Angular sets `button.disabled = true`,
 *   and with `false` it removes the attribute (unlike `[attr.disabled]="false"`, which would set `disabled="false"`,
 *   still disabled in HTML).
 *
 * Children are shown in the order the API sends them (kind sortOrder, then code): no sorting here.
 * The effective site is shown on a row only where it differs from the parent's, so a service hosted at its
 * agency's site does not repeat it.
 *
 * Accessibility: nested lists of buttons (a disclosure button with `aria-expanded` per parent, a select button with
 * `aria-current` per node). Every row is reachable with Tab and activated with Enter/Space. This is simpler than the
 * full ARIA `tree` pattern (roving tabindex, arrow keys) and fully usable; upgrade later if needed.
 * RTL: indentation uses `padding-inline-start`; the chevron points toward inline-end and is mirrored under `:dir(rtl)`.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, model, signal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { KindCatalog } from '../../core/org/kind-catalog';
import type { OrgTreeNode } from '../../core/org/org.models';

@Component({
  selector: 'app-org-tree-item',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <!-- @let declares a template-local variable: read the input signal once, use it below. -->
      @let item = node();
      <div class="row" [class.selected]="selected()">
        @if (item.children.length) {
          <button
            type="button"
            class="toggle"
            [attr.aria-expanded]="expanded()"
            [attr.aria-label]="t('org.tree.toggle', { name: item.name })"
            (click)="tree.toggle(item.id)"
          >
            <svg class="chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" />
            </svg>
          </button>
        } @else {
          <span class="toggle" aria-hidden="true"></span>
        }
        <button
          type="button"
          class="node"
          [class.context]="!inScope()"
          [disabled]="!inScope()"
          [attr.title]="inScope() ? null : t('org.tree.contextHint')"
          [attr.aria-current]="selected() ? 'true' : null"
          (click)="tree.select(item.id)"
        >
          <!-- Angular drops whitespace-only text between tags; &ngsp; keeps a real space so the button's
               accessible name reads "Région CENTRE Région Centre", not "RégionCENTRERégion Centre". -->
          <span class="badge">{{ kindCatalog.labelOf(item.kind) }}</span>&ngsp;<span class="code">{{ item.code }}</span>&ngsp;<span>{{ item.name }}</span>
          @if (ownSite(); as site) {
            &ngsp;<span class="site" [attr.title]="t('org.detail.site')">{{ site.name }}</span>
          }
          @if (!inScope()) {
            <span class="visually-hidden">{{ t('org.tree.contextHint') }}</span>
          }
        </button>
      </div>
      @if (item.children.length && expanded()) {
        <ul>
          @for (child of item.children; track child.id) {
            <li><app-org-tree-item [node]="child" [parentSiteId]="item.site?.id ?? null" /></li>
          }
        </ul>
      }
    </ng-container>
  `,
  styles: `
    :host { display: block; }
    ul { list-style: none; margin: 0; padding: 0; padding-inline-start: var(--space-6); }
    .row { display: flex; align-items: center; gap: var(--space-1); border-radius: var(--radius); }
    .row.selected { background: var(--color-hover); }
    .toggle {
      display: inline-grid; place-items: center; inline-size: 1.75rem; block-size: 1.75rem; flex-shrink: 0;
      padding: 0; border: 0; background: none; color: inherit; cursor: pointer;
    }
    .chevron { transition: transform 0.15s; }
    [aria-expanded='true'] .chevron { transform: rotate(90deg); }
    .chevron:dir(rtl) { transform: scaleX(-1); }
    [aria-expanded='true'] .chevron:dir(rtl) { transform: scaleX(-1) rotate(90deg); }
    .node {
      display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2); flex: 1; min-inline-size: 0;
      padding-block: var(--space-1); padding-inline: var(--space-2);
      border: 0; background: none; color: inherit; text-align: start; cursor: pointer; border-radius: var(--radius);
    }
    .node:hover:not(:disabled) { text-decoration: underline; }
    .node.context { color: var(--color-text-muted); cursor: default; font-style: italic; }
    .node[aria-current='true'] { font-weight: 600; }
    .code { font-family: ui-monospace, monospace; font-size: 0.875rem; white-space: nowrap; } /* keep "DEP-FIN" on one line: the browser may otherwise break at the hyphen */
    .site { color: var(--color-text-muted); font-size: 0.8125rem; }
  `,
})
export class OrgTreeItem {
  /** Resolved from the nearest ancestor `<app-org-tree>` (see header: hierarchical DI). */
  protected readonly tree = inject(OrgTree);
  protected readonly kindCatalog = inject(KindCatalog);
  readonly node = input.required<OrgTreeNode>();
  /** Effective site of the parent row (`null` for the root or an unsited parent). */
  readonly parentSiteId = input<string | null>(null);

  /** The site to show on this row: the effective site, unless it is the same as the parent's. */
  protected readonly ownSite = computed(() => {
    const site = this.node().site;
    return site && site.id !== this.parentSiteId() ? site : null;
  });
  protected readonly expanded = computed(() => !this.tree.isCollapsed(this.node().id));
  protected readonly selected = computed(() => this.tree.selectedId() === this.node().id);
  /** `false` only for a context ancestor; a missing flag (older API) counts as in scope. */
  protected readonly inScope = computed(() => this.node().inScope !== false);
}

@Component({
  selector: 'app-org-tree',
  imports: [OrgTreeItem, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul *transloco="let t" class="root" [attr.aria-label]="t('org.tree.label')">
      <li><app-org-tree-item [node]="root()" /></li>
    </ul>
  `,
  styles: `
    .root { list-style: none; margin: 0; padding: 0; }
  `,
})
export class OrgTree {
  readonly root = input.required<OrgTreeNode>();
  /** Two-way bindable: `[(selectedId)]`. */
  readonly selectedId = model<string | null>(null);

  /** Collapsed rather than expanded ids: new nodes (e.g. just created) show up expanded. */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());

  isCollapsed(id: string): boolean {
    return this.collapsed().has(id);
  }

  toggle(id: string): void {
    // Signals compare by reference: build a NEW Set so dependents see a change.
    this.collapsed.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  select(id: string): void {
    this.selectedId.set(id);
  }
}
