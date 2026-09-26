/**
 * AccessApi — the one place that knows the Authorization endpoints (docs/contracts/authorization.md).
 *
 * Same split as core/org/org-api.ts (read that header first):
 * - page reads are `httpResource()`s built from signal-reading functions (re-fetch when the signals change,
 *   `undefined` = no request);
 * - writes are Observables (`HttpClient.post/patch`): nothing is sent until the caller subscribes.
 *
 * New here: **booleans in query params.** `HttpParams` only holds strings, so `includeEnded` is sent as the string
 * `'true'` — and left out entirely when false, which the API reads as the default (`false`). Sending `'false'`
 * would also work, but "absent = default" keeps URLs short and matches how the other filters behave.
 */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  AccessUserList,
  CreateGrant,
  CreateRole,
  GrantList,
  GrantQuery,
  GrantView,
  PermissionList,
  Role,
  RoleList,
  UpdateRole,
} from './access.models';

export const ACCESS_API_BASE = '/api/access';

@Injectable({ providedIn: 'root' })
export class AccessApi {
  private readonly http = inject(HttpClient);

  /** `GET /access/permissions` — only while `enabled()` is true (the caller holds `access.read`). */
  permissionsResource(enabled: () => boolean): HttpResourceRef<PermissionList | undefined> {
    return httpResource<PermissionList>(() => (enabled() ? `${ACCESS_API_BASE}/permissions` : undefined));
  }

  /**
   * `GET /access/roles` for a company. `companyId()` is only a trigger: roles are per company, so a new company id
   * (another sign-in) re-fetches; `undefined` (signed out, or no `access.read`) sends nothing.
   */
  rolesResource(companyId: () => string | undefined): HttpResourceRef<RoleList | undefined> {
    return httpResource<RoleList>(() => (companyId() ? `${ACCESS_API_BASE}/roles` : undefined));
  }

  /** `GET /access/users?q=` — members of the company; a blank `q` lists everyone the caller may see. */
  usersResource(q: () => string | undefined): HttpResourceRef<AccessUserList | undefined> {
    return httpResource<AccessUserList>(() => {
      const text = q()?.trim();
      const params: Record<string, string> = text ? { q: text } : {};
      return { url: `${ACCESS_API_BASE}/users`, params };
    });
  }

  /** `GET /access/grants?userId=&unitId=&includeEnded=` — `undefined` query = no request. */
  grantsResource(query: () => GrantQuery | undefined): HttpResourceRef<GrantList | undefined> {
    return httpResource<GrantList>(() => {
      const value = query();
      if (!value) return undefined;
      const params: Record<string, string> = {};
      if (value.userId) params['userId'] = value.userId;
      if (value.unitId) params['unitId'] = value.unitId;
      if (value.includeEnded) params['includeEnded'] = 'true';
      return { url: `${ACCESS_API_BASE}/grants`, params };
    });
  }

  /** `POST /access/roles` → 201 Role. */
  createRole(body: CreateRole): Observable<Role> {
    return this.http.post<Role>(`${ACCESS_API_BASE}/roles`, body);
  }

  /** `PATCH /access/roles/:id` → 200 Role. */
  updateRole(id: string, body: UpdateRole): Observable<Role> {
    return this.http.patch<Role>(`${ACCESS_API_BASE}/roles/${encodeURIComponent(id)}`, body);
  }

  /** `POST /access/grants` → 201 GrantView. */
  createGrant(body: CreateGrant): Observable<GrantView> {
    return this.http.post<GrantView>(`${ACCESS_API_BASE}/grants`, body);
  }

  /** `POST /access/grants/:id/end` with `{ validTo }` → 200 GrantView. A grant is never deleted, only ended. */
  endGrant(id: string, validTo: string): Observable<GrantView> {
    return this.http.post<GrantView>(`${ACCESS_API_BASE}/grants/${encodeURIComponent(id)}/end`, { validTo });
  }
}
