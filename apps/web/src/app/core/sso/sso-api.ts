/**
 * SsoApi — the one place that knows the SSO endpoints (docs/contracts/sso.md › Endpoints): the sign-in handoff
 * (`/api/sso/interactions/:uid/*`) and the administration of connected apps (`/api/sso/clients|roles|assignments`).
 *
 * Same split as core/access/access-api.ts (read its header first):
 * - page reads are `httpResource()`s built from signal-reading functions — they re-fetch when those signals change,
 *   and `undefined` means "send nothing";
 * - writes and the one-shot handoff calls are cold Observables (`HttpClient.get/post/patch/delete`): nothing is sent
 *   until the caller subscribes.
 *
 * What is new here:
 * - **The handoff calls are Observables, not resources**, although `details` is a GET. A resource runs whenever its
 *   signals say so; the handoff page needs ORDERED steps (details → look at the session → complete) and acts on each
 *   answer exactly once, so it awaits them one by one (`firstValueFrom`, features/sso/sso-handoff.page.ts).
 * - **The browser does the binding.** The interaction is bound to THIS browser by an `httpOnly` cookie the provider
 *   set with `Path=/api/sso/interactions/<uid>`: the browser attaches it to exactly these URLs, and this file never
 *   sees it. The uid in the path is `encodeURIComponent`-ed like every id (it is `[A-Za-z0-9_-]`, so it never changes).
 * - **The secret-bearing answers** (`createClient`, `rotateSecret` → `SsoClientCreatedView.clientSecret`) are handed
 *   to the caller and forgotten: no cache, no `shareReplay`, no signal in this root service. A root service lives as
 *   long as the tab; the secret must live only as long as the panel that shows it (features/access/secret-panel.ts).
 */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { LocalizedText } from '../access/access.models';
import type {
  CreateSsoAppRole,
  CreateSsoAssignment,
  CreateSsoClient,
  SsoAppRoleView,
  SsoAssignmentList,
  SsoAssignmentQuery,
  SsoAssignmentView,
  SsoClientCreatedView,
  SsoClientList,
  SsoClientView,
  SsoInteractionView,
  SsoRedirect,
  UpdateSsoClient,
} from './sso.models';

export const SSO_API_BASE = '/api/sso';

function segment(id: string): string {
  return encodeURIComponent(id);
}

@Injectable({ providedIn: 'root' })
export class SsoApi {
  private readonly http = inject(HttpClient);

  // --- Sign-in handoff ------------------------------------------------------------------------------------------

  /** `GET /sso/interactions/:uid/details` (public, needs the interaction cookie) → 200; 404; 409 client unavailable. */
  interactionDetails(uid: string): Observable<SsoInteractionView> {
    return this.http.get<SsoInteractionView>(`${SSO_API_BASE}/interactions/${segment(uid)}/details`);
  }

  /** `POST /sso/interactions/:uid/complete` (signed in + XSRF + interaction cookie) → `{redirectTo}`. */
  completeInteraction(uid: string): Observable<SsoRedirect> {
    return this.http.post<SsoRedirect>(`${SSO_API_BASE}/interactions/${segment(uid)}/complete`, null);
  }

  /** `POST /sso/interactions/:uid/abort` (public + XSRF) → `{redirectTo}`; the app then receives `access_denied`. */
  abortInteraction(uid: string): Observable<SsoRedirect> {
    return this.http.post<SsoRedirect>(`${SSO_API_BASE}/interactions/${segment(uid)}/abort`, null);
  }

  // --- Clients --------------------------------------------------------------------------------------------------

  /** `GET /sso/clients` (`sso.read`) — only while `enabled()`; sorted by name. */
  clientsResource(enabled: () => boolean): HttpResourceRef<SsoClientList | undefined> {
    return httpResource<SsoClientList>(() => (enabled() ? `${SSO_API_BASE}/clients` : undefined));
  }

  /** `GET /sso/clients/:id` — keyed on `id()`; unknown or another company's → 404. */
  clientResource(id: () => string | undefined): HttpResourceRef<SsoClientView | undefined> {
    return httpResource<SsoClientView>(() => {
      const value = id();
      return value ? `${SSO_API_BASE}/clients/${segment(value)}` : undefined;
    });
  }

  /** `POST /sso/clients` → 201 with the secret, shown once. */
  createClient(body: CreateSsoClient): Observable<SsoClientCreatedView> {
    return this.http.post<SsoClientCreatedView>(`${SSO_API_BASE}/clients`, body);
  }

  /** `PATCH /sso/clients/:id` → 200. */
  updateClient(id: string, body: UpdateSsoClient): Observable<SsoClientView> {
    return this.http.patch<SsoClientView>(`${SSO_API_BASE}/clients/${segment(id)}`, body);
  }

  /** `POST /sso/clients/:id/rotate-secret` → 200 with a NEW secret; the old one stops working at once. */
  rotateSecret(id: string): Observable<SsoClientCreatedView> {
    return this.http.post<SsoClientCreatedView>(`${SSO_API_BASE}/clients/${segment(id)}/rotate-secret`, null);
  }

  /** `POST /sso/clients/:id/disable` `{reason}` → 200; 409 `sso-client-disabled`. */
  disableClient(id: string, reason: string): Observable<SsoClientView> {
    return this.http.post<SsoClientView>(`${SSO_API_BASE}/clients/${segment(id)}/disable`, { reason });
  }

  /** `POST /sso/clients/:id/enable` → 200; 409 `sso-client-active`. */
  enableClient(id: string): Observable<SsoClientView> {
    return this.http.post<SsoClientView>(`${SSO_API_BASE}/clients/${segment(id)}/enable`, null);
  }

  // --- App roles ------------------------------------------------------------------------------------------------

  /** `POST /sso/clients/:id/roles` → 201; 409 `sso-role-code-taken` (field `code`). */
  createRole(clientId: string, body: CreateSsoAppRole): Observable<SsoAppRoleView> {
    return this.http.post<SsoAppRoleView>(`${SSO_API_BASE}/clients/${segment(clientId)}/roles`, body);
  }

  /** `PATCH /sso/roles/:roleId` `{names}` → 200 (the code is immutable). */
  updateRole(roleId: string, names: LocalizedText): Observable<SsoAppRoleView> {
    return this.http.patch<SsoAppRoleView>(`${SSO_API_BASE}/roles/${segment(roleId)}`, { names });
  }

  /** `DELETE /sso/roles/:roleId` → 204; 409 `sso-role-in-use`. */
  deleteRole(roleId: string): Observable<void> {
    return this.http.delete<void>(`${SSO_API_BASE}/roles/${segment(roleId)}`);
  }

  // --- Assignments ----------------------------------------------------------------------------------------------

  /** `GET /sso/assignments?clientId=&userId=&roleId=` — `undefined` query = no request (filters are AND-ed). */
  assignmentsResource(query: () => SsoAssignmentQuery | undefined): HttpResourceRef<SsoAssignmentList | undefined> {
    return httpResource<SsoAssignmentList>(() => {
      const value = query();
      if (!value) return undefined;
      const params: Record<string, string> = {};
      if (value.clientId) params['clientId'] = value.clientId;
      if (value.userId) params['userId'] = value.userId;
      if (value.roleId) params['roleId'] = value.roleId;
      return { url: `${SSO_API_BASE}/assignments`, params };
    });
  }

  /** `POST /sso/assignments` → 201; 409 `sso-assign-self` / `sso-assignment-duplicate`; 422 `not_member` / `unknown`. */
  assign(body: CreateSsoAssignment): Observable<SsoAssignmentView> {
    return this.http.post<SsoAssignmentView>(`${SSO_API_BASE}/assignments`, body);
  }

  /** `DELETE /sso/assignments/:id` → 204; 409 `sso-assign-self` (one's own). */
  unassign(id: string): Observable<void> {
    return this.http.delete<void>(`${SSO_API_BASE}/assignments/${segment(id)}`);
  }
}
