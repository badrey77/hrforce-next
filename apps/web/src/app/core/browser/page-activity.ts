/**
 * PageActivity — "is this tab visible?" and "is the device online?", as signals AND as event streams, for pages that
 * refresh when the user comes back (Pointage, the presence board) and for the kiosk (re-fetch its codes, re-take the
 * wake lock). docs/contracts/attendance.md › Web.
 *
 * Angular concepts:
 * - **Browser events → one root service.** `document` fires `visibilitychange`; `window` fires `online`/`offline`.
 *   Listening once, in a root service, means every page reads the same answer and none forgets to remove its
 *   listener. `fromEvent()` (RxJS) wraps `addEventListener`/`removeEventListener`; `takeUntilDestroyed()` removes the
 *   listeners when the root injector is destroyed (at the end of each unit test).
 * - **State vs events (chapter 16).** `visible()` / `online()` are STATE: a template or a `computed()` reads the
 *   current value (the board only auto-refreshes while `visible()`). `shown$` / `reconnected$` are EVENTS: "the tab
 *   just became visible" happens at a moment and carries no lasting value, so a page SUBSCRIBES and reloads. Using an
 *   `effect()` on `visible()` for that would also run once at creation (effects always run once) and would need a
 *   "previous value" variable to detect the transition — the event stream says exactly what happened.
 * - **Zoneless.** The listeners set signals; with zoneless change detection, a signal write is what schedules a
 *   render. Nothing else (no `NgZone.run`) is needed for browser callbacks.
 * - **`inject(DOCUMENT)`** instead of the global `document`: a test can hand in another document, and server
 *   rendering (not used here) would too. `navigator` and `window` are reached through `document.defaultView`.
 */
import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, fromEvent, map, type Observable, share } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class PageActivity {
  private readonly document = inject(DOCUMENT);
  private readonly window = this.document.defaultView;

  private readonly isVisible = signal(this.document.visibilityState !== 'hidden');
  private readonly isOnline = signal(this.window?.navigator.onLine ?? true);

  /** The tab is on screen (`visibilityState !== 'hidden'`). */
  readonly visible = this.isVisible.asReadonly();
  /** The browser believes it has a network (a hint only: a captive portal still says "online"). */
  readonly online = this.isOnline.asReadonly();

  /** Emits each time the tab becomes visible again. */
  readonly shown$: Observable<void>;
  /** Emits each time the browser goes back online. */
  readonly reconnected$: Observable<void>;

  constructor() {
    const visibility = fromEvent(this.document, 'visibilitychange').pipe(
      map(() => this.document.visibilityState !== 'hidden'),
      share(),
    );
    visibility.pipe(takeUntilDestroyed()).subscribe((visible) => this.isVisible.set(visible));
    this.shown$ = visibility.pipe(
      filter(Boolean),
      map(() => undefined),
    );

    const target: EventTarget = this.window ?? this.document;
    fromEvent(target, 'offline')
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.isOnline.set(false));
    const online = fromEvent(target, 'online').pipe(share());
    online.pipe(takeUntilDestroyed()).subscribe(() => this.isOnline.set(true));
    this.reconnected$ = online.pipe(map(() => undefined));
  }
}
