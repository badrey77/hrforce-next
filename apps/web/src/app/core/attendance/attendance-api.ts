/**
 * AttendanceApi — the signed-in endpoints of the Attendance module (docs/contracts/attendance.md › Endpoints): the
 * phone's scan and punch, "my" days, the team view, the HR board, per-employee days and manual punches, and the
 * configuration (policy, schedules, overrides, assignments, kiosks). The kiosk's own three calls live in kiosk-api.ts
 * so the kiosk chunk does not carry the rest.
 *
 * Same split as core/leave/leave-api.ts (read its header first): page reads are signal-driven `httpResource`s, writes
 * are one-shot Observables a form subscribes to.
 *
 * Angular concepts:
 * - **A resource keyed on a whole query object.** `presenceResource(query, lang)` builds its params with a pure
 *   function (`presenceParams`, unit-tested): the request function reads both signals, so a new filter in the URL or
 *   a language switch sends a new request and cancels the one in flight.
 * - **`enabled` functions keep a resource idle.** A resource whose request function returns `undefined` sends
 *   nothing; the employee tab passes the tab's visibility, the settings pass the permission. No `ngOnInit`, no
 *   "if (x) subscribe" branches.
 * - **Why the phone's two calls are Observables, not resources.** `scan()` and `punchSelf()` CHANGE state (a cookie,
 *   a punch row) and must run exactly once, in order, at a moment the page chooses — resources re-run whenever a
 *   signal they read changes, which is right for reads and wrong for writes.
 * - `…Resource()` methods call `inject()` inside `httpResource`: call them from a field initializer.
 * - **Phase B — a CSV as a Blob.** `monthlyReportCsv()` asks for `responseType: 'blob'` (chapter 18): the bytes go
 *   straight to `BlobFiles.save()` / `<a download>`, never through `JSON.parse`. A 422 (more than 5 000 rows) still
 *   arrives as an `ApiProblemError`: the problem interceptor reads the error Blob as JSON first.
 */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { employeeUrl } from '../employees/employees-api';
import type { AppLanguage } from '../i18n/languages';
import {
  type AssignmentList,
  type AssignmentTargetKind,
  type AssignmentView,
  type CorrectionDetail,
  type CorrectionInput,
  type CorrectionList,
  type CorrectionPage,
  type CorrectionQuery,
  type CorrectionStatus,
  type CorrectionView,
  correctionParams,
  type CreatedKiosk,
  type EmployeeDaysView,
  type KioskList,
  type KioskView,
  type ManualPunchInput,
  type MonthlyReportView,
  type MyDaysView,
  type NewAssignment,
  type NewKiosk,
  type NewSchedule,
  type NewScheduleVersion,
  type OverrideInput,
  type OverrideList,
  type OverrideView,
  type PairingCodeView,
  type PolicyInput,
  type PolicyView,
  type PresenceBoardView,
  type PresenceQuery,
  type PunchResultView,
  type PunchView,
  type ReceiptView,
  type ReportQuery,
  reportCsvParams,
  reportParams,
  type ScanView,
  type ScheduleList,
  type ScheduleSegmentsView,
  type ScheduleView,
  type TeamPresenceView,
  type UpdateKiosk,
  type UpdateSchedule,
} from './attendance.models';

export const ATTENDANCE_API_BASE = '/api/attendance';
export const ME_ATTENDANCE_BASE = '/api/me/attendance';
export const TEAM_PRESENCE_URL = '/api/me/team/presence';

const enc = encodeURIComponent;

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

/** The team view's filters (no unit or site pickers: the API decides the units from `org_unit_head`). */
export interface TeamQuery {
  readonly date: string | null;
  readonly status: PresenceQuery['status'];
  readonly q: string;
  readonly page: number;
  readonly pageSize: number;
}

/** Query params of `GET /attendance/presence`: defaults left out, paging always sent, `lang` only for Arabic. */
export function presenceParams(query: PresenceQuery, lang: AppLanguage | null = null): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.date) params['date'] = query.date;
  if (query.unitId) {
    params['unitId'] = query.unitId;
    params['includeSubUnits'] = String(query.includeSubUnits);
  }
  if (query.siteId) params['siteId'] = query.siteId;
  if (query.status) params['status'] = query.status;
  const q = query.q.trim();
  if (q) params['q'] = q;
  if (query.sort !== 'unit') params['sort'] = query.sort;
  if (lang === 'ar') params['lang'] = 'ar';
  params['page'] = String(query.page);
  params['pageSize'] = String(query.pageSize);
  return params;
}

/** Query params of `GET /me/team/presence`. */
export function teamParams(query: TeamQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.date) params['date'] = query.date;
  if (query.status) params['status'] = query.status;
  const q = query.q.trim();
  if (q) params['q'] = q;
  params['page'] = String(query.page);
  params['pageSize'] = String(query.pageSize);
  return params;
}

export interface AssignmentQuery {
  readonly targetKind?: AssignmentTargetKind;
  readonly scheduleId?: string;
  /** A date, or `'all'` for every assignment; absent = today. */
  readonly at?: string;
}

@Injectable({ providedIn: 'root' })
export class AttendanceApi {
  private readonly http = inject(HttpClient);

  // --- Phone (ADR 009 §3) -------------------------------------------------------------------------------------------

  /** `POST /attendance/scan {token}` (public) → the entrance + the `hrf_scan` receipt cookie (2 min since 2026-09-30). */
  scan(token: string): Observable<ScanView> {
    return this.http.post<ScanView>(`${ATTENDANCE_API_BASE}/scan`, { token });
  }

  /**
   * `GET /me/attendance/receipt` — what the one-tap confirmation shows: entrance, time, direction, duplicate. Reads
   * the `hrf_scan` cookie and writes nothing (the receipt stays for the POST); same errors as the punch.
   */
  receipt(): Observable<ReceiptView> {
    return this.http.get<ReceiptView>(`${ME_ATTENDANCE_BASE}/receipt`);
  }

  /** `POST /me/attendance/punches` (no body) → 201 new punch, 200 `duplicate: true`. Redeems the receipt cookie. */
  punchSelf(): Observable<PunchResultView> {
    return this.http.post<PunchResultView>(`${ME_ATTENDANCE_BASE}/punches`, null);
  }

  // --- Self-service and team ----------------------------------------------------------------------------------------

  /**
   * `GET /me/attendance/days?from=&to=` — `undefined` → no request; `{}` → the API's default (today, Algiers), which
   * spares the web from guessing the server's date.
   */
  myDaysResource(range: () => Partial<DateRange> | undefined): HttpResourceRef<MyDaysView | undefined> {
    return httpResource<MyDaysView>(() => {
      const value = range();
      if (!value) return undefined;
      const params: Record<string, string> = {};
      if (value.from) params['from'] = value.from;
      if (value.to) params['to'] = value.to;
      return { url: `${ME_ATTENDANCE_BASE}/days`, params };
    });
  }

  /** `GET /me/team/presence` (`@Authenticated`: a unit head needs no permission). */
  teamResource(query: () => TeamQuery | undefined): HttpResourceRef<TeamPresenceView | undefined> {
    return httpResource<TeamPresenceView>(() => {
      const value = query();
      return value ? { url: TEAM_PRESENCE_URL, params: teamParams(value) } : undefined;
    });
  }

  // --- HR -----------------------------------------------------------------------------------------------------------

  presenceResource(
    query: () => PresenceQuery | undefined,
    lang: () => AppLanguage | null = () => null,
  ): HttpResourceRef<PresenceBoardView | undefined> {
    return httpResource<PresenceBoardView>(() => {
      const value = query();
      return value ? { url: `${ATTENDANCE_API_BASE}/presence`, params: presenceParams(value, lang()) } : undefined;
    });
  }

  employeeDaysResource(id: () => string | undefined, range: () => DateRange | undefined): HttpResourceRef<EmployeeDaysView | undefined> {
    return httpResource<EmployeeDaysView>(() => {
      const employmentId = id();
      const value = range();
      return employmentId && value
        ? { url: employeeUrl(employmentId, '/attendance/days'), params: { from: value.from, to: value.to } }
        : undefined;
    });
  }

  employeeScheduleResource(id: () => string | undefined, range: () => DateRange | undefined): HttpResourceRef<ScheduleSegmentsView | undefined> {
    return httpResource<ScheduleSegmentsView>(() => {
      const employmentId = id();
      const value = range();
      return employmentId && value
        ? { url: employeeUrl(employmentId, '/attendance/schedule'), params: { from: value.from, to: value.to } }
        : undefined;
    });
  }

  addPunch(employmentId: string, body: ManualPunchInput): Observable<PunchView> {
    return this.http.post<PunchView>(employeeUrl(employmentId, '/attendance/punches'), body);
  }

  voidPunch(punchId: string, reason: string): Observable<PunchView> {
    return this.http.post<PunchView>(`${ATTENDANCE_API_BASE}/punches/${enc(punchId)}/void`, { reason });
  }

  // --- Corrections (Phase B) ----------------------------------------------------------------------------------------

  /** `POST /me/attendance/corrections` → 201 `CorrectionView` (the workflow starts). */
  requestCorrection(body: CorrectionInput): Observable<CorrectionView> {
    return this.http.post<CorrectionView>(`${ME_ATTENDANCE_BASE}/corrections`, body);
  }

  /** `GET /me/attendance/corrections?status=` — newest first. `enabled()` false → no request. */
  myCorrectionsResource(enabled: () => boolean, status: () => CorrectionStatus | null = () => null): HttpResourceRef<CorrectionList | undefined> {
    return httpResource<CorrectionList>(() => {
      if (!enabled()) return undefined;
      const value = status();
      const params: Record<string, string> = value ? { status: value } : {};
      return { url: `${ME_ATTENDANCE_BASE}/corrections`, params };
    });
  }

  /** `POST /me/attendance/corrections/:id/cancel` — the requester, `pending` only. */
  cancelMyCorrection(id: string): Observable<CorrectionView> {
    return this.http.post<CorrectionView>(`${ME_ATTENDANCE_BASE}/corrections/${enc(id)}/cancel`, null);
  }

  /** `GET /attendance/corrections` — HR's scoped list. */
  correctionsResource(query: () => CorrectionQuery | undefined): HttpResourceRef<CorrectionPage | undefined> {
    return httpResource<CorrectionPage>(() => {
      const value = query();
      return value ? { url: `${ATTENDANCE_API_BASE}/corrections`, params: correctionParams(value) } : undefined;
    });
  }

  /**
   * `GET /attendance/corrections/:id` (`@Authenticated`: the employee, a current candidate — a unit head with no
   * permission — or `attendance.read` over the employee; else 404).
   */
  correctionResource(id: () => string | undefined): HttpResourceRef<CorrectionDetail | undefined> {
    return httpResource<CorrectionDetail>(() => {
      const value = id();
      return value ? `${ATTENDANCE_API_BASE}/corrections/${enc(value)}` : undefined;
    });
  }

  // --- Monthly report (Phase B) -------------------------------------------------------------------------------------

  monthlyReportResource(query: () => ReportQuery | undefined, currentMonth: string): HttpResourceRef<MonthlyReportView | undefined> {
    return httpResource<MonthlyReportView>(() => {
      const value = query();
      return value ? { url: `${ATTENDANCE_API_BASE}/reports/monthly`, params: reportParams(value, currentMonth) } : undefined;
    });
  }

  /** `GET /attendance/reports/monthly.csv` — the bytes (UTF-8 with BOM, `;`, CRLF), header row in `lang`. */
  monthlyReportCsv(query: ReportQuery, currentMonth: string, lang: AppLanguage): Observable<Blob> {
    return this.http.get(`${ATTENDANCE_API_BASE}/reports/monthly.csv`, {
      params: reportCsvParams(query, currentMonth, lang),
      responseType: 'blob',
    });
  }

  // --- Configuration ------------------------------------------------------------------------------------------------

  policyResource(enabled: () => boolean = () => true): HttpResourceRef<PolicyView | undefined> {
    return httpResource<PolicyView>(() => (enabled() ? `${ATTENDANCE_API_BASE}/policy` : undefined));
  }

  updatePolicy(body: PolicyInput): Observable<PolicyView> {
    return this.http.put<PolicyView>(`${ATTENDANCE_API_BASE}/policy`, body);
  }

  schedulesResource(enabled: () => boolean = () => true): HttpResourceRef<ScheduleList | undefined> {
    return httpResource<ScheduleList>(() => (enabled() ? `${ATTENDANCE_API_BASE}/schedules` : undefined));
  }

  createSchedule(body: NewSchedule): Observable<ScheduleView> {
    return this.http.post<ScheduleView>(`${ATTENDANCE_API_BASE}/schedules`, body);
  }

  updateSchedule(id: string, body: UpdateSchedule): Observable<ScheduleView> {
    return this.http.patch<ScheduleView>(`${ATTENDANCE_API_BASE}/schedules/${enc(id)}`, body);
  }

  addVersion(id: string, body: NewScheduleVersion): Observable<ScheduleView> {
    return this.http.post<ScheduleView>(`${ATTENDANCE_API_BASE}/schedules/${enc(id)}/versions`, body);
  }

  overridesResource(year: () => number | undefined): HttpResourceRef<OverrideList | undefined> {
    return httpResource<OverrideList>(() => {
      const value = year();
      return value === undefined ? undefined : { url: `${ATTENDANCE_API_BASE}/schedule-overrides`, params: { year: value } };
    });
  }

  createOverride(body: OverrideInput): Observable<OverrideView> {
    return this.http.post<OverrideView>(`${ATTENDANCE_API_BASE}/schedule-overrides`, body);
  }

  updateOverride(id: string, body: OverrideInput): Observable<OverrideView> {
    return this.http.put<OverrideView>(`${ATTENDANCE_API_BASE}/schedule-overrides/${enc(id)}`, body);
  }

  deleteOverride(id: string): Observable<void> {
    return this.http.delete<void>(`${ATTENDANCE_API_BASE}/schedule-overrides/${enc(id)}`);
  }

  assignmentsResource(query: () => AssignmentQuery | undefined): HttpResourceRef<AssignmentList | undefined> {
    return httpResource<AssignmentList>(() => {
      const value = query();
      if (!value) return undefined;
      const params: Record<string, string> = {};
      if (value.targetKind) params['targetKind'] = value.targetKind;
      if (value.scheduleId) params['scheduleId'] = value.scheduleId;
      if (value.at) params['at'] = value.at;
      return { url: `${ATTENDANCE_API_BASE}/schedule-assignments`, params };
    });
  }

  createAssignment(body: NewAssignment): Observable<AssignmentView> {
    return this.http.post<AssignmentView>(`${ATTENDANCE_API_BASE}/schedule-assignments`, body);
  }

  /** `validTo` = the last day, inclusive. */
  endAssignment(id: string, validTo: string): Observable<AssignmentView> {
    return this.http.post<AssignmentView>(`${ATTENDANCE_API_BASE}/schedule-assignments/${enc(id)}/end`, { validTo });
  }

  deleteAssignment(id: string): Observable<void> {
    return this.http.delete<void>(`${ATTENDANCE_API_BASE}/schedule-assignments/${enc(id)}`);
  }

  kiosksResource(enabled: () => boolean = () => true): HttpResourceRef<KioskList | undefined> {
    return httpResource<KioskList>(() => (enabled() ? `${ATTENDANCE_API_BASE}/kiosks` : undefined));
  }

  createKiosk(body: NewKiosk): Observable<CreatedKiosk> {
    return this.http.post<CreatedKiosk>(`${ATTENDANCE_API_BASE}/kiosks`, body);
  }

  updateKiosk(id: string, body: UpdateKiosk): Observable<KioskView> {
    return this.http.patch<KioskView>(`${ATTENDANCE_API_BASE}/kiosks/${enc(id)}`, body);
  }

  newPairingCode(id: string): Observable<PairingCodeView> {
    return this.http.post<PairingCodeView>(`${ATTENDANCE_API_BASE}/kiosks/${enc(id)}/pairing-code`, null);
  }

  revokeKiosk(id: string, reason: string): Observable<KioskView> {
    return this.http.post<KioskView>(`${ATTENDANCE_API_BASE}/kiosks/${enc(id)}/revoke`, { reason });
  }
}
