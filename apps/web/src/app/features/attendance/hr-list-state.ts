/**
 * URL state of the two Phase B HR pages — the corrections list and the monthly report — as pure functions, the
 * employee list's pattern (features/employees/employee-list-state.ts, chapter 14 "URL as state"): parse defensively
 * (a hand-edited URL never breaks a page), write only what differs from the default (a clean URL means the defaults).
 * Plain TypeScript, no Angular.
 *
 * The corrections list defaults to `pending` (what HR has to look at); `?status=all` is the explicit "every status",
 * because an absent parameter already means "pending".
 */
import {
  CORRECTION_PAGE_SIZES,
  CORRECTION_STATUSES,
  type CorrectionQuery,
  type CorrectionStatus,
  DEFAULT_CORRECTION_QUERY,
  DEFAULT_REPORT_QUERY,
  isMonth,
  REPORT_PAGE_SIZES,
  type ReportQuery,
} from '../../core/attendance/attendance.models';
import { isIsoDate } from '../../core/date/iso-date';

export const ALL_STATUSES = 'all';

export interface CorrectionListParams {
  readonly status?: string;
  readonly unitId?: string;
  readonly includeSubUnits?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly page?: string;
  readonly pageSize?: string;
}

export interface ReportParams {
  readonly month?: string;
  readonly unitId?: string;
  readonly includeSubUnits?: string;
  readonly siteId?: string;
  readonly q?: string;
  readonly page?: string;
  readonly pageSize?: string;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return n >= 1 ? n : fallback;
}

function pageSizeOf(value: string | undefined, sizes: readonly number[], fallback: number): number {
  const n = positiveInt(value, fallback);
  return sizes.includes(n) ? n : fallback;
}

export function resolveCorrectionQuery(params: CorrectionListParams): CorrectionQuery {
  const d = DEFAULT_CORRECTION_QUERY;
  let status: CorrectionStatus | null = d.status;
  if (params.status === ALL_STATUSES) status = null;
  else if ((CORRECTION_STATUSES as readonly string[]).includes(params.status ?? '')) status = params.status as CorrectionStatus;
  return {
    status,
    unitId: params.unitId || null,
    includeSubUnits: params.includeSubUnits === undefined ? d.includeSubUnits : params.includeSubUnits !== 'false',
    from: isIsoDate(params.from) ? params.from : null,
    to: isIsoDate(params.to) ? params.to : null,
    q: params.q ?? d.q,
    page: positiveInt(params.page, d.page),
    pageSize: pageSizeOf(params.pageSize, CORRECTION_PAGE_SIZES, d.pageSize),
  };
}

/** Query params for `router.navigate`: changed values, `null` where the default applies (removes the param). */
export function toCorrectionQueryParams(change: Partial<CorrectionQuery>): Record<string, string | null> {
  const d = DEFAULT_CORRECTION_QUERY;
  const params: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(change) as [keyof CorrectionQuery, CorrectionQuery[keyof CorrectionQuery]][]) {
    if (key === 'status') params[key] = value === d.status ? null : value === null ? ALL_STATUSES : String(value);
    else params[key] = value === d[key] || value === '' || value === null ? null : String(value);
  }
  return params;
}

/** `month` must be a real `YYYY-MM` not after the current month (the API answers 422 otherwise). */
export function resolveReportQuery(params: ReportParams, currentMonth: string): ReportQuery {
  const d = DEFAULT_REPORT_QUERY;
  const month = isMonth(params.month) && params.month < currentMonth ? params.month : null;
  return {
    month,
    unitId: params.unitId || null,
    includeSubUnits: params.includeSubUnits === undefined ? d.includeSubUnits : params.includeSubUnits !== 'false',
    siteId: params.siteId || null,
    q: params.q ?? d.q,
    page: positiveInt(params.page, d.page),
    pageSize: pageSizeOf(params.pageSize, REPORT_PAGE_SIZES, d.pageSize),
  };
}

export function toReportQueryParams(change: Partial<ReportQuery>): Record<string, string | null> {
  const d = DEFAULT_REPORT_QUERY;
  const params: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(change) as [keyof ReportQuery, ReportQuery[keyof ReportQuery]][]) {
    params[key] = value === d[key] || value === '' || value === null ? null : String(value);
  }
  return params;
}
