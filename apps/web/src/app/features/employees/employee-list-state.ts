/**
 * The employee list's state ⇄ the URL's query string. Plain TypeScript, no Angular: two pure functions the list
 * page calls, unit-testable without TestBed.
 *
 * "URL as state" (docs/angular/14-big-forms-and-url-state.md): the query string IS the list's state — filters,
 * sort, page. The page never keeps a second copy in a signal. Reading goes URL → router → signal inputs →
 * `resolveQuery()`; writing goes `toQueryParams()` → `router.navigate()` → URL → (same loop again).
 *
 * - **Parse defensively.** A URL is user input: someone can type `?page=-3&sort=salary`. `resolveQuery()` never
 *   throws; anything invalid falls back to the default, so a hand-edited or outdated link still shows a list.
 * - **Write only what differs from the default** (`null` removes a param with `queryParamsHandling: 'merge'`). The
 *   plain list stays `/employees`, and a shared link carries only what the sender chose.
 */
import { isIsoDate } from '../../core/date/iso-date';
import {
  DEFAULT_EMPLOYEE_QUERY,
  EMPLOYEE_SORTS,
  type EmployeeQuery,
  type EmployeeSort,
  MAX_PAGE_SIZE,
  type SortDir,
  STATUS_FILTERS,
  type StatusFilter,
} from '../../core/employees/employees.models';

/** The raw query params as the router binds them (every one optional, all strings). */
export interface ListParams {
  readonly q?: string;
  readonly unitId?: string;
  readonly includeSubUnits?: string;
  readonly siteId?: string;
  readonly status?: string;
  readonly asOf?: string;
  readonly sort?: string;
  readonly dir?: string;
  readonly page?: string;
  readonly pageSize?: string;
}

function positiveInt(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return n >= 1 && n <= max ? n : fallback;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback;
}

/** URL params → the full query the API is asked for (defaults applied, garbage ignored). */
export function resolveQuery(params: ListParams): EmployeeQuery {
  const d = DEFAULT_EMPLOYEE_QUERY;
  return {
    q: params.q ?? d.q,
    unitId: params.unitId || null,
    includeSubUnits: params.includeSubUnits === undefined ? d.includeSubUnits : params.includeSubUnits !== 'false',
    siteId: params.siteId || null,
    status: oneOf<StatusFilter>(params.status, STATUS_FILTERS, d.status),
    asOf: isIsoDate(params.asOf) ? params.asOf : null,
    sort: oneOf<EmployeeSort>(params.sort, EMPLOYEE_SORTS, d.sort),
    dir: oneOf<SortDir>(params.dir, ['asc', 'desc'], d.dir),
    page: positiveInt(params.page, d.page),
    pageSize: positiveInt(params.pageSize, d.pageSize, MAX_PAGE_SIZE),
  };
}

/** Query params for `router.navigate`: the changed values, `null` where the default applies (removes the param). */
export function toQueryParams(change: Partial<EmployeeQuery>): Record<string, string | null> {
  const d = DEFAULT_EMPLOYEE_QUERY;
  const params: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(change) as [keyof EmployeeQuery, EmployeeQuery[keyof EmployeeQuery]][]) {
    const isDefault = value === d[key] || value === '' || value === null;
    params[key] = isDefault ? null : String(value);
  }
  return params;
}
