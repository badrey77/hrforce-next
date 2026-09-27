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

// --- Leave request history (notifications contract › Audit gap) ------------------------------------------------

/** A leave request row created (subject `leave_request:r-1`, or on the employee's timeline). */
export const LEAVE_CREATED: TimelineEntry = {
  id: 'c:90',
  at: '2026-09-26T09:00:00Z',
  actor: { id: 'u-agent', displayName: 'Nadia Agent' },
  requestId: 'req-90',
  kind: 'change',
  table: 'leave_request',
  op: 'insert',
  changes: [
    { field: 'id', before: null, after: 'r-1', masked: false },
    { field: 'company_id', before: null, after: 'c-demo', masked: false },
    { field: 'employment_id', before: null, after: 'e-1', masked: false },
    { field: 'workflow_instance_id', before: null, after: 'wi-1', masked: false },
    { field: 'leave_type_id', before: null, after: 't-annual', masked: false },
    { field: 'start_date', before: null, after: '2026-10-05', masked: false },
    { field: 'days', before: null, after: 5, masked: false },
    { field: 'status', before: null, after: 'pending', masked: false },
  ],
};

/** The request approved (status column). */
export const LEAVE_APPROVED: TimelineEntry = {
  id: 'c:95',
  at: '2026-09-26T11:00:00Z',
  actor: { id: 'u-karim', displayName: 'Karim Haddad' },
  requestId: 'req-95',
  kind: 'change',
  table: 'leave_request',
  op: 'update',
  changes: [{ field: 'status', before: 'pending', after: 'approved', masked: false }],
};

/** A workflow task closed with an outcome. */
export const TASK_DONE: TimelineEntry = {
  id: 'c:94',
  at: '2026-09-26T10:59:00Z',
  actor: { id: 'u-karim', displayName: 'Karim Haddad' },
  requestId: 'req-95',
  kind: 'change',
  table: 'workflow_task',
  op: 'update',
  changes: [
    { field: 'status', before: 'open', after: 'done', masked: false },
    { field: 'outcome', before: null, after: 'approve', masked: false },
    { field: 'acted_by', before: null, after: 'u-karim', masked: false },
  ],
};

/** `workflow.approve` event (apps/api workflow-engine: data {instanceId, taskId, step}). */
export const WORKFLOW_APPROVE: TimelineEntry = {
  id: 'e:30',
  at: '2026-09-26T10:59:30Z',
  actor: { id: 'u-karim', displayName: 'Karim Haddad' },
  requestId: 'req-95',
  kind: 'event',
  event: { type: 'workflow.approve', data: { instanceId: 'wi-1', taskId: 'k-1', step: 'hr' } },
};
