/** URL query ⇄ list queries of the openings and candidates lists (defaults stay out of the URL). */
import {
  APPLICATION_STATES,
  type ApplicationState,
  CANDIDATE_SORTS,
  type CandidateQuery,
  type CandidateSort,
  CONTRACT_TYPES,
  type ContractType,
  DEFAULT_CANDIDATE_QUERY,
  DEFAULT_OPENING_QUERY,
  OPENING_SORTS,
  OPENING_STATUS_FILTERS,
  type OpeningQuery,
  type OpeningSort,
  type OpeningStatusFilter,
  PAGE_SIZES,
  type SortDir,
  type Stage,
  STAGES,
} from '../../core/recruitment/recruitment.models';

export type ListParams = Readonly<Record<string, string | undefined>>;

function oneOf<T extends string>(values: readonly T[], value: string | undefined, fallback: T): T {
  return (values as readonly string[]).includes(value ?? '') ? (value as T) : fallback;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return n >= 1 ? n : fallback;
}

function pageSizeOf(value: string | undefined, fallback: number): number {
  const n = positiveInt(value, fallback);
  return PAGE_SIZES.includes(n) ? n : fallback;
}

/** The natural direction of each sort, as the API's own defaults: dates newest first, names and titles ascending. */
export function defaultDir(sort: OpeningSort | CandidateSort): SortDir {
  return sort === 'requestedAt' || sort === 'stageSince' || sort === 'createdAt' ? 'desc' : 'asc';
}

function dirOf(value: string | undefined, sort: OpeningSort | CandidateSort): SortDir {
  return value === 'asc' || value === 'desc' ? value : defaultDir(sort);
}

export function resolveOpeningQuery(params: ListParams): OpeningQuery {
  const d = DEFAULT_OPENING_QUERY;
  const sort = oneOf<OpeningSort>(OPENING_SORTS, params['sort'], d.sort);
  return {
    status: oneOf<OpeningStatusFilter>(OPENING_STATUS_FILTERS, params['status'], d.status),
    unitId: params['unitId'] || null,
    includeSubUnits: params['includeSubUnits'] !== 'false',
    contractType: (CONTRACT_TYPES as readonly string[]).includes(params['contractType'] ?? '') ? (params['contractType'] as ContractType) : null,
    q: params['q'] ?? d.q,
    sort,
    dir: dirOf(params['dir'], sort),
    page: positiveInt(params['page'], d.page),
    pageSize: pageSizeOf(params['pageSize'], d.pageSize),
  };
}

export function resolveCandidateQuery(params: ListParams): CandidateQuery {
  const d = DEFAULT_CANDIDATE_QUERY;
  const sort = oneOf<CandidateSort>(CANDIDATE_SORTS, params['sort'], d.sort);
  return {
    q: params['q'] ?? d.q,
    openingId: params['openingId'] || null,
    stage: (STAGES as readonly string[]).includes(params['stage'] ?? '') ? (params['stage'] as Stage) : null,
    state: oneOf<ApplicationState>(APPLICATION_STATES, params['state'], d.state),
    idle: params['idle'] === 'true',
    unitId: params['unitId'] || null,
    includeSubUnits: params['includeSubUnits'] !== 'false',
    sort,
    dir: dirOf(params['dir'], sort),
    page: positiveInt(params['page'], d.page),
    pageSize: pageSizeOf(params['pageSize'], d.pageSize),
  };
}

/** A change of the query as query params for `router.navigate` (`null` removes a param that is back to its default). */
export function toQueryParams<Q extends OpeningQuery | CandidateQuery>(change: Partial<Q>, defaults: Q): Record<string, string | null> {
  const params: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(change) as [keyof Q & string, unknown][]) {
    if (key === 'dir') continue; // written with `sort` below
    params[key] = value === defaults[key] || value === '' || value === null ? null : String(value);
  }
  if ('sort' in change || 'dir' in change) {
    const sort = (change.sort ?? defaults.sort) as OpeningSort | CandidateSort;
    params['dir'] = change.dir && change.dir !== defaultDir(sort) ? change.dir : null;
  }
  return params;
}
