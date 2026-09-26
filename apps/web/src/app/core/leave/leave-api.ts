/**
 * LeaveApi — the one place that knows the Leave endpoints (`docs/contracts/leave.md` › Endpoints).
 *
 * Same split as core/org/org-api.ts and core/employees/employees-api.ts (read those headers first): page reads are
 * signal-driven `httpResource`s, writes are one-shot Observables the forms subscribe to.
 *
 * Angular concepts:
 * - **A POST that is a READ: `previewResource()`.** `POST /leave/preview` changes nothing on the server — it counts
 *   the days of a request that does not exist yet. It is a POST only because its input is a whole request body
 *   (type, dates, half days) rather than a resource id. What matters for the UI is the *semantics*, not the verb: the
 *   answer depends only on the input, sending it twice is harmless, and a newer input makes an older answer useless.
 *   That is exactly what `httpResource` models, so the preview is a resource like any GET: `httpResource` accepts a
 *   request object with `method: 'POST'` and a `body`. When the body signal changes, the resource cancels the request
 *   still in flight (HttpClient aborts it) and sends the new one; `value()` only ever holds the answer to the LATEST
 *   input. (A real write — `requestSelf()` — stays an Observable the form subscribes to exactly once.)
 * - **XSRF still applies.** A resource goes through the same `HttpClient` and interceptors as `http.post()`, so the
 *   preview carries `X-XSRF-TOKEN` like any unsafe method (CONVENTIONS.md › Web).
 * - **Params built by a pure function** (`leaveListParams`) as for employees: empty filters are left out, paging is
 *   always sent.
 * - `…Resource()` methods create an `httpResource`, which itself calls `inject()`: call them from a field
 *   initializer (an injection context).
 */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { employeeUrl } from '../employees/employees-api';
import type {
  BalanceList,
  HolidayInput,
  HolidayList,
  LeaveAdjustment,
  LeavePolicy,
  LeavePreview,
  LeavePreviewRequest,
  LeaveQuery,
  LeaveRequestDetail,
  LeaveRequestList,
  LeaveRequestPage,
  LeaveType,
  LeaveTypeList,
  LedgerList,
  MyEmployment,
  NewLeaveRequest,
  PublicHoliday,
  UpdateLeaveType,
} from './leave.models';

export const LEAVE_API_BASE = '/api/leave';
export const ME_API_BASE = '/api/me';

const enc = encodeURIComponent;

/** Query params of `GET /leave/requests` for a resolved query. */
export function leaveListParams(query: LeaveQuery): Record<string, string> {
  const params: Record<string, string> = {};
  const q = query.q.trim();
  if (q) params['q'] = q;
  if (query.status !== 'all') params['status'] = query.status;
  if (query.unitId) {
    params['unitId'] = query.unitId;
    params['includeSubUnits'] = String(query.includeSubUnits);
  }
  if (query.typeId) params['typeId'] = query.typeId;
  if (query.from) params['from'] = query.from;
  if (query.to) params['to'] = query.to;
  params['page'] = String(query.page);
  params['pageSize'] = String(query.pageSize);
  return params;
}

@Injectable({ providedIn: 'root' })
export class LeaveApi {
  private readonly http = inject(HttpClient);

  // --- Reference data ---------------------------------------------------------------------------------------------

  /** `GET /leave/types` — no signal read: one request for the resource's lifetime (LeaveCatalog keeps one per app). */
  typesResource(enabled: () => boolean = () => true): HttpResourceRef<LeaveTypeList | undefined> {
    return httpResource<LeaveTypeList>(() => (enabled() ? `${LEAVE_API_BASE}/types` : undefined));
  }

  /** `GET /leave/holidays?year=` — a new year re-fetches. */
  holidaysResource(year: () => number | undefined): HttpResourceRef<HolidayList | undefined> {
    return httpResource<HolidayList>(() => {
      const value = year();
      return value === undefined ? undefined : { url: `${LEAVE_API_BASE}/holidays`, params: { year: value } };
    });
  }

  /** `GET /leave/policy` (the contract lists only the PUT; the settings page needs the current values). */
  policyResource(): HttpResourceRef<LeavePolicy | undefined> {
    return httpResource<LeavePolicy>(() => `${LEAVE_API_BASE}/policy`);
  }

  updateType(id: string, body: UpdateLeaveType): Observable<LeaveType> {
    return this.http.put<LeaveType>(`${LEAVE_API_BASE}/types/${enc(id)}`, body);
  }

  createHoliday(body: HolidayInput): Observable<PublicHoliday> {
    return this.http.post<PublicHoliday>(`${LEAVE_API_BASE}/holidays`, body);
  }

  updateHoliday(id: string, body: HolidayInput): Observable<PublicHoliday> {
    return this.http.put<PublicHoliday>(`${LEAVE_API_BASE}/holidays/${enc(id)}`, body);
  }

  deleteHoliday(id: string): Observable<void> {
    return this.http.delete<void>(`${LEAVE_API_BASE}/holidays/${enc(id)}`);
  }

  updatePolicy(body: LeavePolicy): Observable<LeavePolicy> {
    return this.http.put<LeavePolicy>(`${LEAVE_API_BASE}/policy`, body);
  }

  // --- Self-service -----------------------------------------------------------------------------------------------

  /** `GET /me/employment` — 404 when the account has no linked employment. `enabled` false → no request. */
  myEmploymentResource(enabled: () => boolean): HttpResourceRef<MyEmployment | undefined> {
    return httpResource<MyEmployment>(() => (enabled() ? `${ME_API_BASE}/employment` : undefined));
  }

  /** `GET /me/leave/balances?asOf=` — only while `enabled()` (the account is linked). */
  myBalancesResource(
    enabled: () => boolean,
    asOf: () => string | undefined = () => undefined,
  ): HttpResourceRef<BalanceList | undefined> {
    return httpResource<BalanceList>(() => {
      if (!enabled()) return undefined;
      const date = asOf();
      const params: Record<string, string> = date ? { asOf: date } : {};
      return { url: `${ME_API_BASE}/leave/balances`, params };
    });
  }

  /** `GET /me/leave/requests` (newest first). */
  myRequestsResource(enabled: () => boolean = () => true): HttpResourceRef<LeaveRequestList | undefined> {
    return httpResource<LeaveRequestList>(() => (enabled() ? `${ME_API_BASE}/leave/requests` : undefined));
  }

  requestSelf(body: NewLeaveRequest): Observable<LeaveRequestDetail> {
    return this.http.post<LeaveRequestDetail>(`${ME_API_BASE}/leave/requests`, body);
  }

  cancelMine(id: string): Observable<LeaveRequestDetail> {
    return this.http.post<LeaveRequestDetail>(`${ME_API_BASE}/leave/requests/${enc(id)}/cancel`, {});
  }

  /**
   * `POST /leave/preview` as a resource (see header: a read that happens to be a POST). `undefined` from `body` →
   * no request (e.g. the form is not complete yet).
   */
  previewResource(body: () => LeavePreviewRequest | undefined): HttpResourceRef<LeavePreview | undefined> {
    return httpResource<LeavePreview>(() => {
      const value = body();
      return value ? { url: `${LEAVE_API_BASE}/preview`, method: 'POST', body: value } : undefined;
    });
  }

  // --- HR -----------------------------------------------------------------------------------------------------------

  listResource(query: () => LeaveQuery | undefined): HttpResourceRef<LeaveRequestPage | undefined> {
    return httpResource<LeaveRequestPage>(() => {
      const value = query();
      return value ? { url: `${LEAVE_API_BASE}/requests`, params: leaveListParams(value) } : undefined;
    });
  }

  /** `GET /leave/requests/:id` — owner, a current candidate, or `leave.read` in scope. */
  requestResource(id: () => string | null | undefined): HttpResourceRef<LeaveRequestDetail | undefined> {
    return httpResource<LeaveRequestDetail>(() => {
      const value = id();
      return value ? `${LEAVE_API_BASE}/requests/${enc(value)}` : undefined;
    });
  }

  requestOnBehalf(employmentId: string, body: NewLeaveRequest): Observable<LeaveRequestDetail> {
    return this.http.post<LeaveRequestDetail>(employeeUrl(employmentId, '/leave/requests'), body);
  }

  employeeBalancesResource(employmentId: () => string | undefined): HttpResourceRef<BalanceList | undefined> {
    return httpResource<BalanceList>(() => {
      const id = employmentId();
      return id ? employeeUrl(id, '/leave/balances') : undefined;
    });
  }

  employeeLedgerResource(employmentId: () => string | undefined): HttpResourceRef<LedgerList | undefined> {
    return httpResource<LedgerList>(() => {
      const id = employmentId();
      return id ? employeeUrl(id, '/leave/ledger') : undefined;
    });
  }

  adjust(employmentId: string, body: LeaveAdjustment): Observable<unknown> {
    return this.http.post<unknown>(employeeUrl(employmentId, '/leave/adjustments'), body);
  }
}
