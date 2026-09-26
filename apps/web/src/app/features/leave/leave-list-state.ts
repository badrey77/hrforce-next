/**
 * The HR leave list's state ⇄ the URL's query string — same two pure functions as the employee list
 * (features/employees/employee-list-state.ts, chapter 14 "URL as state"): parse defensively, write only what differs
 * from the default. Plain TypeScript, no Angular.
 */
import { isIsoDate } from '../../core/date/iso-date';
import {
  DEFAULT_LEAVE_QUERY,
  LEAVE_STATUS_FILTERS,
  type LeaveQuery,
  type LeaveStatusFilter,
} from '../../core/leave/leave.models';

export const MAX_LEAVE_PAGE_SIZE = 100;

/** The raw query params as the router binds them. */
export interface LeaveListParams {
  readonly q?: string;
  readonly status?: string;
  readonly unitId?: string;
  readonly includeSubUnits?: string;
  readonly typeId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly page?: string;
  readonly pageSize?: string;
}

function positiveInt(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return n >= 1 && n <= max ? n : fallback;
}

export function resolveLeaveQuery(params: LeaveListParams): LeaveQuery {
  const d = DEFAULT_LEAVE_QUERY;
  const status = (LEAVE_STATUS_FILTERS as readonly string[]).includes(params.status ?? '')
    ? (params.status as LeaveStatusFilter)
    : d.status;
  return {
    q: params.q ?? d.q,
    status,
    unitId: params.unitId || null,
    includeSubUnits: params.includeSubUnits === undefined ? d.includeSubUnits : params.includeSubUnits !== 'false',
    typeId: params.typeId || null,
    from: isIsoDate(params.from) ? params.from : null,
    to: isIsoDate(params.to) ? params.to : null,
    page: positiveInt(params.page, d.page),
    pageSize: positiveInt(params.pageSize, d.pageSize, MAX_LEAVE_PAGE_SIZE),
  };
}

/** Query params for `router.navigate`: the changed values, `null` where the default applies (removes the param). */
export function toLeaveQueryParams(change: Partial<LeaveQuery>): Record<string, string | null> {
  const d = DEFAULT_LEAVE_QUERY;
  const params: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(change) as [keyof LeaveQuery, LeaveQuery[keyof LeaveQuery]][]) {
    params[key] = value === d[key] || value === '' || value === null ? null : String(value);
  }
  return params;
}
