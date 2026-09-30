/**
 * /kiosk — the entrance display ("Borne de pointage", docs/contracts/attendance.md › Web › Kiosk, ADR 009). A tablet
 * at the door shows a QR code that changes every 30 s; employees scan it with their phone's camera. No sign-in: the
 * tablet is paired once with a one-time code typed by someone on site, and from then on its `httpOnly` device cookie
 * is its only credential. The page runs for days on a cheap Android tablet.
 *
 * States (one signal, `state`, a discriminated union — chapter 17's state machine):
 *   checking → `GET /api/kiosk/session` → running | unpaired | refused (403 network) | unreachable (no answer)
 *   unpaired → pairing form → `POST /api/kiosk/pair` → running
 *   running  → shows the QR of the window that contains the corrected "now"; none → the offline message
 *   any 401 while running → unpaired, with « Borne désactivée — contactez les RH »
 *
 * Angular concepts:
 * - **A route without the app chrome.** app.routes.ts gives this route `data: { chrome: false }`; the root component
 *   reads the data of the active route after each navigation and leaves out the header, the nav and the skip link
 *   (app.ts). The page owns the whole screen.
 * - **Timers owned by the component, cleaned up by `DestroyRef`.** A clock tick (`setInterval`, 500 ms), the next
 *   fetch (`setTimeout`, re-armed after every answer), retries while offline, and a daily session renewal. Every id is
 *   kept, and ONE `inject(DestroyRef).onDestroy()` clears them all: leaving the page (or a test tearing it down) leaves
 *   no timer behind that would fire into a destroyed component. The tick only WRITES a signal (`now`); everything the
 *   screen shows — the corrected clock, the active window, the countdown — is a `computed()` of it, so the QR canvas
 *   redraws only when the window actually changes (qr-canvas.ts).
 * - **Why timers and not RxJS `interval()`/`timer()`.** Both would work (with `takeUntilDestroyed()`). The fetch
 *   schedule changes after every answer (the next window start + a random jitter), which reads more plainly as
 *   "clear the old timeout, set a new one" than as a re-subscribed Observable chain.
 * - **Two translation languages at once.** The entrance serves everyone, whatever the UI language: the instruction and
 *   the offline message are shown in French AND Arabic, side by side. `*transloco="let fr; lang: 'fr'"` gives the
 *   template a translate function bound to one language (the directive loads that file if needed), independent of the
 *   active language; each block also carries `lang` and `dir` so the browser shapes and aligns it correctly.
 * - **Browser APIs behind services**: the Wake Lock and Fullscreen APIs (`ScreenWake`, provided HERE so it lives and
 *   dies with the page) and visibility/online events (`PageActivity`, root).
 * - **`<ng-template #offline>` + `*ngTemplateOutlet`**: the offline block appears in two places of the `@switch`
 *   (no session yet, or a session whose codes ran out); one template, stamped where needed.
 * - **An `InjectionToken` with a default factory** for the daily reload (`KIOSK_RELOAD`): the real one calls
 *   `location.reload()`; a test provides a spy instead of reloading the test runner.
 */
import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  InjectionToken,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, type ValidationErrors, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Subscription } from 'rxjs';
import { formatPairingCode, type KioskSessionView, normalizePairingCode, type QrWindow } from '../../core/attendance/attendance.models';
import { KioskApi } from '../../core/attendance/kiosk-api';
import { PageActivity } from '../../core/browser/page-activity';
import { ScreenWake } from '../../core/browser/screen-wake';
import { isApiProblemError } from '../../core/http/api-problem';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import {
  activeWindow,
  algiersClock,
  inReloadSlot,
  jitter,
  measureOffset,
  nextFetchDelay,
  OFFLINE_RETRY_MS,
  remainingShare,
  SESSION_RENEW_MS,
} from './kiosk-clock';
import { QrCanvas } from './qr-canvas';

/** Reloads the whole page (daily, to pick up a new release). Replaced by a spy in tests. */
export const KIOSK_RELOAD = new InjectionToken<() => void>('KIOSK_RELOAD', {
  factory: () => {
    const document = inject(DOCUMENT);
    return () => document.defaultView?.location.reload();
  },
});

export const TICK_MS = 500;
/** A 403 `kiosk-network-refused` will not fix itself quickly: ask again every 30 s. */
export const REFUSED_RETRY_MS = 30_000;
/** The daily reload happens only if the page has been up at least this long (no reload loop inside the slot). */
export const MIN_UPTIME_BEFORE_RELOAD_MS = 10 * 60_000;

export type KioskState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'unpaired'; readonly notice: 'revoked' | null }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'running'; readonly session: KioskSessionView };

function pairingCode(control: { value: unknown }): ValidationErrors | null {
  const value = typeof control.value === 'string' ? control.value : '';
  return value.trim() === '' || normalizePairingCode(value) ? null : { pairingCode: true };
}

@Component({
  selector: 'app-kiosk-page',
  imports: [TranslocoDirective, ReactiveFormsModule, NgTemplateOutlet, QrCanvas, RevealAlert],
  providers: [ScreenWake],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './kiosk.page.html',
  styleUrl: './kiosk.page.css',
})
export class KioskPage {
  private readonly api = inject(KioskApi);
  /** Every HTTP subscription ends with the page (an answer arriving later must not restart timers). */
  private readonly destroyRef = inject(DestroyRef);
  private readonly reload = inject(KIOSK_RELOAD);
  protected readonly wake = inject(ScreenWake);
  private readonly loadedAt = Date.now();

  protected readonly state = signal<KioskState>({ kind: 'checking' });
  /** Device clock, refreshed by the tick. */
  private readonly now = signal(Date.now());
  /** Server − device, from the last answer. */
  private readonly offset = signal(0);
  private readonly windows = signal<readonly QrWindow[]>([]);

  protected readonly corrected = computed(() => this.now() + this.offset());
  protected readonly session = computed(() => {
    const state = this.state();
    return state.kind === 'running' ? state.session : null;
  });
  protected readonly current = computed(() => (this.session() ? activeWindow(this.windows(), this.corrected()) : null));
  protected readonly clock = computed(() => algiersClock(this.corrected()));
  protected readonly remaining = computed(() => {
    const window = this.current();
    return window ? Math.round(remainingShare(window, this.corrected()) * 100) : 0;
  });

  // --- Pairing form -----------------------------------------------------------------------------------------------

  protected readonly pairForm = new FormGroup({
    code: new FormControl('', { nonNullable: true, validators: [Validators.required, pairingCode] }),
  });
  protected readonly code = this.pairForm.controls.code;
  protected readonly pairing = signal(false);
  protected readonly pairError = signal<{ readonly key: string } | null>(null);

  // --- Timers -----------------------------------------------------------------------------------------------------

  private tick: ReturnType<typeof setInterval> | undefined;
  private renew: ReturnType<typeof setInterval> | undefined;
  private fetchTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private fetching: Subscription | null = null;

  constructor() {
    this.tick = setInterval(() => this.onTick(), TICK_MS);
    this.renew = setInterval(() => this.renewSession(), SESSION_RENEW_MS);
    this.destroyRef.onDestroy(() => {
      clearInterval(this.tick);
      clearInterval(this.renew);
      clearTimeout(this.fetchTimer);
      clearTimeout(this.retryTimer);
      this.fetching?.unsubscribe();
    });

    // Back on screen, or back online: do not wait for the next scheduled fetch.
    const activity = inject(PageActivity);
    activity.shown$.pipe(takeUntilDestroyed()).subscribe(() => this.wakeUp());
    activity.reconnected$.pipe(takeUntilDestroyed()).subscribe(() => this.wakeUp());

    this.checkSession();
  }

  /** The "Plein écran" button: full screen + wake lock (needs this click). */
  protected keepAwake(): void {
    this.wake.start();
  }

  protected pair(): void {
    this.pairError.set(null);
    const normalized = normalizePairingCode(this.code.value);
    if (this.code.invalid || !normalized) {
      this.code.markAsTouched();
      return;
    }
    this.pairing.set(true);
    const sentAt = Date.now();
    this.api.pair(normalized).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (session) => {
        this.pairing.set(false);
        this.code.reset('');
        this.startRunning(session, measureOffset(session.serverTime, sentAt, Date.now()));
      },
      error: (error: unknown) => {
        this.pairing.set(false);
        const status = isApiProblemError(error) ? error.status : 0;
        this.pairError.set({
          key:
            status === 410 || status === 422
              ? 'attendance.kiosk.pairInvalid'
              : status === 0
                ? 'attendance.kiosk.pairNetwork'
                : 'errors.generic',
        });
      },
    });
  }

  /** Shows the code as it will be read out: "K7M2-9QXA". */
  protected onCodeBlur(): void {
    const normalized = normalizePairingCode(this.code.value);
    if (normalized) this.code.setValue(formatPairingCode(normalized));
  }

  // --- Flow -------------------------------------------------------------------------------------------------------

  private checkSession(): void {
    clearTimeout(this.retryTimer);
    const sentAt = Date.now();
    this.api.session().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (session) => this.startRunning(session, measureOffset(session.serverTime, sentAt, Date.now())),
      error: (error: unknown) => {
        const status = isApiProblemError(error) ? error.status : 0;
        if (status === 401) {
          this.toUnpaired(this.state().kind === 'running' ? 'revoked' : null);
        } else if (status === 403) {
          this.state.set({ kind: 'refused' });
          this.retryTimer = setTimeout(() => this.checkSession(), REFUSED_RETRY_MS);
        } else {
          this.state.set({ kind: 'unreachable' });
          this.retryTimer = setTimeout(() => this.checkSession(), OFFLINE_RETRY_MS);
        }
      },
    });
  }

  private startRunning(session: KioskSessionView, offset: number): void {
    this.offset.set(offset);
    this.now.set(Date.now());
    this.state.set({ kind: 'running', session });
    this.fetchQr();
  }

  private toUnpaired(notice: 'revoked' | null): void {
    clearTimeout(this.fetchTimer);
    clearTimeout(this.retryTimer);
    this.fetching?.unsubscribe();
    this.fetching = null;
    this.windows.set([]);
    this.state.set({ kind: 'unpaired', notice });
  }

  /** `GET /api/kiosk/qr`, then schedule the next one for the start of the next window (+ jitter). */
  private fetchQr(): void {
    if (this.fetching) return;
    clearTimeout(this.fetchTimer);
    const sentAt = Date.now();
    this.fetching = this.api.qr().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (view) => {
        this.fetching = null;
        const receivedAt = Date.now();
        this.offset.set(measureOffset(view.serverTime, sentAt, receivedAt));
        this.windows.set(view.windows);
        this.now.set(receivedAt);
        const delay = nextFetchDelay(view.windows, this.corrected(), jitter(Math.random()));
        this.fetchTimer = setTimeout(() => this.fetchQr(), delay || OFFLINE_RETRY_MS);
      },
      error: (error: unknown) => {
        this.fetching = null;
        const status = isApiProblemError(error) ? error.status : 0;
        if (status === 401) {
          this.toUnpaired('revoked');
          return;
        }
        if (status === 403) {
          clearTimeout(this.fetchTimer);
          this.windows.set([]);
          this.state.set({ kind: 'refused' });
          this.retryTimer = setTimeout(() => this.checkSession(), REFUSED_RETRY_MS);
          return;
        }
        // Network or server trouble: the windows already held keep the code on screen for up to 2 minutes.
        this.fetchTimer = setTimeout(() => this.fetchQr(), OFFLINE_RETRY_MS);
      },
    });
  }

  private onTick(): void {
    this.now.set(Date.now());
    if (inReloadSlot(this.corrected()) && Date.now() - this.loadedAt > MIN_UPTIME_BEFORE_RELOAD_MS) {
      this.reload();
    }
  }

  private wakeUp(): void {
    const kind = this.state().kind;
    if (kind === 'running') this.fetchQr();
    else if (kind === 'unreachable') this.checkSession();
  }

  /** Once a day: renews the device cookie (400 days) and notices a revocation even when the codes still flow. */
  private renewSession(): void {
    if (this.state().kind !== 'running') return;
    this.api.session().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (session) => {
        if (this.state().kind === 'running') this.state.set({ kind: 'running', session });
      },
      error: (error: unknown) => {
        const status = isApiProblemError(error) ? error.status : 0;
        if (status === 401) this.toUnpaired('revoked');
      },
    });
  }
}
