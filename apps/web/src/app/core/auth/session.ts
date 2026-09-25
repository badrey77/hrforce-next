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
 */
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from './auth-api';
import type { Me, SessionCompany, SessionUser } from './auth.models';

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
