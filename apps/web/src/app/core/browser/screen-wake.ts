/**
 * ScreenWake — keeps an entrance tablet's screen on and full-screen (docs/contracts/attendance.md › Kiosk): the
 * Screen Wake Lock API and the Fullscreen API behind one small service. `providers: [ScreenWake]` on the kiosk page.
 *
 * Browser rules this service works with:
 * - **A user gesture first.** `requestFullscreen()` is refused unless it runs during a click/tap. `start()` is
 *   therefore called from the "Plein écran" button's `(click)` handler, synchronously, before any `await`.
 * - **The wake lock is released when the page is hidden** (tab switched, screen off, another app). The browser
 *   drops it on its own; the page must ask again when it is visible — `PageActivity.shown$` is that moment. A
 *   `WakeLockSentinel` fires `release` when that happens, which keeps `awake()` honest.
 * - **Feature detection, no crash.** Chrome ≥ 84 on Android has both APIs; an old tablet may not. Each call is
 *   guarded (`'wakeLock' in navigator`), and failures are swallowed: the kiosk still works, the screen may just
 *   dim after the tablet's own timeout (set it to "never" in the tablet's settings as a fallback).
 * - The CSP and `Permissions-Policy` need no change: `screen-wake-lock` and `fullscreen` default to `self`
 *   (ADR 009 › Consequences).
 *
 * Angular concepts:
 * - **A component-scoped service** (`providers: [ScreenWake]` on the component, chapter 18): one instance per kiosk
 *   page, destroyed with it. Its `DestroyRef` is the COMPONENT's, so `onDestroy` releases the lock and leaves full
 *   screen when the kiosk page goes away — no `ngOnDestroy` in the page.
 * - **Signals set from browser callbacks** (`fullscreenchange`, `release`): zoneless change detection re-renders the
 *   button's label on its own.
 */
import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent } from 'rxjs';
import { PageActivity } from './page-activity';

@Injectable()
export class ScreenWake {
  private readonly document = inject(DOCUMENT);
  private readonly navigator = this.document.defaultView?.navigator;
  private sentinel: WakeLockSentinel | null = null;
  /** The user asked for it: re-take the lock each time the page is shown again. */
  private wanted = false;

  private readonly isAwake = signal(false);
  private readonly isFullscreen = signal(this.document.fullscreenElement !== null && this.document.fullscreenElement !== undefined);

  /** A wake lock is currently held. */
  readonly awake = this.isAwake.asReadonly();
  /** The document is full-screen. */
  readonly fullscreen = this.isFullscreen.asReadonly();
  readonly wakeLockSupported = !!this.navigator && 'wakeLock' in this.navigator;

  constructor() {
    fromEvent(this.document, 'fullscreenchange')
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.isFullscreen.set(!!this.document.fullscreenElement));
    inject(PageActivity)
      .shown$.pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this.wanted) void this.acquire();
      });
    inject(DestroyRef).onDestroy(() => {
      this.wanted = false;
      void this.sentinel?.release().catch(() => undefined);
      this.sentinel = null;
      if (this.document.fullscreenElement) void this.document.exitFullscreen?.().catch(() => undefined);
    });
  }

  /** Call from a click handler: enters full screen (needs the gesture) and takes the wake lock. */
  start(): void {
    this.wanted = true;
    const root = this.document.documentElement;
    if (!this.document.fullscreenElement && typeof root.requestFullscreen === 'function') {
      root.requestFullscreen().catch(() => undefined);
    }
    void this.acquire();
  }

  private async acquire(): Promise<void> {
    const wakeLock = this.wakeLockSupported ? this.navigator?.wakeLock : undefined;
    if (!wakeLock || this.sentinel || this.document.visibilityState === 'hidden') return;
    try {
      const sentinel = await wakeLock.request('screen');
      this.sentinel = sentinel;
      this.isAwake.set(true);
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) this.sentinel = null;
        this.isAwake.set(false);
      });
    } catch {
      // Refused (battery saver, not visible, policy): the page keeps working; the screen may dim.
      this.isAwake.set(false);
    }
  }
}
