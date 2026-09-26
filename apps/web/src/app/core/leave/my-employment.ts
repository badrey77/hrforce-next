/**
 * MyEmployment — "is this account linked to an employee?" (`GET /api/me/employment`), as app-wide signals.
 *
 * Self-service leave needs BOTH the permission `leave.request_self` AND a linked employment
 * (docs/contracts/leave.md › Links). The permission is in the session; the link is not, so it takes one request.
 * The nav needs the answer (show "My leave" or not) and the /me/leave page needs the employment itself.
 *
 * Angular concepts:
 * - **A resource gated by a permission.** The request function reads `session.can('leave.request_self')`: without
 *   the permission nothing is sent (no pointless 403/404 in the console for HR-only accounts); gaining it (another
 *   sign-in) sends the request. Signing out flips the signal back and the resource goes `idle`.
 * - **Deriving a tri-state from a resource**: `linked` is `true` (200), `false` (404 or any error: fail closed, the
 *   page explains it) or `null` while unknown (loading) — a `computed()` over `status()`/`hasValue()`.
 * - **Why a root service and not the page's own resource?** The nav (always on screen) and the page ask the same
 *   question. One root resource = one request, one answer for both, and a `reload()` both see (e.g. after HR links
 *   the account and the user refreshes the page).
 */
import { computed, Injectable, inject } from '@angular/core';
import { Session } from '../auth/session';
import { LeaveApi } from './leave-api';
import type { MyEmployment as MyEmploymentBody } from './leave.models';

export const SELF_SERVICE_PERMISSION = 'leave.request_self';

@Injectable({ providedIn: 'root' })
export class MyEmployment {
  private readonly session = inject(Session);
  private readonly resource = inject(LeaveApi).myEmploymentResource(() => this.session.can(SELF_SERVICE_PERMISSION));

  /** The linked employment, or `undefined` (not linked / not loaded / no permission). */
  readonly employment = computed<MyEmploymentBody | undefined>(() =>
    this.resource.hasValue() ? this.resource.value() : undefined,
  );
  /** `true` linked · `false` not linked (or no permission) · `null` still asking. */
  readonly linked = computed<boolean | null>(() => {
    if (!this.session.can(SELF_SERVICE_PERMISSION)) return false;
    if (this.resource.hasValue()) return true;
    if (this.resource.error()) return false;
    return null;
  });
  readonly error = computed(() => this.resource.error());

  reload(): void {
    this.resource.reload();
  }
}
