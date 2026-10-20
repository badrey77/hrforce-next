/**
 * The deadlines board's state ⇄ the URL's query string, like the documents register (register-state.ts): parse
 * defensively, write only what differs from the default.
 */
import {
  DEADLINE_KINDS,
  DEADLINE_STATUS_FILTERS,
  DEADLINE_WITHIN_MAX,
  DEFAULT_DEADLINE_QUERY,
  type DeadlineKind,
  type DeadlineQuery,
  type DeadlineStatusFilter,
} from '../../core/deadlines/deadlines.models';

export const MAX_DEADLINE_PAGE_SIZE = 100;

export interface BoardParams {
  readonly q?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly unitId?: string;
  readonly includeSubUnits?: string;
  readonly within?: string;
  readonly page?: string;
  readonly pageSize?: string;
}

export type BoardQueryKey = keyof BoardParams;

function positiveInt(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return n >= 1 && n <= max ? n : fallback;
}

export function resolveBoardQuery(params: BoardParams): DeadlineQuery {
  const d = DEFAULT_DEADLINE_QUERY;
  const kind = (DEADLINE_KINDS as readonly string[]).includes(params.kind ?? '') ? (params.kind as DeadlineKind) : null;
  const status = (DEADLINE_STATUS_FILTERS as readonly string[]).includes(params.status ?? '') ? (params.status as DeadlineStatusFilter) : d.status;
  return {
    q: params.q ?? d.q,
    kind,
    status,
    unitId: params.unitId || null,
    includeSubUnits: params.includeSubUnits === undefined ? d.includeSubUnits : params.includeSubUnits !== 'false',
    within: positiveInt(params.within, d.within, DEADLINE_WITHIN_MAX),
    page: positiveInt(params.page, d.page),
    pageSize: positiveInt(params.pageSize, d.pageSize, MAX_DEADLINE_PAGE_SIZE),
  };
}

/** Query params for `router.navigate`: the changed values, `null` where the default applies (removes the param). */
export function toBoardQueryParams(change: Partial<Pick<DeadlineQuery, BoardQueryKey>>): Record<string, string | null> {
  const d = DEFAULT_DEADLINE_QUERY;
  const params: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(change) as [BoardQueryKey, DeadlineQuery[BoardQueryKey]][]) {
    params[key] = value === d[key] || value === '' || value === null ? null : String(value);
  }
  return params;
}
