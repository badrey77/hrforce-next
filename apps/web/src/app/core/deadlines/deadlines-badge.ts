/**
 * DeadlinesBadge — the caller's `GET /deadlines/summary`, shared by the nav badge (« Échéances », overdue count) and
 * the dashboard tile. Requested only with `deadline.read`. Refreshed when the tab becomes visible again, when a
 * `deadline.digest` notification arrives live, and by the board after an ack/undo — not on every navigation (the
 * summary is computed from every open employment in scope).
 */
import { DOCUMENT } from '@angular/common';
import { computed, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, fromEvent } from 'rxjs';
import { Session } from '../auth/session';
import { NotificationEvents } from '../notifications/notification-events';
import { DeadlinesApi } from './deadlines-api';
import type { DeadlineSummary } from './deadlines.models';

export const DEADLINE_READ = 'deadline.read';

@Injectable({ providedIn: 'root' })
export class DeadlinesBadge {
  private readonly session = inject(Session);
  private readonly document = inject(DOCUMENT);
  private readonly enabled = computed(() => this.session.isAuthenticated() && this.session.can(DEADLINE_READ));
  private readonly resource = inject(DeadlinesApi).summaryResource(() => this.enabled());

  readonly summary = computed<DeadlineSummary | undefined>(() => (this.resource.hasValue() ? this.resource.value() : undefined));
  /** The nav badge: items past their date (the critical ones included). */
  readonly overdue = computed(() => this.summary()?.overdue ?? 0);

  constructor() {
    fromEvent(this.document, 'visibilitychange')
      .pipe(
        filter(() => this.document.visibilityState === 'visible'),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.refresh());
    inject(NotificationEvents)
      .of((type) => type === 'deadline.digest')
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.refresh());
  }

  refresh(): void {
    if (this.enabled()) this.resource.reload();
  }
}
