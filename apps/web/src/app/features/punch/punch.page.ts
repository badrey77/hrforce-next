/**
 * /punch — where the phone lands after its camera read the entrance QR code (docs/contracts/attendance.md › Web ›
 * Punch landing, ADR 009 §3). The code is a link `https://<domain>/punch#<token>`; this page turns it into a punch:
 *
 *   1. read the token from the URL FRAGMENT, then drop it from the address bar;
 *   2. `POST /api/attendance/scan {token}` (public) → the entrance's name + a 2-minute scan RECEIPT, an `httpOnly`
 *      cookie the page never sees;
 *   3. signed out? → `/login?returnUrl=/punch`. After sign-in (and the TOTP code, if any) the login page navigates
 *      back here WITHOUT a token;
 *   4. `GET /api/me/attendance/receipt` — what redeeming the receipt WOULD record (entrance, time, arrival or
 *      departure, already recorded?), read-only;
 *   5. **one-tap confirmation** (owner decision 2026-09-30): « Enregistrer mon arrivée à <entrée> ? » with ONE large
 *      button. Only that tap sends `POST /api/me/attendance/punches` (no body), which redeems the receipt: the punch's
 *      time is the SCAN's time, so the minute spent typing a password does not make anyone late. When the receipt
 *      says `duplicate`, the page shows « Déjà enregistré » and no button.
 *
 * Why the tap: before it, opening a live `/punch#<token>` link (sent in a message by someone standing at the door)
 * punched the signed-in reader silently. Now a link can at most SHOW a question; nothing is recorded without a
 * deliberate tap on this screen. The receipt was also shortened to 2 minutes: a late tap gets the explicit « Code
 * expiré, veuillez scanner à nouveau » state (on a timer from the receipt's end, or from the API's 409
 * `attendance-no-scan`).
 *
 * Angular concepts:
 * - **Reading the fragment with the router.** The router parses the whole URL, fragment included:
 *   `ActivatedRoute.fragment` emits `"<token>"` for `/punch#<token>` (`null` without `#`) — and emits again when a
 *   later scan changes only the fragment while this page is open (see the constructor). The token lives in
 *   the fragment ON PURPOSE: browsers never send a fragment to the server, so it is in no access log and no Referer.
 * - **Dropping it with `router.navigate([], { relativeTo, replaceUrl: true })`.** Navigating to "the current route,
 *   with no fragment" rewrites the address bar through `history.replaceState` (no new history entry: Back does not
 *   return to the token) AND updates the router's own idea of the URL. Calling `history.replaceState` directly
 *   would leave `router.url` at `/punch#<token>` — and the refresh interceptor builds its `returnUrl` from
 *   `router.url`, which would put a used token back into the address bar after sign-in. Same route, same component:
 *   the router reuses this instance, the constructor does not run again.
 * - **A flow that survives a sign-in redirect.** Nothing is kept in the browser between steps 2 and 4: the server
 *   holds the state (the receipt cookie), the URL holds the way back (`returnUrl=/punch`, validated by
 *   `safeReturnUrl()` on the login page), and the receipt route tells the page, after the round trip, everything the
 *   question needs. A reload or a fresh tab after sign-in still works.
 * - **Ordered async steps with `firstValueFrom()`** — each call depends on the previous one's outcome, so `async`/
 *   `await` reads top to bottom; the result is ONE signal, `state`, a discriminated union the template `@switch`es on
 *   (working → confirm → working → done, or problem).
 * - **Focus on the one button**: `viewChild('confirmButton')` is a signal that holds the button only while the
 *   `confirm` state renders it; an `afterRenderEffect()` reads it and calls `focus()` once the DOM exists — a screen
 *   reader announces the question, a keyboard user presses Enter. (`autofocus` works only on a page's first load, not
 *   on an element an SPA adds later.)
 * - **A timer owned by the page**: the expiry `setTimeout` is cleared when the state leaves `confirm` and, through
 *   `DestroyRef.onDestroy`, when the page goes away (chapter 20 §2).
 * - The route has NO guard (app.routes.ts): a signed-out phone must reach step 2 before being asked to sign in.
 */
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import { kioskLabel, type PunchResultView, type ReceiptView, type ScanView } from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

export const PUNCH_RETURN_URL = '/punch';
/** The receipt's lifetime (contract › Phase B: `hrf_scan` Max-Age=120). */
export const RECEIPT_LIFETIME_MS = 120_000;

/** Unicode FIRST STRONG ISOLATE / POP DIRECTIONAL ISOLATE (U+2068 / U+2069): `<bdi>` for text inside a sentence. */
const FSI = String.fromCodePoint(0x2068);
const PDI = String.fromCodePoint(0x2069);

export type PunchProblem = 'expired' | 'invalid' | 'noScan' | 'notLinked' | 'forbidden' | 'notEmployed' | 'network' | 'generic';

export type PunchState =
  | { readonly kind: 'working'; readonly step: 'scan' | 'receipt' | 'punch' | 'signin' }
  /** Waiting for the one tap (or, when `receipt.duplicate`, saying it is already recorded). */
  | { readonly kind: 'confirm'; readonly receipt: ReceiptView }
  | { readonly kind: 'done'; readonly result: PunchResultView }
  | { readonly kind: 'problem'; readonly problem: PunchProblem };

/** A failed scan → what to tell the person. */
export function scanProblem(error: unknown): PunchProblem {
  if (!isApiProblemError(error)) return 'generic';
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'network';
  if (error.status === 410) return 'expired';
  if (error.status === 422) return 'invalid';
  return 'generic';
}

/**
 * A failed receipt read or punch → what to tell the person (`null`: the refresh interceptor is already taking them
 * to /login). `knewScan`: the page saw a scan, so a missing receipt means it EXPIRED (« Code expiré ») rather than
 * "no scan in progress".
 */
export function punchProblem(error: unknown, knewScan = false): PunchProblem | null {
  if (!isApiProblemError(error)) return 'generic';
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'network';
  if (error.status === 401) return null;
  if (error.status === 403) return 'forbidden';
  switch (problemSlug(error.problem.type)) {
    case 'attendance-no-scan':
      return knewScan ? 'expired' : 'noScan';
    case 'attendance-not-linked':
      return 'notLinked';
    case 'attendance-not-employed':
      return 'notEmployed';
    case 'attendance-qr-invalid':
      return 'invalid';
    default:
      return 'generic';
  }
}

/**
 * How long the confirmation may wait, in this device's clock. With a scan answered on this page, the receipt's own
 * lifetime counted from when the answer arrived (no clock skew); otherwise (back from sign-in) its end against the
 * device clock, capped at the lifetime. `null`: unknown — let the API decide on the tap.
 */
export function receiptTimeLeft(receipt: ReceiptView, scan: { readonly view: ScanView; readonly at: number } | null, now = Date.now()): number | null {
  const end = Date.parse(receipt.receiptExpiresAt);
  if (scan && scan.view.scannedAt === receipt.scannedAt) {
    return scan.at + (end - Date.parse(receipt.scannedAt)) - now;
  }
  const left = end - now;
  return Number.isFinite(left) && left > 0 ? Math.min(left, RECEIPT_LIFETIME_MS) : null;
}

@Component({
  selector: 'app-punch-page',
  imports: [TranslocoDirective, RouterLink, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './punch.page.html',
  styleUrl: './punch.page.css',
})
export class PunchPage {
  private readonly api = inject(AttendanceApi);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly lang = inject(LanguageService).current;

  protected readonly state = signal<PunchState>({ kind: 'working', step: 'scan' });
  /** The scan answered on THIS page (and when it arrived), if any. */
  private readonly scan = signal<{ readonly view: ScanView; readonly at: number } | null>(null);

  protected readonly entrance = computed(() => {
    const state = this.state();
    const labels =
      state.kind === 'done'
        ? (state.result.punch.kiosk?.labels ?? this.scan()?.view.kiosk.labels)
        : state.kind === 'confirm'
          ? state.receipt.kiosk.labels
          : this.scan()?.view.kiosk.labels;
    return labels ? kioskLabel(labels, this.lang()) : null;
  });

  /** The entrance between FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE (see the template's comment). */
  protected readonly isolatedEntrance = computed(() => {
    const name = this.entrance();
    return name ? FSI + name + PDI : '';
  });

  private readonly confirmButton = viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // `route.fragment` is an Observable that emits the current fragment at once, then every later one. The page must
    // listen, not read the snapshot once: when the phone opens the NEXT code (the departure) while this page is still
    // open on `/punch`, only the fragment differs, so the browser does a same-document navigation — no reload, the
    // router reuses this component and the constructor does not run again. The first emission is the landing (a
    // token, or none when coming back from sign-in); later emissions with a token are new scans. The `null` emitted
    // after `start()` drops the token from the URL is ignored. `takeUntilDestroyed()` (called in the constructor, so
    // it finds the component's `DestroyRef` by itself) ends the subscription with the page.
    let landing = true;
    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((fragment) => {
      if (landing || fragment) void this.start(fragment);
      landing = false;
    });

    // Focus the confirmation button when it appears (and only then: a new element each time the state enters
    // `confirm`, so a second scan while the page is open focuses the new question too).
    let focused: HTMLButtonElement | null = null;
    afterRenderEffect(() => {
      const button = this.confirmButton()?.nativeElement ?? null;
      if (button && button !== focused) button.focus();
      focused = button;
    });

    inject(DestroyRef).onDestroy(() => this.clearExpiry());
  }

  /** The one tap: redeem the receipt. */
  protected confirm(): void {
    void this.punch();
  }

  /** "Réessayer" after a network failure: the receipt (2 min) may still be there, so only the punch is repeated. */
  protected retry(): void {
    void this.punch();
  }

  private async start(fragment: string | null): Promise<void> {
    const token = fragment?.trim() ?? '';
    this.clearExpiry();
    this.state.set({ kind: 'working', step: 'scan' });
    this.scan.set(null);
    if (fragment !== null) {
      // Drop the token from the address bar and from the router's URL before anything can copy it.
      await this.router.navigate([], { relativeTo: this.route, replaceUrl: true });
    }
    if (token) {
      try {
        const view = await firstValueFrom(this.api.scan(token));
        this.scan.set({ view, at: Date.now() });
      } catch (error: unknown) {
        this.state.set({ kind: 'problem', problem: scanProblem(error) });
        return;
      }
    }
    if (!this.session.isAuthenticated()) {
      this.state.set({ kind: 'working', step: 'signin' });
      await this.router.navigate(['/login'], { queryParams: { returnUrl: PUNCH_RETURN_URL }, replaceUrl: true });
      return;
    }
    await this.ask();
  }

  /** Read the receipt, then show the question (or "already recorded"); switch to "expired" when the receipt ends. */
  private async ask(): Promise<void> {
    this.state.set({ kind: 'working', step: 'receipt' });
    let receipt: ReceiptView;
    try {
      receipt = await firstValueFrom(this.api.receipt());
    } catch (error: unknown) {
      const problem = punchProblem(error, this.scan() !== null);
      this.state.set(problem ? { kind: 'problem', problem } : { kind: 'working', step: 'signin' });
      return;
    }
    this.state.set({ kind: 'confirm', receipt });
    if (receipt.duplicate) return;
    const left = receiptTimeLeft(receipt, this.scan());
    if (left === null) return;
    if (left <= 0) {
      this.state.set({ kind: 'problem', problem: 'expired' });
      return;
    }
    this.expiryTimer = setTimeout(() => {
      if (this.state().kind === 'confirm') this.state.set({ kind: 'problem', problem: 'expired' });
    }, left);
  }

  private clearExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private async punch(): Promise<void> {
    this.clearExpiry();
    this.state.set({ kind: 'working', step: 'punch' });
    try {
      const result = await firstValueFrom(this.api.punchSelf());
      this.state.set({ kind: 'done', result });
    } catch (error: unknown) {
      // The page read a receipt before the tap: a missing one now means it expired.
      const problem = punchProblem(error, true);
      this.state.set(problem ? { kind: 'problem', problem } : { kind: 'working', step: 'signin' });
    }
  }
}
