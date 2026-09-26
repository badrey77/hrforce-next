/**
 * `<app-history-tabs [subject]="'role:' + role.id" [resolver]="names">…page content…</app-history-tabs>` —
 * wraps a detail view in two tabs, "Details" (the projected content) and "History" (the audit timeline of
 * `subject`), when the user holds `audit.read`. Without the permission, or without a subject (a role being
 * created), it renders the content alone, no tabs. Used by the unit detail panel, the user detail page and the
 * role editor (docs/contracts/audit.md › Web).
 *
 * Angular concepts:
 * - **Content projection (`<ng-content />`).** Whatever the page writes BETWEEN `<app-history-tabs>` and
 *   `</app-history-tabs>` is created by the PAGE (its bindings, its component instances, its form state) and only
 *   INSERTED here, where `<ng-content />` stands. That is how one wrapper serves three different pages.
 *   Projected content is always instantiated, even when hidden — so the Details panel is hidden with `[hidden]`,
 *   never put inside `@if`: Angular's docs advise against a conditional `<ng-content>` (the content exists anyway,
 *   and toggling it only moves DOM around). A pleasant side effect: switching to History and back keeps an unsaved
 *   role form exactly as it was.
 * - **`@defer` — lazy rendering AND lazy code.** The timeline is wrapped in
 *   `@defer (on viewport; prefetch on idle) { … } @placeholder { … } @loading (…) { … } @error { … }`:
 *     - The compiler moves every standalone component, directive and pipe used ONLY inside the `@defer` block
 *       (`Timeline`, and through it the pipes and the fr/ar-DZ locale data) into a SEPARATE JavaScript chunk, fetched
 *       with a dynamic `import()` when the block triggers. For that to work, `Timeline` must not be referenced
 *       anywhere else in this file outside the block (the `imports` array is fine) — otherwise it is eagerly bundled.
 *       `ng build` lists the chunk as a "Lazy chunk file".
 *     - **Triggers** say WHEN to load and render: `on viewport` (the placeholder scrolled into view — here: as soon
 *       as the History tab shows it), `on interaction(ref)`, `on hover(ref)`, `on idle` (the default),
 *       `on immediate`, `on timer(2s)`, or `when <expression>` (becomes truthy once). **`prefetch on …`** separates
 *       downloading the chunk from rendering it: `prefetch on idle` downloads the timeline's code while the browser
 *       has nothing to do, so opening History later is instant.
 *     - **Sub-blocks**: `@placeholder` shows before the trigger (and is the element `on viewport` observes, so it
 *       must be ONE element); `@loading (after 100ms; minimum 300ms)` shows while the chunk downloads — only if it
 *       takes more than 100 ms, and then for at least 300 ms, to avoid a flash; `@error` if the chunk fails to load.
 *     - Once a `@defer` block has loaded, it stays loaded for the life of its view. Here the block sits inside
 *       `@if (tab() === 'history')`, so leaving the tab destroys the timeline and coming back creates a new one: the
 *       history is re-fetched each time it is opened (fresh after an edit), while the code is only downloaded once.
 * - **`linkedSignal()` for the active tab**: back to "details" whenever the subject changes (another unit
 *   selected, another user opened), while the tab buttons can still set it in between.
 * - **Permission**: `Session.allows('audit.read')` — a per-code `computed()` kept in a field (chapter 12). Hiding the
 *   tab is comfort; the API answers 403/404 anyway.
 * - **Tabs ARIA**: `role="tablist"`/`"tab"`/`"tabpanel"`, `aria-selected`, `aria-controls`/`aria-labelledby`;
 *   ids are unique per instance (a counter), because two tab sets could share a page.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import type { AuditSubject } from '../../core/audit/audit.models';
import { Session } from '../../core/auth/session';
import { Timeline } from './timeline';
import { type AuditNameResolver, NO_NAMES } from './timeline-view';

type Tab = 'details' | 'history';

let nextId = 0;

@Component({
  selector: 'app-history-tabs',
  imports: [TranslocoDirective, Timeline],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @if (showTabs()) {
        <div class="tabs" role="tablist" [attr.aria-label]="t('audit.tabs.label')">
          <button
            type="button"
            role="tab"
            data-tab="details"
            [id]="ids.details"
            [attr.aria-selected]="tab() === 'details'"
            [attr.aria-controls]="ids.panel"
            (click)="tab.set('details')"
          >
            {{ t('audit.tabs.details') }}
          </button>
          <button
            type="button"
            role="tab"
            data-tab="history"
            [id]="ids.history"
            [attr.aria-selected]="tab() === 'history'"
            [attr.aria-controls]="ids.panel"
            (click)="tab.set('history')"
          >
            {{ t('audit.tabs.history') }}
          </button>
        </div>
      }
      <div
        [id]="ids.panel"
        [attr.role]="showTabs() ? 'tabpanel' : null"
        [attr.aria-labelledby]="showTabs() ? (tab() === 'details' ? ids.details : ids.history) : null"
      >
        <!-- Always projected, only hidden: see the header. -->
        <div [hidden]="showTabs() && tab() !== 'details'" data-panel="details">
          <ng-content />
        </div>
        @if (showTabs() && tab() === 'history') {
          @if (subject(); as current) {
            <div data-panel="history">
              @defer (on viewport; prefetch on idle) {
                <app-timeline [subject]="current" [resolver]="resolver()" />
              } @placeholder {
                <p class="muted" data-defer="placeholder">{{ t('audit.loading') }}</p>
              } @loading (after 100ms; minimum 300ms) {
                <p class="muted" data-defer="loading">{{ t('audit.loading') }}</p>
              } @error {
                <p class="form-error" role="alert">{{ t('audit.chunkError') }}</p>
              }
            </div>
          }
        }
      </div>
    </ng-container>
  `,
  styles: `
    .tabs {
      display: flex;
      gap: var(--space-2);
      margin-block-end: var(--space-4);
      border-block-end: 1px solid var(--color-border);
    }
    [role='tab'] {
      padding-block: var(--space-2);
      padding-inline: var(--space-3);
      border: 0;
      border-block-end: 3px solid transparent;
      background: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    [role='tab'][aria-selected='true'] { border-block-end-color: var(--color-primary); font-weight: 600; }
    [role='tab']:hover { background: var(--color-hover); }
    .muted { color: var(--color-text-muted); }
  `,
})
export class HistoryTabs {
  private readonly canRead = inject(Session).allows('audit.read');

  /** Audit subject of the page; `null` = nothing to show a history for (e.g. a role being created). */
  readonly subject = input<AuditSubject | null>(null);
  /** Forwarded to the timeline (names for ids the page knows). */
  readonly resolver = input<AuditNameResolver>(NO_NAMES);

  protected readonly showTabs = computed(() => this.canRead() && this.subject() !== null);
  protected readonly tab = linkedSignal<AuditSubject | null, Tab>({ source: this.subject, computation: () => 'details' });

  private readonly uid = `history-tabs-${nextId++}`;
  protected readonly ids = { details: `${this.uid}-details`, history: `${this.uid}-history`, panel: `${this.uid}-panel` };
}
