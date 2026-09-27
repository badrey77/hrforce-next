/**
 * NotificationCenter — the signed-in user's notifications as app-wide signals, kept live by Server-Sent Events
 * (docs/contracts/notifications.md › Live updates, Web). The header bell reads `unreadCount()` and `latest()`;
 * the /notifications page and the bell call `markRead()` / `markAllRead()`.
 *
 * Angular concepts:
 * - **EventSource vs WebSocket vs polling — why SSE.** The server has something to say ("you have a new task") and
 *   the browser only needs to listen:
 *     | | Polling (`interval` + GET) | WebSocket | **Server-Sent Events (chosen)** |
 *     |---|---|---|---|
 *     | Direction | client asks | both ways | server → client |
 *     | Latency | up to one period | instant | instant |
 *     | Cost when nothing happens | one request per tab per period | one idle socket | one idle HTTP response |
 *     | Protocol / infra | plain HTTP | upgrade handshake, own framing, proxy config | plain HTTP (`text/event-stream`); only "no buffering" on the proxy |
 *     | Auth | cookies + interceptors | cookies at handshake only | cookies (same origin), no interceptors (below) |
 *     | Reconnect | n/a | write it yourself | built into the browser (we still take it over, below) |
 *   We never need to SEND on this channel (marking as read is an ordinary POST), so a WebSocket's second direction
 *   would be unused complexity. Polling was already rejected for the task badge (core/tasks/tasks-badge.ts). SSE is
 *   plain HTTP that the API serves from Postgres LISTEN/NOTIFY, with no broker (ADR 005: Postgres only).
 * - **Why EventSource bypasses HttpClient interceptors.** `new EventSource(url)` is a browser API: the browser opens
 *   and re-opens the connection itself. Angular's `HttpClient` — and so our interceptors (XSRF, problem parsing, and
 *   crucially the 401 → refresh → retry of core/auth/auth-refresh.interceptor.ts) — never see it. The session cookie
 *   is still sent (same origin), but when the 15-minute access cookie expires the server ends the stream (contract)
 *   and nothing refreshes it. So on `error` we close the EventSource ourselves and, before reconnecting, make one
 *   ORDINARY request (`GET /me/notifications/unread-count` through HttpClient): if the cookie expired, that request
 *   gets 401, the interceptor refreshes the session (single-flight, shared with any other request), retries, and the
 *   next EventSource carries the new cookie. It also refreshes the count we may have missed while disconnected.
 * - **Backoff, then fallback.** Reconnect delays grow (1 s, 2 s, 5 s, 15 s, 30 s — `STREAM_BACKOFF_MS`) so a
 *   restarting API is not hammered by every open tab at once; after `MAX_STREAM_FAILURES` failures in a row (no
 *   `open` in between) we stop trying and fall back to what TasksBadge does: refresh when the tab becomes visible
 *   again (plus one fresh stream attempt then). A browser without `EventSource` starts in that mode.
 * - **Zoneless change detection with signals set from browser callbacks.** EventSource listeners and `setTimeout`
 *   callbacks run outside anything Angular started. With zone.js, Angular learned about them by patching every async
 *   API, and code sometimes needed `NgZone.run()` to "re-enter" Angular. This app has no zone.js: a template re-renders
 *   because it READ a signal that was then SET. `this.unread.set(3)` inside an EventSource listener marks the bell
 *   for check and schedules a render — no `NgZone`, no `ChangeDetectorRef`. Rule: update state through signals and it
 *   does not matter which callback you are in.
 * - **An `effect()` that owns a connection.** The EventSource exists only while signed in: an `effect()` reads the
 *   Session (user + company) and opens or closes the stream when that changes — sign-in, sign-out, a failed refresh
 *   that clears the session, a company switch. The body runs in `untracked()` so the signals read while (re)starting
 *   do not become dependencies of the effect: only the session key drives it. This is an effect's proper job — a
 *   side effect OUTSIDE the signal graph (a network connection), not deriving state (that is `computed()`).
 * - **Cleanup with `DestroyRef`.** A root service lives as long as the app, but tests create and destroy app
 *   injectors many times. `inject(DestroyRef).onDestroy(() => this.stop())` closes the EventSource and clears the
 *   retry timer when the injector goes; the effect and `takeUntilDestroyed()` clean themselves up the same way.
 * - **Testability via `EVENT_SOURCE_FACTORY`** (event-source.ts): the center never calls `new EventSource()`, it asks
 *   DI for a factory, so the spec swaps in a fake it can open, feed and break on demand.
 * - **A generation counter against stale callbacks.** Every start/stop bumps `generation`; an HTTP answer or a timer
 *   that belongs to an older generation (the user signed out meanwhile) is ignored instead of resurrecting old data.
 *
 * The event bus (notification-events.ts) is separate: see its header for "Subject for events, signals for state".
 */
import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, effect, Injectable, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, fromEvent } from 'rxjs';
import { Session } from '../auth/session';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from './event-source';
import { NotificationEvents } from './notification-events';
import { NotificationsApi, NOTIFICATIONS_STREAM_URL } from './notifications-api';
import { BELL_SIZE, type NotificationEvent, type NotificationView } from './notifications.models';

/** Delay before reconnect attempt n (1-based); the last value repeats (cap). */
export const STREAM_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000];
/** Consecutive failures (no `open` in between) before falling back to refresh-on-visibility. */
export const MAX_STREAM_FAILURES = 5;

/**
 * - `off` signed out · `connecting` first attempt · `live` stream open · `retrying` waiting to reconnect ·
 * - `fallback` stream given up (or unsupported): refreshed when the tab becomes visible.
 */
export type StreamStatus = 'off' | 'connecting' | 'live' | 'retrying' | 'fallback';

export function backoffDelay(failures: number): number {
  const index = Math.min(Math.max(failures, 1), STREAM_BACKOFF_MS.length) - 1;
  return STREAM_BACKOFF_MS[index] ?? 30_000;
}

/** A path inside this app (`/tasks?task=…`), never another origin (`//evil`, `https://…`, `javascript:`). */
export function safeAppLink(link: string | null | undefined): string {
  return typeof link === 'string' && /^\/(?![/\\])/.test(link) ? link : '/notifications';
}

function isFullView(event: NotificationEvent): event is NotificationView {
  return typeof event.createdAt === 'string' && typeof event.link === 'string' && typeof event.subject === 'object';
}

function parseData(event: Event): unknown {
  const data = (event as MessageEvent).data;
  if (typeof data !== 'string') return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

@Injectable({ providedIn: 'root' })
export class NotificationCenter {
  private readonly api = inject(NotificationsApi);
  private readonly session = inject(Session);
  private readonly bus = inject(NotificationEvents);
  private readonly document = inject(DOCUMENT);
  private readonly openEventSource = inject(EVENT_SOURCE_FACTORY);

  /** `null` = not known yet (signed out, or the first answer has not arrived). */
  private readonly unread = signal<number | null>(null);
  private readonly items = signal<readonly NotificationView[]>([]);
  private readonly state = signal<StreamStatus>('off');

  readonly unreadCount = computed(() => this.unread() ?? 0);
  readonly unreadKnown = computed(() => this.unread() !== null);
  /** The newest `BELL_SIZE` notifications, newest first. */
  readonly latest = this.items.asReadonly();
  readonly status = this.state.asReadonly();

  private source: EventSourceLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private generation = 0;

  /** Who is signed in where: a change of either restarts the stream (a string compares by value). */
  private readonly sessionKey = computed(() => {
    const user = this.session.user();
    const company = this.session.company();
    return user && company ? `${user.id}@${company.id}` : null;
  });

  constructor() {
    effect(() => {
      const key = this.sessionKey();
      untracked(() => {
        this.stop();
        if (key) this.start();
      });
    });
    fromEvent(this.document, 'visibilitychange')
      .pipe(
        filter(() => this.document.visibilityState === 'visible'),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.onVisible());
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** Re-read the count and the latest list over HTTP (after a gap, or in fallback mode). */
  refresh(): void {
    const generation = this.generation;
    if (!this.session.isAuthenticated()) return;
    this.api.list({ unreadOnly: false, cursor: null, limit: BELL_SIZE }).subscribe({
      next: (page) => {
        if (generation === this.generation) this.items.set(page.items.slice(0, BELL_SIZE));
      },
      error: () => undefined, // keep what we show; the next event or visibility change tries again
    });
    this.api.unreadCount().subscribe({
      next: (body) => {
        if (generation === this.generation) this.unread.set(body.count);
      },
      error: () => undefined,
    });
  }

  /** Optimistic: shown as read and the count drops at once; a failure re-reads the truth from the server. */
  markRead(notification: Pick<NotificationView, 'id' | 'readAt'>): void {
    if (notification.readAt) return;
    const now = new Date().toISOString();
    this.items.update((items) => items.map((n) => (n.id === notification.id && !n.readAt ? { ...n, readAt: now } : n)));
    // Also when it is not in the bell's list (an older one, read from the page): still one fewer unread.
    this.unread.update((count) => (count === null ? null : Math.max(0, count - 1)));
    this.api.markRead(notification.id).subscribe({ error: () => this.refresh() });
  }

  markAllRead(): void {
    const now = new Date().toISOString();
    this.items.update((items) => items.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    this.unread.set(0);
    this.api.markAllRead().subscribe({ error: () => this.refresh() });
  }

  // --- Connection lifecycle --------------------------------------------------------------------------------------

  private start(): void {
    this.failures = 0;
    this.state.set('connecting');
    this.refresh();
    this.connect();
  }

  /** Close everything and forget the user's data (sign-out, company switch, injector destroyed). */
  private stop(): void {
    this.generation++;
    this.source?.close();
    this.source = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.state.set('off');
    this.unread.set(null);
    this.items.set([]);
  }

  private connect(): void {
    const source = this.openEventSource(NOTIFICATIONS_STREAM_URL);
    if (!source) {
      this.state.set('fallback');
      return;
    }
    this.source = source;
    // Each listener checks it still belongs to the CURRENT source: a closed one may still deliver a queued event.
    source.addEventListener('open', () => {
      if (this.source !== source) return;
      this.failures = 0;
      this.state.set('live');
    });
    source.addEventListener('unread', (event) => {
      if (this.source !== source) return;
      const body = parseData(event) as { count?: unknown } | undefined;
      if (typeof body?.count === 'number') this.unread.set(body.count);
    });
    source.addEventListener('notification', (event) => {
      if (this.source !== source) return;
      const body = parseData(event) as NotificationEvent | undefined;
      if (body && typeof body.id === 'string' && typeof body.type === 'string') this.onNotification(body);
    });
    source.addEventListener('error', () => {
      if (this.source !== source) return;
      this.failed();
    });
  }

  private onNotification(event: NotificationEvent): void {
    if (isFullView(event)) {
      const known = this.items().some((n) => n.id === event.id);
      this.items.update((items) => [event, ...items.filter((n) => n.id !== event.id)].slice(0, BELL_SIZE));
      // The server follows with an `unread` event (absolute count); counting now keeps the badge instant meanwhile.
      if (!known && !event.readAt) this.unread.update((count) => (count ?? 0) + 1);
    } else {
      this.refresh();
    }
    this.bus.emit(event);
  }

  /**
   * The stream broke (network, API restart, or the access cookie expired and the server ended it). We close it
   * ourselves — the browser's own retry would present the same expired cookie forever — and schedule our reconnect.
   */
  private failed(): void {
    this.source?.close();
    this.source = null;
    this.failures++;
    if (this.failures >= MAX_STREAM_FAILURES) {
      this.state.set('fallback');
      return;
    }
    this.state.set('retrying');
    const generation = this.generation;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (generation === this.generation) this.renewThenConnect(generation);
    }, backoffDelay(this.failures));
  }

  /** An ordinary HttpClient call first: the refresh interceptor renews an expired session cookie (see header). */
  private renewThenConnect(generation: number): void {
    this.api.unreadCount().subscribe({
      next: (body) => {
        if (generation !== this.generation) return;
        this.unread.set(body.count);
        this.connect();
      },
      error: () => {
        // Refresh failed → the interceptor cleared the session and the effect will stop us; otherwise try later.
        if (generation !== this.generation || !this.session.isAuthenticated()) return;
        this.failed();
      },
    });
  }

  private onVisible(): void {
    if (this.state() !== 'fallback' || !this.session.isAuthenticated()) return;
    this.refresh();
    // One fresh attempt: `open` resets the failure count (live again); another error goes straight back to fallback.
    this.connect();
  }
}
