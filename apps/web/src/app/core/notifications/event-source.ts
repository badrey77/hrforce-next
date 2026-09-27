/**
 * `EVENT_SOURCE_FACTORY` — how the app opens a Server-Sent Events connection, as an injectable function.
 *
 * Angular concepts:
 * - **An `InjectionToken` for something that is not a class.** `inject(X)` needs a token. A class is its own token;
 *   a FUNCTION type (`(url) => EventSourceLike`) has no runtime identity, so we create one with
 *   `new InjectionToken<T>(description, { providedIn: 'root', factory })`. The `factory` is the default provider:
 *   nothing has to be registered in app.config.ts, and the app gets the real browser `EventSource`.
 * - **Why inject it at all?** Testability. `NotificationCenter` never writes `new EventSource(...)`; it asks DI.
 *   A test replaces the token (`{ provide: EVENT_SOURCE_FACTORY, useValue: fake.factory }`, testing/fake-event-source.ts)
 *   and then drives "the server" by hand: open, send an event, fail — synchronously, with no network and no timers
 *   of its own. The same seam would let a native shell (or a polyfill with custom headers) supply its own transport.
 * - **`EventSourceLike`, not `EventSource`.** The center uses only `addEventListener` and `close`. Typing against that
 *   narrow interface keeps the fake tiny and documents exactly what the center depends on.
 * - **`null` = not supported.** jsdom (our unit-test DOM) and some locked-down browsers have no `EventSource`.
 *   The default factory returns `null` there, and the center falls back to refreshing on visibility (like TasksBadge).
 */
import { InjectionToken } from '@angular/core';

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike | null;

export const EVENT_SOURCE_FACTORY = new InjectionToken<EventSourceFactory>('EVENT_SOURCE_FACTORY', {
  providedIn: 'root',
  // Same origin (`/api` is proxied in dev, served by Caddy in staging): the session cookies go with the request
  // without `withCredentials`.
  factory: () => (url: string) => (typeof EventSource === 'undefined' ? null : new EventSource(url)),
});
