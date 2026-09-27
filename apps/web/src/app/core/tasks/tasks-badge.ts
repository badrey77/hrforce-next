/**
 * TasksBadge — the signed-in user's open tasks, as ONE app-wide store: the nav badge shows `count()`, the /tasks page
 * lists `items()`. Both read the same resource, so the number in the nav and the rows on the page can never disagree.
 *
 * Angular concepts:
 * - **A root signal store over a resource.** `resource` is an `httpResource` created once (root service). Its request
 *   function reads `Session.isAuthenticated()`: signed out → idle, signed in → `GET /api/tasks?status=open`.
 *   `items` and `count` are `computed()`s of it; the nav template reads `count()`, so the badge re-renders exactly
 *   when the number changes (zoneless: the signal read IS the subscription).
 * - **When does the count refresh?** Postgres-only stack, no push channel (no WebSocket / SSE server yet), so the
 *   browser must ask. Two ways to decide *when*:
 *     1. **Polling** — `interval(60_000).pipe(takeUntilDestroyed()).subscribe(() => this.refresh())`. Simple and
 *        always fresh-ish, but it costs a request per open tab per minute FOREVER, including tabs nobody looks at, and
 *        `GET /tasks` is not a cheap read: candidates of permission steps are evaluated at read time through the
 *        scope service (contract › Candidates). 200 HR users with 3 tabs each = 600 requests a minute for a number
 *        that changes a few times a day.
 *     2. **Events (chosen)** — refresh when something happened that makes a new answer likely:
 *        - after every **navigation** (`Router.events` → `NavigationEnd`): the user is active, and opening /tasks
 *          itself refreshes the list;
 *        - when the tab becomes **visible** again (`fromEvent(document, 'visibilitychange')`): the "back from lunch"
 *          case — the browser tells us the user is looking at the page again;
 *        - right **after an approve/reject** (the page calls `refresh()`).
 *      Cost: zero requests while nobody uses the app. Trade-off: a task assigned while the user stares at one page
 *      without clicking shows up on their next click (or tab switch), not within a minute. Approvals are not
 *      second-critical, so that is the better deal. If they become so, the answer is a server push (SSE), not a
 *      faster poll.
 *   Since the notifications slice there IS a push channel (SSE, core/notifications/notification-center.ts): a
 *   `task.*` notification (or `leave.cancelled`, which closes a task) arriving live is a third trigger. The badge
 *   listens on the `NotificationEvents` bus rather than injecting the center, so creating the badge never opens a
 *   connection (the bus's header explains the split). The navigation / visibility triggers stay: they are the
 *   fallback when the stream is down, and cost nothing when nothing happens.
 *   All three use `takeUntilDestroyed()`: a root service lives as long as the app, but tests create and destroy app
 *   injectors many times, and an event listener left on `document` would outlive them.
 * - **Optimistic updates with signals.** The /tasks page removes a task from the list THE MOMENT the user clicks
 *   Approve, before the server answers (the answer usually confirms it; waiting would make every click feel slow).
 *   The store keeps the server's list untouched and a second signal, `hidden`, of ids removed optimistically;
 *   `items = server list minus hidden` is a `computed()`. So:
 *     - `hide(id)` → the row disappears and the badge count drops by one, in the same change-detection pass;
 *     - on success → `refresh()`; the server list no longer contains the task, so `hidden` is harmless;
 *     - on failure → `show(id)` (rollback): the id leaves `hidden`, the computed re-runs and the row is back exactly
 *       where it was — we never had to remember its position or a copy of it.
 *   Deriving the visible list from (truth, pending changes) instead of mutating a copy is what makes the rollback a
 *   one-liner.
 */
import { DOCUMENT } from '@angular/common';
import { computed, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, fromEvent } from 'rxjs';
import { Session } from '../auth/session';
import { NotificationEvents } from '../notifications/notification-events';
import { TasksApi } from './tasks-api';
import type { OpenTask } from './tasks.models';

@Injectable({ providedIn: 'root' })
export class TasksBadge {
  private readonly session = inject(Session);
  private readonly document = inject(DOCUMENT);
  private readonly resource = inject(TasksApi).openResource(() => this.session.isAuthenticated());

  /** Ids removed optimistically, waiting for the server (see header). */
  private readonly hidden = signal<ReadonlySet<string>>(new Set());

  /** Open tasks, minus the ones being acted on. Empty while signed out or before the first answer. */
  readonly items = computed<readonly OpenTask[]>(() => {
    if (!this.resource.hasValue()) return [];
    const hidden = this.hidden();
    return this.resource.value().items.filter((task) => !hidden.has(task.id));
  });
  readonly count = computed(() => this.items().length);
  readonly loaded = computed(() => this.resource.hasValue());
  readonly isLoading = computed(() => this.resource.isLoading());
  readonly error = computed(() => this.resource.error());

  constructor() {
    inject(Router)
      .events.pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.refresh());
    fromEvent(this.document, 'visibilitychange')
      .pipe(
        filter(() => this.document.visibilityState === 'visible'),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.refresh());
    inject(NotificationEvents)
      .of((type) => type.startsWith('task.') || type === 'leave.cancelled')
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.refresh());
  }

  /** Ask the server again (keeps showing the current list meanwhile). No-op while signed out. */
  refresh(): void {
    if (this.session.isAuthenticated()) this.resource.reload();
  }

  /** Optimistically remove a task from `items` (and the badge). */
  hide(id: string): void {
    this.hidden.update((ids) => new Set(ids).add(id));
  }

  /** Roll back `hide(id)`. */
  show(id: string): void {
    this.hidden.update((ids) => {
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
  }
}
