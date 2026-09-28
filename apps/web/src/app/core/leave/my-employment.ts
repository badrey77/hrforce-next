/**
 * MyEmployment — "is this account linked to an employee?" (`GET /api/me/employment`), as app-wide signals.
 *
 * Self-service needs BOTH a permission AND a linked employment: `leave.request_self` for My leave
 * (docs/contracts/leave.md › Links), `document.request_self` for My documents (docs/contracts/documents.md › Web). The
 * permissions are in the session; the link is not, so it takes one request. The nav needs the answer (show the links
 * or not) and the /me/leave and /me/documents pages need the employment itself.
 *
 * Angular concepts:
 * - **A resource gated by a permission.** The request function reads `session.can(…)` for the self-service
 *   permissions: without one of them nothing is sent (no pointless 403/404 in the console for HR-only accounts);
 *   gaining one (another sign-in) sends the request. Signing out flips the signal back and the resource goes `idle`.
 * - **Deriving a tri-state from a resource**: `linked` is `true` (200), `false` (404 or any error: fail closed, the
 *   page explains it) or `null` while unknown (loading) — a `computed()` over `status()`/`hasValue()`.
 * - **Why a root service and not the page's own resource?** The nav (always on screen) and two pages ask the same
 *   question. One root resource = one request, one answer for all, and a `reload()` all see (e.g. after HR links
 *   the account and the user refreshes the page). Each nav link adds its OWN permission to `linked()` (app.ts): the
 *   link is shared, the permissions are not.
 */
import { computed, Injectable, inject } from '@angular/core';
import { Session } from '../auth/session';
import { LeaveApi } from './leave-api';
import type { MyEmployment as MyEmploymentBody } from './leave.models';

export const SELF_SERVICE_PERMISSION = 'leave.request_self';
export const DOCUMENT_SELF_SERVICE_PERMISSION = 'document.request_self';

@Injectable({ providedIn: 'root' })
export class MyEmployment {
  private readonly session = inject(Session);
  private readonly anySelfService = computed(
    () => this.session.can(SELF_SERVICE_PERMISSION) || this.session.can(DOCUMENT_SELF_SERVICE_PERMISSION),
  );
  private readonly resource = inject(LeaveApi).myEmploymentResource(() => this.anySelfService());

  /** The linked employment, or `undefined` (not linked / not loaded / no permission). */
  readonly employment = computed<MyEmploymentBody | undefined>(() =>
    this.resource.hasValue() ? this.resource.value() : undefined,
  );
  /** `true` linked · `false` not linked (or no self-service permission) · `null` still asking. */
  readonly linked = computed<boolean | null>(() => {
    if (!this.anySelfService()) return false;
    if (this.resource.hasValue()) return true;
    if (this.resource.error()) return false;
    return null;
  });
  readonly error = computed(() => this.resource.error());

  reload(): void {
    this.resource.reload();
  }
}
