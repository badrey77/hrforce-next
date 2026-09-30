/**
 * The presence board's state ⇄ the URL's query string (docs/contracts/attendance.md › Web › Presence board: "all in
 * the URL query, as /employees"). Same two pure functions as features/employees/employee-list-state.ts (chapter 14,
 * "URL as state"): parse defensively (a hand-edited URL never breaks the page), write only what differs from the
 * default (a clean URL means the defaults). Plain TypeScript, no Angular.
 *
 * In shared/ (not features/attendance/) because two features read it: the HR board and "Mon équipe", which is the
 * same layout without the unit and site pickers (a feature never imports another feature).
 */
import {
  BOARD_STATUSES,
  type BoardStatus,
  DEFAULT_PRESENCE_QUERY,
  PRESENCE_PAGE_SIZES,
  PRESENCE_SORTS,
  type PresenceQuery,
  type PresenceSort,
} from '../../core/attendance/attendance.models';
import { isIsoDate } from '../../core/date/iso-date';

/** The raw query params as the router binds them to the page's inputs. */
export interface PresenceParams {
  readonly date?: string;
  readonly unitId?: string;
  readonly includeSubUnits?: string;
  readonly siteId?: string;
  readonly status?: string;
  readonly q?: string;
  readonly sort?: string;
  readonly page?: string;
  readonly pageSize?: string;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return n >= 1 ? n : fallback;
}

export function resolvePresenceQuery(params: PresenceParams): PresenceQuery {
  const d = DEFAULT_PRESENCE_QUERY;
  const pageSize = positiveInt(params.pageSize, d.pageSize);
  return {
    date: isIsoDate(params.date) ? params.date : null,
    unitId: params.unitId || null,
    includeSubUnits: params.includeSubUnits === undefined ? d.includeSubUnits : params.includeSubUnits !== 'false',
    siteId: params.siteId || null,
    status: (BOARD_STATUSES as readonly string[]).includes(params.status ?? '') ? (params.status as BoardStatus) : null,
    q: params.q ?? d.q,
    sort: (PRESENCE_SORTS as readonly string[]).includes(params.sort ?? '') ? (params.sort as PresenceSort) : d.sort,
    page: positiveInt(params.page, d.page),
    pageSize: PRESENCE_PAGE_SIZES.includes(pageSize) ? pageSize : d.pageSize,
  };
}

/** Query params for `router.navigate`: the changed values, `null` where the default applies (removes the param). */
export function toPresenceQueryParams(change: Partial<PresenceQuery>): Record<string, string | null> {
  const d = DEFAULT_PRESENCE_QUERY;
  const params: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(change) as [keyof PresenceQuery, PresenceQuery[keyof PresenceQuery]][]) {
    params[key] = value === d[key] || value === '' || value === null ? null : String(value);
  }
  return params;
}
