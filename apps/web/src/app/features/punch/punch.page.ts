/**
 * /punch — where the phone lands after its camera read the entrance QR code (docs/contracts/attendance.md › Web ›
 * Punch landing, ADR 009 §3). The code is a link `https://<domain>/punch#<token>`; this page turns it into a punch:
 *
 *   1. read the token from the URL FRAGMENT, then drop it from the address bar;
 *   2. `POST /api/attendance/scan {token}` (public) → the entrance's name + a 5-minute scan RECEIPT, an `httpOnly`
 *      cookie the page never sees;
 *   3. signed out? → `/login?returnUrl=/punch`. After sign-in (and the TOTP code, if any) the login page navigates
 *      back here WITHOUT a token, and…
 *   4. `POST /api/me/attendance/punches` (no body) redeems the receipt: the punch's time is the SCAN's time, so the
 *      minute spent typing a password does not make anyone late. No second scan.
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
 *   holds the state (the receipt cookie, 5 minutes), and the URL holds the way back (`returnUrl=/punch`, validated by
 *   `safeReturnUrl()` on the login page). A reload or a fresh tab after sign-in still works — a component signal or
 *   a root service would not survive the full page load a password manager or an iPhone may cause.
 * - **Ordered async steps with `firstValueFrom()`** — each call depends on the previous one's outcome, so `async`/
 *   `await` reads top to bottom; the result is ONE signal, `state`, a discriminated union the template `@switch`es on.
 * - The route has NO guard (app.routes.ts): a signed-out phone must reach step 2 before being asked to sign in.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import { kioskLabel, type PunchResultView, type ScanView } from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';

export const PUNCH_RETURN_URL = '/punch';

export type PunchProblem = 'expired' | 'invalid' | 'noScan' | 'notLinked' | 'forbidden' | 'notEmployed' | 'network' | 'generic';

export type PunchState =
  | { readonly kind: 'working'; readonly step: 'scan' | 'punch' | 'signin' }
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

/** A failed punch → what to tell the person (`null`: the refresh interceptor is already taking them to /login). */
export function punchProblem(error: unknown): PunchProblem | null {
  if (!isApiProblemError(error)) return 'generic';
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'network';
  if (error.status === 401) return null;
  if (error.status === 403) return 'forbidden';
  switch (problemSlug(error.problem.type)) {
    case 'attendance-no-scan':
      return 'noScan';
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

@Component({
  selector: 'app-punch-page',
  imports: [TranslocoDirective, RouterLink],
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
  /** The entrance the scan named (shown while the punch is being recorded). */
  protected readonly scan = signal<ScanView | null>(null);

  protected readonly entrance = computed(() => {
    const state = this.state();
    const kiosk = state.kind === 'done' ? state.result.punch.kiosk : null;
    const labels = kiosk?.labels ?? this.scan()?.kiosk.labels;
    return labels ? kioskLabel(labels, this.lang()) : null;
  });

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
  }

  /** "Réessayer" after a network failure: the receipt (5 min) is still there, so only the punch is repeated. */
  protected retry(): void {
    void this.punch();
  }

  private async start(fragment: string | null): Promise<void> {
    const token = fragment?.trim() ?? '';
    this.state.set({ kind: 'working', step: 'scan' });
    this.scan.set(null);
    if (fragment !== null) {
      // Drop the token from the address bar and from the router's URL before anything can copy it.
      await this.router.navigate([], { relativeTo: this.route, replaceUrl: true });
    }
    if (token) {
      try {
        this.scan.set(await firstValueFrom(this.api.scan(token)));
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
    await this.punch();
  }

  private async punch(): Promise<void> {
    this.state.set({ kind: 'working', step: 'punch' });
    try {
      const result = await firstValueFrom(this.api.punchSelf());
      this.state.set({ kind: 'done', result });
    } catch (error: unknown) {
      const problem = punchProblem(error);
      this.state.set(problem ? { kind: 'problem', problem } : { kind: 'working', step: 'signin' });
    }
  }
}
