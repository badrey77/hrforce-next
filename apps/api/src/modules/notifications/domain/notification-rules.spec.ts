import { describe, expect, it } from 'vitest';
import { audienceOf, decodeCursor, EMAIL_DEFAULTS, emailDefault, encodeCursor, linkOf, NOTIFICATION_TYPES, publicData } from './notification-rules.js';

const ID = '0190a5d0-0000-7000-8000-000000000abc';

describe('notification rules', () => {
  it('has an e-mail default for every type (contract table)', () => {
    expect(Object.keys(EMAIL_DEFAULTS).toSorted()).toEqual([...NOTIFICATION_TYPES].toSorted());
    expect(NOTIFICATION_TYPES.filter((t) => EMAIL_DEFAULTS[t]).toSorted()).toEqual(['document.ready', 'document.rejected', 'leave.approved', 'leave.rejected', 'leave.submitted_on_behalf', 'task.assigned']);
    expect(emailDefault('unknown.type')).toBe(false);
  });

  it('links: task → /tasks?task=, cancelled → /tasks, leave → own /me/leave or HR detail', () => {
    expect(linkOf({ type: 'task.assigned', subjectType: 'workflow_task', subjectId: ID, data: {} })).toBe(`/tasks?task=${ID}`);
    expect(linkOf({ type: 'leave.cancelled', subjectType: 'leave_request', subjectId: ID, data: { audience: 'approver' } })).toBe('/tasks');
    expect(linkOf({ type: 'leave.approved', subjectType: 'leave_request', subjectId: ID, data: { audience: 'employee' } })).toBe(`/me/leave?request=${ID}`);
    expect(linkOf({ type: 'leave.rejected', subjectType: 'leave_request', subjectId: ID, data: { audience: 'requester' } })).toBe(`/leave/requests/${ID}`);
    expect(linkOf({ type: 'task.escalated', subjectType: 'leave_request', subjectId: ID, data: { audience: 'employee' } })).toBe(`/me/leave?request=${ID}`);
    expect(linkOf({ type: 'document.ready', subjectType: 'issued_document', subjectId: ID, data: { audience: 'employee' } })).toBe(`/me/documents?document=${ID}`);
    expect(linkOf({ type: 'document.rejected', subjectType: 'document_request', subjectId: ID, data: { audience: 'employee' } })).toBe(`/me/documents?request=${ID}`);
  });

  it('publicData drops the audience and non-scalar values', () => {
    expect(publicData({ audience: 'employee', employeeName: 'A B', days: 2.5, x: { y: 1 }, n: null })).toEqual({ employeeName: 'A B', days: 2.5, x: null, n: null });
  });

  it('audienceOf reads the internal audience, null when absent or unknown', () => {
    expect(audienceOf({ audience: 'employee' })).toBe('employee');
    expect(audienceOf({ audience: 'requester' })).toBe('requester');
    expect(audienceOf({ audience: 'approver' })).toBe('approver');
    expect(audienceOf({})).toBeNull();
    expect(audienceOf({ audience: 'boss' })).toBeNull();
  });

  it('cursor round-trips and rejects garbage', () => {
    const cursor = { at: '2026-09-27T10:11:12.123456Z', id: ID };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor('not a cursor!')).toBeNull();
    expect(decodeCursor(Buffer.from('2026-09-27|x').toString('base64url'))).toBeNull();
  });
});
