/**
 * NotificationEvents — a tiny app-wide event bus: "a notification just arrived" (from the live stream).
 * `NotificationCenter` publishes; `TasksBadge` (refresh on `task.*`) and the My leave page (reload on `leave.*`) listen.
 *
 * Angular concepts:
 * - **An event is not state: a `Subject`, not a signal.** A signal holds ONE current value and notifies readers that
 *   it changed; readers see the latest value when they next run, and two writes in the same tick collapse into one
 *   (the first is never observed). That is exactly right for state ("the unread count is 3") and exactly wrong for
 *   occurrences ("a task was assigned", then "a leave was approved" 2 ms later: both matter, and a listener wants to
 *   react to EACH). An RxJS `Subject` delivers every `next()` to every subscriber, in order, and holds nothing for
 *   late subscribers — a page opened later must not replay yesterday's events. So: signals for state
 *   (`NotificationCenter.unreadCount`), a Subject for events (this file).
 * - **Why a separate service, not a field of `NotificationCenter`?** Injecting the center CREATES it, and creating it
 *   opens the live connection once signed in. `TasksBadge` must not start a connection as a side effect of being
 *   injected (its tests, and pages that only want the badge, would suddenly open streams). This bus has no
 *   dependencies: injecting it costs nothing, and the dependency points one way (center → bus ← listeners), so
 *   core/tasks never imports the center and there is no import cycle.
 * - **Listeners unsubscribe with `takeUntilDestroyed()`** in their own injection context: a page's subscription ends
 *   when the page is destroyed ("reload if open" is simply "subscribed while alive").
 */
import { Injectable } from '@angular/core';
import { filter, type Observable, Subject } from 'rxjs';
import type { NotificationEvent } from './notifications.models';

@Injectable({ providedIn: 'root' })
export class NotificationEvents {
  private readonly subject = new Subject<NotificationEvent>();

  /** Every notification received live, as it arrives. Hot: no replay. */
  readonly events$: Observable<NotificationEvent> = this.subject.asObservable();

  /** Only the events whose `type` passes `accept` (e.g. `(type) => type.startsWith('leave.')`). */
  of(accept: (type: string) => boolean): Observable<NotificationEvent> {
    return this.events$.pipe(filter((event) => accept(event.type)));
  }

  emit(event: NotificationEvent): void {
    this.subject.next(event);
  }
}
