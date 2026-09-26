import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, fieldChanges, parseSubject } from './timeline.js';

const ID = '0190A5D0-0000-7000-8000-000000000101';

describe('timeline subject', () => {
  it('parses <type>:<uuid> and lower-cases the id', () => {
    expect(parseSubject(`org_unit:${ID}`)).toEqual({ ok: true, subject: { type: 'org_unit', id: ID.toLowerCase() } });
    expect(parseSubject(`user:${ID}`).ok).toBe(true);
    expect(parseSubject(`employee:${ID}`).ok).toBe(true);
  });

  it('rejects unknown types and bad syntax (422) but reports a malformed id as unknown (404)', () => {
    expect(parseSubject(`payslip:${ID}`)).toEqual({ ok: false, reason: 'syntax' });
    expect(parseSubject(ID)).toEqual({ ok: false, reason: 'syntax' });
    expect(parseSubject(':x')).toEqual({ ok: false, reason: 'syntax' });
    expect(parseSubject('site:not-a-uuid')).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('timeline cursor', () => {
  it('round-trips and refuses tampered values', () => {
    const cursor = { at: '2026-09-26T11:09:47.059884Z', kind: 1 as const, id: '42' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor('not base64!')).toBeNull();
    expect(decodeCursor(Buffer.from('2026-09-26T11:09:47Z|0|1').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('2026-09-26T11:09:47.059884Z|2|1').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('2026-09-26T11:09:47.059884Z|0|1;drop').toString('base64url'))).toBeNull();
  });
});

describe('field changes', () => {
  it('lists the changed columns with before/after, masking non-null values of masked columns', () => {
    const changes = fieldChanges(
      { before: { id: 'x', name: 'Old', iban: 'DZ12' }, after: { id: 'x', name: 'New', iban: '***' }, changed: ['name', 'iban'] },
      new Set(['iban']),
    );
    expect(changes).toEqual([
      { field: 'name', before: 'Old', after: 'New', masked: false },
      { field: 'iban', before: '***', after: '***', masked: true },
    ]);
  });

  it('insert/delete: the missing image is null', () => {
    expect(fieldChanges({ before: null, after: { a: 1, b: null }, changed: ['a', 'b'] }, new Set(['b']))).toEqual([
      { field: 'a', before: null, after: 1, masked: false },
      { field: 'b', before: null, after: null, masked: true },
    ]);
  });
});
