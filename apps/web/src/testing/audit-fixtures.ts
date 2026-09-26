import type { TimelineEntry, TimelinePage } from '../app/core/audit/audit.models';

/** Timeline entries shaped like docs/contracts/audit.md › Endpoint (newest first). Midday UTC: same day in any TZ. */
export const RENAMED: TimelineEntry = {
  id: 'c:41',
  at: '2026-09-26T10:30:00Z',
  actor: { id: 'u-amina', displayName: 'Amina Benali' },
  requestId: 'req-41',
  kind: 'change',
  table: 'org_unit_version',
  op: 'update',
  changes: [
    { field: 'id', before: 'v-1', after: 'v-1', masked: false },
    { field: 'name', before: 'Région Est', after: 'Région Est-Algérie', masked: false },
    { field: 'parent_id', before: 'dept-ops', after: 'dg', masked: false },
  ],
};

export const GRANTED: TimelineEntry = {
  id: 'e:7',
  at: '2026-09-26T09:00:00Z',
  actor: { id: 'u-amina', displayName: 'Amina Benali' },
  requestId: 'req-7',
  kind: 'event',
  event: {
    type: 'access.grant_created',
    data: { grantId: 'g-1', roleCode: 'lecture', unitId: 'r-ouest', validFrom: '2026-10-01', validTo: null },
  },
};

export const GRANT_ROW: TimelineEntry = {
  id: 'c:40',
  at: '2026-09-25T11:00:00Z',
  actor: { id: 'u-amina', displayName: 'Amina Benali' },
  requestId: 'req-40',
  kind: 'change',
  table: 'role_grant',
  op: 'insert',
  changes: [
    { field: 'company_id', before: null, after: 'c-demo', masked: false },
    { field: 'role_id', before: null, after: 'role-lecture', masked: false },
    { field: 'include_descendants', before: null, after: true, masked: false },
    { field: 'valid_from', before: null, after: '2026-10-01', masked: false },
    { field: 'valid_to', before: null, after: null, masked: false },
    { field: 'valid', before: null, after: '[2026-10-01,)', masked: false },
    { field: 'granted_at', before: null, after: '2026-09-25T11:00:00Z', masked: false },
  ],
};

export const MASKED: TimelineEntry = {
  id: 'c:12',
  at: '2026-09-20T12:00:00Z',
  actor: null,
  requestId: null,
  kind: 'change',
  table: 'site',
  op: 'update',
  changes: [
    { field: 'address', before: '***', after: '***', masked: true },
    { field: 'legacy_col', before: 'a', after: 'b', masked: false },
  ],
};

export const CREATED: TimelineEntry = {
  id: 'c:3',
  at: '2026-09-01T12:00:00Z',
  actor: null,
  requestId: null,
  kind: 'change',
  table: 'org_unit_version',
  op: 'insert',
  changes: [{ field: 'valid', before: null, after: '[2026-01-01,2027-01-01)', masked: false }],
};

export const PAGE_1: TimelinePage = { items: [RENAMED, GRANTED, GRANT_ROW, MASKED], nextCursor: 'cur-2' };
export const PAGE_2: TimelinePage = { items: [CREATED], nextCursor: null };
