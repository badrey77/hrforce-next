/**
 * Header bell (docs/contracts/notifications.md › Web): the unread count, and a dropdown with the latest 10
 * notifications — click one to mark it read and go to its page — plus "mark all read" and "see all".
 * All data comes from the root `NotificationCenter` (core/notifications/notification-center.ts), live over SSE.
 *
 * Angular concepts:
 * - **Reading a root signal store**: `center.unreadCount()` / `center.latest()` in the template make this OnPush
 *   component re-render when an SSE event sets them — nothing else to wire (zoneless: the signal read is the
 *   subscription).
 * - **Disclosure, not `popover` (yet).** The native `popover` attribute gives top-layer rendering and light-dismiss
 *   (Escape, click outside) for free, and would be the first choice for a menu floating over everything. But placing
 *   it UNDER the bell needs CSS anchor positioning (`anchor-name` / `position-anchor`), which is not yet in every
 *   browser our users have, and jsdom (our test DOM) implements neither. A disclosure — a button with
 *   `aria-expanded` + `aria-controls` that shows a panel rendered by `@if` — is fully supported, keyboard-accessible by
 *   default (it is just a button and links), and its placement is ordinary CSS: `position: absolute;
 *   inset-inline-end: 0` hangs the panel from the bell's END edge, which is the right edge in French and the LEFT edge
 *   in Arabic without a single RTL rule. We add the two behaviours `popover` would have given: Escape closes and
 *   returns focus to the bell; a click or focus outside closes.
 * - **Host listeners in `host: {}`** — `'(document:click)'` listens on the document for as long as the component
 *   lives (Angular removes the listener on destroy); `(keydown.escape)` is a key-filtered event binding (Angular
 *   only calls the handler for that key).
 * - **Signal view queries + `afterRenderEffect()` for focus**: to give focus back to the bell after closing, we read
 *   the button through `viewChild.required()` (it is always rendered, so focusing it right away works). Opening moves
 *   focus INTO the panel (its heading). That element does not exist yet when `toggle()` runs — it appears after a
 *   render, and the FIRST time only after the @defer'red chunk has loaded, which may be several renders later. So
 *   `afterNextRender` (exactly one render) is not enough; an `afterRenderEffect()` that reads the `panelTitle` query
 *   re-runs when the query starts returning the element, after that render, and focuses it once.
 * - **`inject(ElementRef)`** gives this component's host element, to tell "a click inside me" from "outside".
 * - **`[routerLink]` with a `UrlTree`.** A notification's `link` is a path WITH a query string (`/tasks?task=…`). A
 *   string given to `routerLink` is treated as path segments (the `?` would be encoded into the path), so each link
 *   is parsed once with `Router.parseUrl()` into a `UrlTree` — which `routerLink` accepts as-is — inside a
 *   `computed()`, not in the template (a new tree on every check would re-set the link each time). `safeAppLink()`
 *   first rejects anything that is not an in-app path.
 * - **Accessible count**: the number in the badge is `aria-hidden`; the button's name says it ("Notifications, 3 non
 *   lue(s)"), and an always-present `aria-live="polite"` region announces changes (same pattern as the tasks badge).
 * - **`@defer (when open(); prefetch on idle)` around the panel**: the panel's code (the sentence component, the
 *   relative-time pipe and the fr/ar-DZ locale data they need) is not in the main bundle. `prefetch on idle`
 *   downloads it once the browser has nothing to do; `when open()` renders the block the first time the dropdown
 *   opens (a `when` trigger fires once and the block then stays), and the `@if (open())` inside shows or hides the
 *   panel from then on. The `@defer` must sit OUTSIDE the `@if`: a defer block inside it would not exist before the
 *   first opening, so it could not prefetch anything (the compiler warns: NG8021).
 */
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { NotificationCenter, safeAppLink } from '../core/notifications/notification-center';
import type { NotificationView } from '../core/notifications/notifications.models';
import { NotificationText } from '../shared/notifications/notification-text';

@Component({
  selector: 'app-notification-bell',
  imports: [TranslocoDirective, RouterLink, NotificationText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(keydown.escape)': 'close(true)',
    '(focusout)': 'onFocusOut($event)',
  },
  template: `
    <ng-container *transloco="let t">
      <div class="bell">
        <button
          #bellButton
          type="button"
          class="bell-button"
          data-action="bell"
          aria-controls="notifications-panel"
          [attr.aria-expanded]="open()"
          [attr.aria-label]="count() ? t('notifications.bell.labelWithCount', { count: count() }) : t('notifications.bell.label')"
          (click)="toggle()"
        >
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="22" height="22">
            <path
              fill="currentColor"
              d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"
            />
          </svg>
          @if (count()) {
            <span class="count" aria-hidden="true" data-badge="notifications">{{ count() > 99 ? '99+' : count() }}</span>
          }
        </button>
        <!-- Announces changes politely; always rendered so assistive tech is already watching it. -->
        <p class="visually-hidden" aria-live="polite" data-live="notifications">
          {{ center.unreadKnown() ? t('notifications.bell.live', { count: count() }) : '' }}
        </p>

        @defer (when open(); prefetch on idle) {
          @if (open()) {
            <div id="notifications-panel" class="panel" role="region" [attr.aria-labelledby]="'notifications-panel-title'">
              <div class="panel-head">
                <h2 id="notifications-panel-title" #panelTitle tabindex="-1">{{ t('notifications.bell.panel') }}</h2>
                <button type="button" class="link-button" data-action="mark-all" [disabled]="!count()" (click)="markAll()">
                  {{ t('notifications.markAllRead') }}
                </button>
              </div>
              @if (center.status() === 'fallback') {
                <p class="muted small" data-state="fallback">{{ t('notifications.offline') }}</p>
              }
              <ul class="items">
                @for (row of rows(); track row.item.id) {
                  <li>
                    <a
                      [routerLink]="row.tree"
                      [class.unread]="!row.item.readAt"
                      [attr.data-notification]="row.item.id"
                      (click)="activate(row.item)"
                    >
                      <app-notification-text [notification]="row.item" [now]="now()" />
                      @if (!row.item.readAt) {
                        <span class="visually-hidden">({{ t('notifications.unread') }})</span>
                      }
                    </a>
                  </li>
                } @empty {
                  <li class="muted" data-state="empty">{{ t('notifications.empty') }}</li>
                }
              </ul>
              <p class="panel-foot">
                <a routerLink="/notifications" data-action="see-all" (click)="close(false)">{{ t('notifications.seeAll') }}</a>
              </p>
            </div>
          }
        } @loading (after 150ms) {
          <p class="panel muted" role="status">{{ t('notifications.loading') }}</p>
        }
      </div>
    </ng-container>
  `,
  styles: `
    .bell {
      position: relative;
    }
    .bell-button {
      position: relative;
      display: inline-flex;
      align-items: center;
      padding: var(--space-1);
      border: 1px solid transparent;
      border-radius: var(--radius);
      background: none;
      color: inherit;
      cursor: pointer;
    }
    .bell-button:hover,
    .bell-button[aria-expanded='true'] {
      border-color: currentColor;
    }
    .count {
      position: absolute;
      inset-block-start: -0.35rem;
      inset-inline-end: -0.5rem;
      min-inline-size: 1.25rem;
      padding-inline: var(--space-1);
      border-radius: 999px;
      background: var(--color-danger);
      color: #fff;
      font-size: 0.6875rem;
      font-weight: 700;
      line-height: 1.25rem;
      text-align: center;
    }
    /* Hangs from the bell's END edge: the right in LTR, the left in RTL — no direction-specific rule. */
    .panel {
      position: absolute;
      inset-block-start: calc(100% + var(--space-2));
      inset-inline-end: 0;
      z-index: 20;
      inline-size: min(24rem, calc(100vw - 2 * var(--space-4)));
      max-block-size: 70vh;
      overflow-y: auto;
      padding: var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: var(--radius);
      background: var(--color-surface);
      color: var(--color-text);
      box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
    }
    .panel-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--space-2);
      margin-block-end: var(--space-2);
    }
    .panel-head h2 {
      margin: 0;
      font-size: 1rem;
    }
    .panel-head h2:focus {
      outline: none;
    }
    .link-button {
      padding: 0;
      border: 0;
      background: none;
      color: var(--color-primary);
      font: inherit;
      font-size: 0.875rem;
      text-decoration: underline;
      cursor: pointer;
    }
    .link-button:disabled {
      color: var(--color-text-muted);
      text-decoration: none;
      cursor: default;
    }
    .items {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .items a {
      display: block;
      padding-block: var(--space-2);
      padding-inline: var(--space-2);
      border-inline-start: 3px solid transparent;
      color: inherit;
      text-decoration: none;
    }
    .items a:hover {
      background: var(--color-hover);
    }
    .items a.unread {
      border-inline-start-color: var(--color-primary);
      background: var(--color-surface-alt);
      font-weight: 600;
    }
    .items li + li {
      border-block-start: 1px solid var(--color-border);
    }
    .panel-foot {
      margin-block: var(--space-2) 0;
      text-align: end;
    }
    .muted {
      color: var(--color-text-muted);
    }
    .small {
      font-size: 0.8125rem;
    }
  `,
})
export class NotificationBell {
  protected readonly center = inject(NotificationCenter);
  private readonly router = inject(Router);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  protected readonly open = signal(false);
  protected readonly count = this.center.unreadCount;
  /** "Now" for relative times: refreshed each time the dropdown opens (see relative-time.pipe.ts). */
  protected readonly now = signal(Date.now());
  /** Each notification with its link parsed once into a UrlTree (see header). */
  protected readonly rows = computed(() =>
    this.center.latest().map((item) => ({ item, tree: this.router.parseUrl(safeAppLink(item.link)) })),
  );

  private readonly bellButton = viewChild.required<ElementRef<HTMLButtonElement>>('bellButton');
  private readonly panelTitle = viewChild<ElementRef<HTMLElement>>('panelTitle');
  /** Set on open; consumed by the render effect once the panel heading exists. */
  private focusPanel = false;

  constructor() {
    // Opening moves focus into the panel. The heading appears after a render — and, the first time, only once the
    // @defer'red chunk has loaded — so this waits for the `panelTitle` query to return it (see header).
    afterRenderEffect(() => {
      const title = this.panelTitle();
      if (title && this.focusPanel) {
        this.focusPanel = false;
        title.nativeElement.focus();
      }
    });
  }

  protected toggle(): void {
    if (this.open()) {
      this.close(true);
      return;
    }
    this.now.set(Date.now());
    this.focusPanel = true;
    this.open.set(true);
  }

  /** Close; `restoreFocus` puts the focus back on the bell (Escape, toggle), not when the user moved elsewhere. */
  protected close(restoreFocus: boolean): void {
    if (!this.open()) return;
    this.open.set(false);
    if (restoreFocus) this.bellButton().nativeElement.focus();
  }

  /** Clicking a notification: mark it read (optimistic), close; `routerLink` does the navigation. */
  protected activate(item: NotificationView): void {
    this.center.markRead(item);
    this.close(false);
  }

  protected markAll(): void {
    this.center.markAllRead();
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (this.open() && event.target instanceof Node && !this.host.nativeElement.contains(event.target)) this.close(false);
  }

  protected onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (this.open() && next instanceof Node && !this.host.nativeElement.contains(next)) this.close(false);
  }
}
