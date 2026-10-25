/**
 * The HR list of profile change requests ⇄ the URL's query string (the deadlines board pattern): parse defensively,
 * write only what differs from the default. The status filter defaults to `pending`; « all statuses » is `status=all`
 * in the URL (an empty status would read back as the default).
 */
import {
  DEFAULT_PROFILE_REQUEST_QUERY,
  PROFILE_REQUEST_STATUSES,
  PROFILE_SECTIONS,
  type ProfileRequestQuery,
  type ProfileRequestStatus,
  type ProfileSection,
} from '../../core/profile/profile.models';

export const PROFILE_REQUEST_PAGE_SIZES: readonly number[] = [25, 50, 100];
export const MAX_PROFILE_REQUEST_PAGE_SIZE = 100;
export const ALL_STATUSES = 'all';

export interface RequestListParams {
  readonly q?: string;
  readonly status?: string;
  readonly section?: string;
  readonly unitId?: string;
  readonly includeSubUnits?: string;
  readonly page?: string;
  readonly pageSize?: string;
}

export type RequestQueryKey = keyof RequestListParams;

function positiveInt(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return n >= 1 && n <= max ? n : fallback;
}

export function resolveRequestQuery(params: RequestListParams): ProfileRequestQuery {
  const d = DEFAULT_PROFILE_REQUEST_QUERY;
  let status: ProfileRequestStatus | '' = d.status;
  if (params.status === ALL_STATUSES) status = '';
  else if ((PROFILE_REQUEST_STATUSES as readonly string[]).includes(params.status ?? '')) status = params.status as ProfileRequestStatus;
  const section = (PROFILE_SECTIONS as readonly string[]).includes(params.section ?? '') ? (params.section as ProfileSection) : '';
  return {
    q: params.q ?? d.q,
    status,
    section,
    unitId: params.unitId || null,
    includeSubUnits: params.includeSubUnits === undefined ? d.includeSubUnits : params.includeSubUnits !== 'false',
    page: positiveInt(params.page, d.page),
    pageSize: positiveInt(params.pageSize, d.pageSize, MAX_PROFILE_REQUEST_PAGE_SIZE),
  };
}

/** Query params for `router.navigate`: the changed values, `null` where the default applies (removes the param). */
export function toRequestQueryParams(change: Partial<ProfileRequestQuery>): Record<string, string | null> {
  const d = DEFAULT_PROFILE_REQUEST_QUERY;
  const params: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(change) as [keyof ProfileRequestQuery, ProfileRequestQuery[keyof ProfileRequestQuery]][]) {
    if (key === 'status') params[key] = value === d.status ? null : value === '' ? ALL_STATUSES : String(value);
    else params[key] = value === d[key] || value === '' || value === null ? null : String(value);
  }
  return params;
}
