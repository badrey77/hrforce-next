/**
 * `/sso/:uid` — the sign-in HANDOFF page of HRForce's OpenID Connect provider (docs/contracts/sso.md › Sign-in flow,
 * ADR 007 §3). A connected app (e.g. apps/sso-demo) sends the browser to `/oidc/auth?…`; the provider records the
 * request as an "interaction" and sends the browser here (through `/api/sso/interactions/<uid>`, only for its cookie
 * path). This page is the bridge between that interaction and HRForce's own sign-in:
 *
 *   1. `GET …/details` — which app is asking (the interaction cookie binds it to THIS browser);
 *   2. signed out → `/login?returnUrl=/sso/<uid>`: the normal login page, second factor included, comes back here;
 *      two-step sign-in required but not set up → the enrollment wizard, which also comes back here;
 *      the app wants a fresh sign-in → sign out, then the same login round trip (automatic);
 *   3. signed in → `POST …/complete` → `{redirectTo}` → a FULL navigation there (`location.assign`): the provider
 *      finishes and redirects to the app with its code. With a live HRForce session this is silent: the person sees
 *      « Connexion à « app »… » for a moment and lands in the app.
 *   Errors (expired request, disabled app, account without access, disabled account) get a message and, when the
 *   app is known, « Retourner à l'application » (`POST …/abort` → the app receives `access_denied`).
 *
 * Angular concepts:
 * - **A route with no guard and no app chrome** (app.routes.ts: `data: { chrome: false }`, read by app.ts, chapter
 *   20). It must work signed OUT (like `/punch`) — a guard would send the visitor to /login before the page could say
 *   which app is asking. The page makes the session decision itself, AFTER loading the details. It imports the
 *   `LanguageSwitcher` from the shell, because the chrome that normally carries it is hidden.
 * - **`effect()` keyed on a route param input.** `uid = input.required<string>()` (withComponentInputBinding). The
 *   effect reads `uid()` and starts the flow; if the router reuses this component for another uid (a second app
 *   asking while the page is open), the effect runs again. `untracked()` keeps every signal the flow reads (session,
 *   state) from becoming a dependency: only a new uid restarts it. A run counter drops answers of a stale run.
 * - **Reading the session signal ONCE, at the right step.** `Session` was filled by the app initializer before the
 *   first navigation (chapter 11), and after the login round trip the login page reloaded it before navigating here.
 *   So `session.isAuthenticated()` read after `details` is already the answer; no `effect()` watching it is needed —
 *   the page acts once per interaction, and a later sign-out elsewhere must not re-trigger a sign-in.
 * - **Ordered async steps with `firstValueFrom()`** (chapter 20 › punch): each step depends on the previous answer.
 *   ONE `state` signal (a discriminated union) drives the template's `@switch`.
 * - **Leaving the SPA**: `PAGE_LOCATION.assign(redirectTo)` (core/browser/page-location.ts), never `router.navigate`
 *   — the router only knows this app's routes. `redirectTo` is checked to be an `http(s)` URL under `/oidc/` first
 *   (the API already asserts it; a page that hands the browser to a URL checks what it hands over).
 * - **The interceptors do their usual jobs here too**: a 401 from `complete` goes through the refresh interceptor
 *   (refresh once, retry; if the session is dead it navigates to `/login?returnUrl=/sso/<uid>` — `router.url` is this
 *   page); a 403 `mfa-enrollment-required` the session did not predict goes through `mfaEnrollmentInterceptor`, which
 *   reloads the session and opens the wizard with `returnUrl=/sso/<uid>`. When the session ALREADY says "must enrol",
 *   that interceptor leaves the redirect to `mfaEnrollmentGuard` — which this unguarded route does not have — so the
 *   page sends the person to the wizard itself before calling `complete` (same `enrollmentUrlTree()`).
 * - **`replaceUrl: true`** on the redirects to /login: Back from the login page leaves the flow instead of landing
 *   here again (which would only redirect to /login once more).
 * - The page never shows the uid (contract), and the app name comes from the API, never from the URL.
 */
import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../../core/auth/auth-api';
import { enrollmentUrlTree } from '../../core/auth/mfa-enrollment';
import { Session } from '../../core/auth/session';
import { PAGE_LOCATION } from '../../core/browser/page-location';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { SsoApi } from '../../core/sso/sso-api';
import { type SsoInteractionView, ssoAppName } from '../../core/sso/sso.models';
import { LanguageSwitcher } from '../../shell/language-switcher';

/** Unicode FIRST STRONG ISOLATE / POP DIRECTIONAL ISOLATE: an app name inside a translated sentence (see punch.page.ts). */
const FSI = String.fromCodePoint(0x2068);
const PDI = String.fromCodePoint(0x2069);

type Client = SsoInteractionView['client'];

/** What went wrong, from the person's point of view. */
export type HandoffProblem = 'expired' | 'unavailable' | 'notMember' | 'disabled' | 'fresh' | 'network' | 'generic';

export type HandoffState =
  | { readonly kind: 'working'; readonly step: 'loading' | 'signin' | 'fresh' | 'leaving'; readonly client: Client | null }
  | { readonly kind: 'completing'; readonly client: Client }
  | { readonly kind: 'problem'; readonly problem: HandoffProblem; readonly client: Client | null };

/** Where a failed `details` / `complete` / `abort` leads (`null`: an interceptor is already navigating away). */
export function handoffProblem(error: unknown): HandoffProblem | 'freshLogin' | null {
  if (!isApiProblemError(error)) return 'generic';
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'network';
  switch (problemSlug(error.problem.type)) {
    case 'sso-interaction-not-found':
      return 'expired';
    case 'sso-client-unavailable':
      return 'unavailable';
    case 'sso-not-member':
      return 'notMember';
    case 'account-disabled':
      return 'disabled';
    case 'sso-fresh-login-required':
      return 'freshLogin';
    case 'mfa-enrollment-required':
      return null; // mfaEnrollmentInterceptor opens the wizard (returnUrl = this page)
  }
  if (error.status === 401) return null; // the refresh interceptor refreshes, or sends the visitor to /login
  if (error.status === 404) return 'expired';
  return 'generic';
}

/**
 * The provider's resume URL (`<issuer>/auth/<uid>`) must be an http(s) URL under `/oidc/`. Anything else is refused
 * rather than followed (defence in depth: the API asserts the same).
 */
export function isProviderUrl(value: unknown, base: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value, base);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.pathname.startsWith('/oidc/');
  } catch {
    return false;
  }
}

@Component({
  selector: 'app-sso-handoff-page',
  imports: [TranslocoDirective, RouterLink, LanguageSwitcher],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sso-handoff.page.html',
  styleUrl: './sso-handoff.page.css',
})
export class SsoHandoffPage {
  private readonly api = inject(SsoApi);
  private readonly auth = inject(AuthApi);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly location = inject(PAGE_LOCATION);
  private readonly document = inject(DOCUMENT);
  private readonly languages = inject(LanguageService);
  protected readonly lang = this.languages.current;

  /** `:uid` of the route (the interaction id). Never rendered. */
  readonly uid = input.required<string>();
  /** `?fresh=1`: this visit follows a sign-out asked by the app (a second "fresh sign-in required" must not loop). */
  readonly fresh = input<string>();

  protected readonly state = signal<HandoffState>({ kind: 'working', step: 'loading', client: null });
  /** The app's name in the UI language, isolated for use inside a sentence (`null` while unknown). */
  protected readonly appName = computed(() => {
    const client = this.state().client;
    return client ? `${FSI}${ssoAppName(client, this.lang())}${PDI}` : null;
  });
  protected readonly accountName = computed(() => this.session.user()?.displayName ?? null);

  /** Incremented by each run; an answer from an older run is ignored. */
  private run = 0;

  constructor() {
    effect(() => {
      const uid = this.uid();
      untracked(() => void this.start(uid));
    });
  }

  /** Try again after a network or unexpected error: the whole flow from the details. */
  protected retry(): void {
    void this.start(this.uid());
  }

  /** « Retourner à l'application »: cancel the sign-in; the app receives `error=access_denied`. */
  protected async backToApp(): Promise<void> {
    const run = this.run;
    const client = this.state().client;
    this.state.set({ kind: 'working', step: 'leaving', client });
    try {
      const { redirectTo } = await firstValueFrom(this.api.abortInteraction(this.uid()));
      if (run !== this.run) return;
      this.leave(redirectTo, client);
    } catch (error: unknown) {
      if (run !== this.run) return;
      const problem = handoffProblem(error);
      this.state.set({ kind: 'problem', problem: problem === 'expired' ? 'expired' : problem === 'network' ? 'network' : 'generic', client });
    }
  }

  /** « Changer de compte »: sign out of HRForce, then sign in again for this same request. */
  protected switchAccount(): void {
    void this.signOutAndSignIn(this.run, this.state().client, 'signin');
  }

  private async start(uid: string): Promise<void> {
    const run = ++this.run;
    this.state.set({ kind: 'working', step: 'loading', client: null });

    let details: SsoInteractionView;
    try {
      details = await firstValueFrom(this.api.interactionDetails(uid));
    } catch (error: unknown) {
      if (run === this.run) this.fail(error, null);
      return;
    }
    if (run !== this.run) return;
    const client = details.client;

    if (!this.session.isAuthenticated()) {
      // the sign-in page in the app's language (ui_locales), unless this device already has a chosen language; the
      // account's own locale takes over after sign-in
      this.languages.applyLanguageHint(details.uiLocales ?? []);
      this.state.set({ kind: 'working', step: 'signin', client });
      await this.toLogin(uid, false);
      return;
    }
    if (details.freshLoginRequired) {
      await this.freshLogin(run, client);
      return;
    }
    if (this.session.mfaEnrollmentRequired()) {
      // No guard on this route: do what mfaEnrollmentGuard does elsewhere (see the header).
      this.state.set({ kind: 'working', step: 'signin', client });
      await this.router.navigateByUrl(enrollmentUrlTree(this.router, this.returnUrl(uid, false)), { replaceUrl: true });
      return;
    }

    this.state.set({ kind: 'completing', client });
    try {
      const { redirectTo } = await firstValueFrom(this.api.completeInteraction(uid));
      if (run !== this.run) return;
      this.leave(redirectTo, client);
    } catch (error: unknown) {
      if (run === this.run) this.fail(error, client);
    }
  }

  private fail(error: unknown, client: Client | null): void {
    const problem = handoffProblem(error);
    if (problem === null) return; // an interceptor is taking the visitor elsewhere; keep the neutral state
    if (problem === 'freshLogin') {
      void this.freshLogin(this.run, client);
      return;
    }
    this.state.set({ kind: 'problem', problem, client });
  }

  /** The app asked for a fresh sign-in: say so, sign out, sign in again (automatic) — once. */
  private async freshLogin(run: number, client: Client | null): Promise<void> {
    if (this.fresh() === '1') {
      // Already signed in again for this request and still "not fresh enough": stop instead of looping.
      this.state.set({ kind: 'problem', problem: 'fresh', client });
      return;
    }
    await this.signOutAndSignIn(run, client, 'fresh');
  }

  private async signOutAndSignIn(run: number, client: Client | null, step: 'signin' | 'fresh'): Promise<void> {
    this.state.set({ kind: 'working', step, client });
    try {
      await firstValueFrom(this.auth.logout());
    } catch {
      // Signed out locally anyway (as the user menu does); the login page will ask for the password.
    }
    if (run !== this.run) return;
    this.session.clear();
    await this.toLogin(this.uid(), step === 'fresh');
  }

  private returnUrl(uid: string, fresh: boolean): string {
    return `/sso/${encodeURIComponent(uid)}${fresh ? '?fresh=1' : ''}`;
  }

  private async toLogin(uid: string, fresh: boolean): Promise<void> {
    await this.router.navigate(['/login'], { queryParams: { returnUrl: this.returnUrl(uid, fresh) }, replaceUrl: true });
  }

  private leave(redirectTo: string, client: Client | null): void {
    if (!isProviderUrl(redirectTo, this.document.baseURI)) {
      this.state.set({ kind: 'problem', problem: 'generic', client });
      return;
    }
    this.location.assign(redirectTo);
  }
}
