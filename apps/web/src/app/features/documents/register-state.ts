/**
 * The documents register's state ⇄ the URL's query string — the same two pure functions as the employee and leave
 * lists (features/leave/leave-list-state.ts, chapter 14 "URL as state"): parse defensively, write only what differs
 * from the default. Plain TypeScript, no Angular.
 */
import { isIsoDate } from '../../core/date/iso-date';
import {
  DEFAULT_DOCUMENT_QUERY,
  DOCUMENT_STATUS_FILTERS,
  type DocumentQuery,
  type DocumentStatusFilter,
} from '../../core/documents/documents.models';

export const MAX_DOCUMENT_PAGE_SIZE = 100;

/** The raw query params as the router binds them. */
export interface RegisterParams {
  readonly q?: string;
  readonly typeCode?: string;
  readonly status?: string;
  readonly unitId?: string;
  readonly includeSubUnits?: string;
  readonly from?: string;
  readonly to?: string;
  readonly page?: string;
  readonly pageSize?: string;
}

/** The URL keys the register owns (`employmentId`/`leaveRequestId` are query fields of other screens). */
export type RegisterQueryKey = keyof RegisterParams;

function positiveInt(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return n >= 1 && n <= max ? n : fallback;
}

export function resolveRegisterQuery(params: RegisterParams): DocumentQuery {
  const d = DEFAULT_DOCUMENT_QUERY;
  const status = (DOCUMENT_STATUS_FILTERS as readonly string[]).includes(params.status ?? '')
    ? (params.status as DocumentStatusFilter)
    : d.status;
  return {
    ...d,
    q: params.q ?? d.q,
    typeCode: params.typeCode || null,
    status,
    unitId: params.unitId || null,
    includeSubUnits: params.includeSubUnits === undefined ? d.includeSubUnits : params.includeSubUnits !== 'false',
    from: isIsoDate(params.from) ? params.from : null,
    to: isIsoDate(params.to) ? params.to : null,
    page: positiveInt(params.page, d.page),
    pageSize: positiveInt(params.pageSize, d.pageSize, MAX_DOCUMENT_PAGE_SIZE),
  };
}

/** Query params for `router.navigate`: the changed values, `null` where the default applies (removes the param). */
export function toRegisterQueryParams(change: Partial<Pick<DocumentQuery, RegisterQueryKey>>): Record<string, string | null> {
  const d = DEFAULT_DOCUMENT_QUERY;
  const params: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(change) as [RegisterQueryKey, DocumentQuery[RegisterQueryKey]][]) {
    params[key] = value === d[key] || value === '' || value === null ? null : String(value);
  }
  return params;
}
