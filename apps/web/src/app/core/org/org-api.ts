/**
 * OrgApi — the one place that knows the Organization endpoints (`docs/contracts/organization.md`).
 *
 * Angular concepts:
 * - `@Injectable({ providedIn: 'root' })` registers ONE shared instance of this class with the application's
 *   root injector. Nothing has to list it in `providers`; the first `inject(OrgApi)` creates it, and an unused
 *   service is tree-shaken out of the bundle.
 * - `inject(HttpClient)` asks dependency injection (DI) for the HTTP client configured in `app.config.ts`
 *   (fetch backend, XSRF header, `apiProblemInterceptor`). `inject()` only works in an "injection context":
 *   a constructor or a field initializer of something DI creates. Field initializers are the modern style.
 * - Two ways to read data, on purpose:
 *   1. `HttpClient` methods return RxJS **Observables**. Nothing is sent until someone subscribes, and
 *      unsubscribing aborts the request. Used for writes (POST/PATCH) and for the picker's search, where
 *      RxJS operators (`debounceTime`, `switchMap`) do the heavy lifting.
 *   2. `httpResource()` (stable since Angular 22) turns a *signal-driven* request into a **resource**:
 *      you give it a function that builds the request from signals; Angular re-runs it whenever those signals
 *      change, cancels the in-flight request if a newer one starts, and exposes the result as signals —
 *      `value()`, `status()`, `isLoading()`, `error()`, `hasValue()` — plus `reload()`. Returning `undefined`
 *      from the function means "no request" (status `idle`). Used for page reads (tree, unit detail).
 *
 * `*Resource()` methods create an `httpResource`, which itself calls `inject()`. Call them from an injection
 * context — typically a component field initializer: `tree = inject(OrgApi).treeResource(this.asOf)`.
 * The resource then lives as long as that component and is destroyed with it.
 */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  ChangeOrgUnit,
  CreateOrgUnit,
  OrgTree,
  OrgUnitDetail,
  OrgUnitSearch,
  OrgUnitSearchResult,
} from './org.models';

export const ORG_API_BASE = '/api/org';

/** URL of one unit; ids are UUIDs, encoding is defensive. */
export function orgUnitUrl(id: string): string {
  return `${ORG_API_BASE}/units/${encodeURIComponent(id)}`;
}

@Injectable({ providedIn: 'root' })
export class OrgApi {
  private readonly http = inject(HttpClient);

  /**
   * `GET /org/tree?asOf=` as a resource. `asOf` is a signal (or any function reading signals):
   * each new date triggers a new request; `undefined` leaves the resource idle.
   */
  treeResource(asOf: () => string | undefined): HttpResourceRef<OrgTree | undefined> {
    // `httpResource<T>(fn)`: `fn` runs in a reactive context, so reading `asOf()` here subscribes to it.
    return httpResource<OrgTree>(() => {
      const date = asOf();
      return date === undefined ? undefined : { url: `${ORG_API_BASE}/tree`, params: { asOf: date } };
    });
  }

  /** `GET /org/units/:id` as a resource; a `null` id (nothing selected) means no request. */
  unitResource(id: () => string | null | undefined): HttpResourceRef<OrgUnitDetail | undefined> {
    return httpResource<OrgUnitDetail>(() => {
      const unitId = id();
      return unitId ? orgUnitUrl(unitId) : undefined;
    });
  }

  /** `GET /org/units` — flat search (q matches code or name). Empty values are left out of the query. */
  search(query: OrgUnitSearch): Observable<OrgUnitSearchResult> {
    const params: Record<string, string> = {};
    if (query.q?.trim()) params['q'] = query.q.trim();
    if (query.kind) params['kind'] = query.kind;
    if (query.asOf) params['asOf'] = query.asOf;
    return this.http.get<OrgUnitSearchResult>(`${ORG_API_BASE}/units`, { params });
  }

  /** `GET /org/units/:id` as a one-shot Observable (used by the picker to label a preset value). */
  get(id: string): Observable<OrgUnitDetail> {
    return this.http.get<OrgUnitDetail>(orgUnitUrl(id));
  }

  /** `POST /org/units` → 201 with the created unit. */
  create(body: CreateOrgUnit): Observable<OrgUnitDetail> {
    return this.http.post<OrgUnitDetail>(`${ORG_API_BASE}/units`, body);
  }

  /** `PATCH /org/units/:id` → 200 with the unit's new state. */
  change(id: string, body: ChangeOrgUnit): Observable<OrgUnitDetail> {
    return this.http.patch<OrgUnitDetail>(orgUnitUrl(id), body);
  }
}
