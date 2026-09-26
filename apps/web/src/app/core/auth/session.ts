/**
 * Session — who is signed in, as app-wide signals (docs/contracts/identity.md › Web).
 *
 * Angular concepts:
 * - **A root "signal store".** One `@Injectable({ providedIn: 'root' })` service owns a private writable
 *   `signal()` and exposes read-only views of it. The root injector creates exactly one instance, so the shell
 *   header, the guards, the login page and the refresh interceptor all read the SAME state. No NgRx, no
 *   BehaviorSubject: a signal is enough for "one value everybody reads, a few places write".
 * - **`asReadonly()` / `computed()` as the public API.** Components can read `session.user()` but cannot call
 *   `.set()` on it; the only writers are `load()`, `set()` and `clear()`. That keeps "who changed the session?"
 *   answerable by reading this one file.
 * - **`computed()`** derives `user`, `company`, `companies` and `isAuthenticated` from the one `me` signal. Each
 *   recalculates only when `me` changes, and a template that reads `session.user()` re-renders only then
 *   (zoneless change detection is driven by exactly these reads).
 * - **Why a Promise for `load()`.** It is awaited by the app initializer (session-init.ts) before the first
 *   navigation; `firstValueFrom()` turns the one-shot HTTP Observable into a Promise for that.
 *
 * Permissions (docs/contracts/authorization.md › Web). `permissions` and `scopes` are two more `computed()` views
 * of the same `me` signal — no second writable signal that could drift. Two ways to ask "may the user…?":
 * - **`can(code)` — a plain method that READS a signal.** It is not reactive by itself, but whoever calls it inside
 *   a reactive context (a template, a `computed()`, an `effect()`, a guard reading it once) records `permissions`
 *   as a dependency. So `@if (session.can('access.read'))` in a template re-renders when `permissions` changes.
 *   Cost: `permissions` is a new `Set` every time `me` is set, so every template that calls `can()` is re-checked
 *   after every `set()`/`load()`, even when the answer did not change (cheap: one Set lookup per call).
 * - **`allows(code)` — returns a `computed()` for ONE code.** A computed compares its new value with the old one
 *   (`Object.is`): if `true` stays `true`, its consumers are NOT notified. A component that keeps
 *   `readonly canGrant = session.allows('access.grant')` as a FIELD re-renders only when that boolean flips.
 *   Create it once (field initializer), never inside a template expression: `session.allows('x')()` in a template
 *   would build a new computed on every check and gain nothing.
 * Both answer "held anywhere". WHERE (which units) is `scopes`; for record buttons the server's `_actions` is the
 * authority (a permission held elsewhere does not mean it applies to THIS unit).
 */
import { Injectable, type Signal, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from './auth-api';
import type { Me, PermissionScopes, SessionCompany, SessionUser } from './auth.models';

@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(AuthApi);

  /** `null` = signed out (the contract's "`null` = signed out"). */
  private readonly me = signal<Me | null>(null);

  readonly user = computed<SessionUser | null>(() => this.me()?.user ?? null);
  readonly company = computed<SessionCompany | null>(() => this.me()?.company ?? null);
  readonly companies = computed<readonly SessionCompany[]>(() => this.me()?.companies ?? []);
  readonly isAuthenticated = computed(() => this.me() !== null);
  /**
   * Codes held anywhere, as a Set for O(1) lookups. `?? []`: tolerate a `/me` from before the Authorization step
   * (no `permissions` → holds nothing: fail closed).
   */
  readonly permissions = computed<ReadonlySet<string>>(() => new Set(this.me()?.permissions ?? []));
  /** Permission code → units where it applies (empty object when signed out). */
  readonly scopes = computed<PermissionScopes>(() => this.me()?.scopes ?? {});

  /** Does the user hold `code` anywhere? Reads a signal: reactive when called from a template or a computed. */
  can(code: string): boolean {
    return this.permissions().has(code);
  }

  /** A signal of `can(code)` that only notifies when the answer flips. Call once, keep it in a field. */
  allows(code: string): Signal<boolean> {
    return computed(() => this.can(code));
  }

  /**
   * `GET /api/me`. Success → signed in. Any failure (401 after a failed refresh, network, 5xx) → signed out:
   * the guards then send the user to /login, which is the only screen that can fix it. Never rejects, so the
   * app initializer cannot block bootstrap.
   */
  async load(): Promise<void> {
    try {
      this.me.set(await firstValueFrom(this.api.me()));
    } catch {
      this.me.set(null);
    }
  }

  /** Signed in with this `/api/me` body (tests and `load()`). */
  set(me: Me): void {
    this.me.set(me);
  }

  /** Signed out locally (after logout, a failed refresh, or a password setup that revoked every session). */
  clear(): void {
    this.me.set(null);
  }
}
