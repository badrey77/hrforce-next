/**
 * EmployeesApi — the one place that knows the Employment endpoints (`docs/contracts/employment.md` › Endpoints).
 *
 * Same split as core/org/org-api.ts (read that header first): page reads are signal-driven `httpResource`s,
 * writes are one-shot Observables the forms subscribe to.
 *
 * Angular concepts:
 * - **A resource keyed on a whole query object.** `listResource(query)` takes a function returning the resolved
 *   `EmployeeQuery` (in the list page: a `computed()` of the URL's query params). The request function reads it,
 *   so ANY change — a new search text, a sort click, page 3 — builds a new request, and a request still in flight
 *   is cancelled. The page never calls "fetch"; it only changes the URL.
 *   A `computed()` that returns a NEW object with the SAME content still counts as a change (objects compare by
 *   reference) — harmless here because `computed()` only re-runs when one of its inputs changed.
 * - **Params built by a pure function** (`employeeListParams`): what is sent is decided in plain TypeScript, unit
 *   tested without TestBed, and the resource only wires it to signals. Empty filters are LEFT OUT (the API applies
 *   its defaults); sort, direction and paging are always sent so the server and the URL cannot disagree.
 * - `httpResource` needs an injection context: call the `…Resource()` methods from a field initializer.
 */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import {
  type CreateEmployee,
  DEFAULT_EMPLOYEE_QUERY,
  type EmployeeDetail,
  type EmployeePage,
  type EmployeeQuery,
  type EndEmployment,
  type NewAssignment,
  type NewSalary,
  type PersonInput,
} from './employees.models';

export const EMPLOYEES_API_BASE = '/api/employees';

export function employeeUrl(id: string, suffix = ''): string {
  return `${EMPLOYEES_API_BASE}/${encodeURIComponent(id)}${suffix}`;
}

/** Query params of `GET /employees` for a resolved query. */
export function employeeListParams(query: EmployeeQuery): Record<string, string> {
  const params: Record<string, string> = {};
  const q = query.q.trim();
  if (q) params['q'] = q;
  if (query.unitId) {
    params['unitId'] = query.unitId;
    params['includeSubUnits'] = String(query.includeSubUnits);
  }
  if (query.siteId) params['siteId'] = query.siteId;
  params['status'] = query.status;
  if (query.asOf) params['asOf'] = query.asOf;
  params['sort'] = query.sort;
  params['dir'] = query.dir;
  params['page'] = String(query.page);
  params['pageSize'] = String(query.pageSize);
  return params;
}

@Injectable({ providedIn: 'root' })
export class EmployeesApi {
  private readonly http = inject(HttpClient);

  /** `GET /employees` as a resource; `undefined` from `query` = no request. */
  listResource(query: () => EmployeeQuery | undefined): HttpResourceRef<EmployeePage | undefined> {
    return httpResource<EmployeePage>(() => {
      const value = query();
      return value ? { url: EMPLOYEES_API_BASE, params: employeeListParams(value) } : undefined;
    });
  }

  /** `GET /employees/:id` as a resource keyed on the route param. */
  detailResource(id: () => string | null | undefined): HttpResourceRef<EmployeeDetail | undefined> {
    return httpResource<EmployeeDetail>(() => {
      const value = id();
      return value ? employeeUrl(value) : undefined;
    });
  }

  /**
   * `GET /employees?q=` as a one-shot Observable, for the employee picker (shared/employee-picker): the picker drives
   * it from an RxJS `debounceTime`/`switchMap` pipeline, like the org-unit picker's search. Active employees only,
   * first 10 by name.
   */
  search(q: string, pageSize = 10): Observable<EmployeePage> {
    const params = employeeListParams({ ...DEFAULT_EMPLOYEE_QUERY, q, pageSize });
    return this.http.get<EmployeePage>(EMPLOYEES_API_BASE, { params });
  }

  /** `GET /employees/:id` as a one-shot Observable (the picker labels a preset value). */
  get(id: string): Observable<EmployeeDetail> {
    return this.http.get<EmployeeDetail>(employeeUrl(id));
  }

  /** `POST /employees` → 201 with the detail (and a Location header). */
  create(body: CreateEmployee): Observable<EmployeeDetail> {
    return this.http.post<EmployeeDetail>(EMPLOYEES_API_BASE, body);
  }

  /** `PATCH /employees/:id/person`. */
  updatePerson(id: string, body: Partial<PersonInput>): Observable<EmployeeDetail> {
    return this.http.patch<EmployeeDetail>(employeeUrl(id, '/person'), body);
  }

  /** `POST /employees/:id/assignments` — closes the current assignment the day before `validFrom`. */
  assign(id: string, body: NewAssignment): Observable<EmployeeDetail> {
    return this.http.post<EmployeeDetail>(employeeUrl(id, '/assignments'), body);
  }

  /** `POST /employees/:id/end`. */
  end(id: string, body: EndEmployment): Observable<EmployeeDetail> {
    return this.http.post<EmployeeDetail>(employeeUrl(id, '/end'), body);
  }

  /** `PUT /employees/:id/salary` — a new salary version. */
  setSalary(id: string, body: NewSalary): Observable<EmployeeDetail> {
    return this.http.put<EmployeeDetail>(employeeUrl(id, '/salary'), body);
  }

  /** `PUT /employees/:id/bank`. */
  setBank(id: string, body: { rib: string | null; bankName: string | null }): Observable<EmployeeDetail> {
    return this.http.put<EmployeeDetail>(employeeUrl(id, '/bank'), body);
  }

  /** `PUT /employees/:id/nss`. */
  setNss(id: string, body: { nss: string | null }): Observable<EmployeeDetail> {
    return this.http.put<EmployeeDetail>(employeeUrl(id, '/nss'), body);
  }
}
