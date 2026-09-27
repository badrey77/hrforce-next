/**
 * /notifications — every notification of the signed-in user (docs/contracts/notifications.md › Web): newest first,
 * an "unread only" filter, "load more" with the cursor, mark one / all as read, click to open.
 *
 * Angular concepts:
 * - **The timeline's cursor pattern, reused** (shared/timeline/timeline.ts explains it in full):
 *   `cursor` = a `linkedSignal` reset to `null` when the FILTER changes; `page` = an `httpResource` keyed on
 *   `{unreadOnly, cursor}`; `pages` = a `linkedSignal` that appends each new page to its own previous value and
 *   starts over when the filter changes. Toggling "unread only" therefore resets the list by itself.
 * - **Local "read" overlay, like the task badge's optimistic `hidden` set.** Marking an item read must not refetch
 *   every loaded page. The pages stay as the server sent them; a `readIds` signal (plus an `allReadAt` timestamp for
 *   "mark all") says what was marked here, and `rows` is a `computed()` of both. The unread COUNT lives in the root
 *   `NotificationCenter` (the bell shows it), so marking goes through the center, which updates it optimistically.
 * - **`[routerLink]` with a `UrlTree`** for links with a query string (see shell/notification-bell.ts).
 * - **Checkbox as a plain `(change)` binding into a signal**: one boolean that is not part of any form — a reactive
 *   form would add nothing. `$any()` is avoided by reading `event.target` through a typed helper.
 */
import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { NotificationCenter, safeAppLink } from '../../core/notifications/notification-center';
import { NotificationsApi } from '../../core/notifications/notifications-api';
import {
  NOTIFICATIONS_PAGE_SIZE,
  type NotificationPage,
  type NotificationView,
} from '../../core/notifications/notifications.models';
import { NotificationText } from '../../shared/notifications/notification-text';

interface PageSource {
  readonly unreadOnly: boolean;
  readonly page: NotificationPage | undefined;
}

@Component({
  selector: 'app-notifications-page',
  imports: [TranslocoDirective, RouterLink, NotificationText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './notifications.page.html',
  styles: `
    .items { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
    .item {
      display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
      padding: var(--space-3); border: 1px solid var(--color-border); border-inline-start-width: 4px; border-radius: var(--radius);
    }
    .item.unread { border-inline-start-color: var(--color-primary); background: var(--color-surface-alt); }
    .item.unread .open { font-weight: 600; }
    .open { flex: 1; min-inline-size: 0; color: inherit; text-decoration: none; }
    .open:hover .sentence, .open:focus-visible { text-decoration: underline; }
    .footer { margin-block-start: var(--space-3); }
  `,
})
export class NotificationsPage {
  private readonly api = inject(NotificationsApi);
  private readonly router = inject(Router);
  protected readonly center = inject(NotificationCenter);

  protected readonly unreadOnly = signal(false);
  private readonly cursor = linkedSignal<boolean, string | null>({ source: this.unreadOnly, computation: () => null });
  protected readonly page = this.api.listResource(() => ({
    unreadOnly: this.unreadOnly(),
    cursor: this.cursor(),
    limit: NOTIFICATIONS_PAGE_SIZE,
  }));

  private readonly pages = linkedSignal<PageSource, readonly NotificationPage[]>({
    source: () => ({ unreadOnly: this.unreadOnly(), page: this.page.hasValue() ? this.page.value() : undefined }),
    computation: (source, previous) => {
      const kept = previous && previous.source.unreadOnly === source.unreadOnly ? previous.value : [];
      if (!source.page || kept.includes(source.page)) return kept;
      return [...kept, source.page];
    },
  });

  /** Marked read on this page (the pages themselves are left as the server sent them). */
  private readonly readIds = signal<ReadonlySet<string>>(new Set());
  /** "Mark all read" time: anything created before it shows as read. */
  private readonly allReadAt = signal<string | null>(null);
  protected readonly now = signal(Date.now());

  protected readonly rows = computed(() => {
    const readIds = this.readIds();
    const allReadAt = this.allReadAt();
    return this.pages()
      .flatMap((page) => page.items)
      .map((item) => ({
        item,
        unread: !item.readAt && !readIds.has(item.id) && !(allReadAt !== null && item.createdAt <= allReadAt),
        tree: this.router.parseUrl(safeAppLink(item.link)),
      }));
  });
  protected readonly started = computed(() => this.pages().length > 0);
  protected readonly nextCursor = computed(() => this.pages().at(-1)?.nextCursor ?? null);
  protected readonly anyUnread = computed(() => this.center.unreadCount() > 0 || this.rows().some((row) => row.unread));

  protected setUnreadOnly(event: Event): void {
    this.unreadOnly.set(event.target instanceof HTMLInputElement && event.target.checked);
  }

  protected loadMore(): void {
    const next = this.nextCursor();
    if (next) this.cursor.set(next);
  }

  protected markRead(item: NotificationView): void {
    if (this.readIds().has(item.id)) return;
    this.readIds.update((ids) => new Set(ids).add(item.id));
    this.center.markRead(item);
  }

  protected markAll(): void {
    this.allReadAt.set(new Date().toISOString());
    this.center.markAllRead();
  }
}
