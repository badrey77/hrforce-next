import { describe, expect, it } from 'vitest';
import { checkCorrectionRequest, type CorrectionRequestFacts } from './corrections.js';
import { csvCell, hoursMinutes, toCsv } from './csv.js';
import { algiersInstant } from './time.js';

const TODAY = '2026-09-30';
const P1 = '0190a5d0-0000-7000-9a75-000000000001';
const P2 = '0190a5d0-0000-7000-9a75-000000000002';
const PV = '0190a5d0-0000-7000-9a75-000000000003';

function facts(extra: Partial<CorrectionRequestFacts> = {}): CorrectionRequestFacts {
  return {
    date: '2026-09-28',
    today: TODAY,
    nowMs: algiersInstant(TODAY, '10:00'),
    maxAgeDays: 30,
    employment: { hireDate: '2020-01-01', endDate: null },
    changes: [{ action: 'add', direction: 'in', time: '08:00' }],
    dayPunches: [
      { id: P1, status: 'live', occurredAtMs: algiersInstant('2026-09-28', '08:20') },
      { id: P2, status: 'live', occurredAtMs: algiersInstant('2026-09-28', '16:30') },
      { id: PV, status: 'void', occurredAtMs: algiersInstant('2026-09-28', '12:00') },
    ],
    ...extra,
  };
}

describe('checkCorrectionRequest', () => {
  it('a valid request → the changes in position order with their instants', () => {
    const r = checkCorrectionRequest(facts({ changes: [{ action: 'void', punchId: P1 }, { action: 'add', direction: 'in', time: '08:00' }] }));
    expect(r).toEqual({
      ok: true,
      changes: [
        { position: 0, action: 'void', direction: null, occurredAtMs: null, punchId: P1 },
        { position: 1, action: 'add', direction: 'in', occurredAtMs: algiersInstant('2026-09-28', '08:00'), punchId: null },
      ],
    });
  });

  it('the window: today and exactly 30 days back are allowed; 31 days, the future and outside the employment are not', () => {
    expect(checkCorrectionRequest(facts({ date: TODAY, changes: [{ action: 'add', direction: 'in', time: '08:00' }] })).ok).toBe(true);
    expect(checkCorrectionRequest(facts({ date: '2026-08-31', dayPunches: [] })).ok).toBe(true);
    for (const f of [facts({ date: '2026-08-30' }), facts({ date: '2026-10-01' }), facts({ employment: { hireDate: '2026-09-29', endDate: null } }), facts({ employment: { hireDate: '2020-01-01', endDate: '2026-09-27' } })]) {
      expect(checkCorrectionRequest(f)).toEqual({ ok: false, kind: 'date' });
    }
    expect(checkCorrectionRequest(facts({ date: '2026-09-25', maxAgeDays: 3 })).ok).toBe(false);
  });

  it('1 to 4 changes', () => {
    expect(checkCorrectionRequest(facts({ changes: [] }))).toMatchObject({ kind: 'invalid', errors: [{ field: 'changes', code: 'min_items' }] });
    const five = ['07:00', '07:10', '07:20', '07:30', '07:40'].map((time) => ({ action: 'add' as const, direction: 'in' as const, time }));
    expect(checkCorrectionRequest(facts({ changes: five }))).toMatchObject({ kind: 'invalid', errors: [{ field: 'changes', code: 'max_items' }] });
    expect(checkCorrectionRequest(facts({ changes: five.slice(0, 4) })).ok).toBe(true);
  });

  it('an add in the future, at the minute of a live punch not voided, twice the same minute', () => {
    const today = checkCorrectionRequest(facts({ date: TODAY, dayPunches: [], changes: [{ action: 'add', direction: 'out', time: '10:01' }] }));
    expect(today).toMatchObject({ kind: 'invalid', errors: [{ field: 'changes.0.time', code: 'future' }] });
    expect(checkCorrectionRequest(facts({ changes: [{ action: 'add', direction: 'in', time: '08:20' }] }))).toMatchObject({ errors: [{ field: 'changes.0.time', code: 'exists' }] });
    // replacing the 08:20 punch by one at the same minute is fine when the request voids it
    expect(checkCorrectionRequest(facts({ changes: [{ action: 'void', punchId: P1 }, { action: 'add', direction: 'in', time: '08:20' }] })).ok).toBe(true);
    // the minute of a VOID punch is free
    expect(checkCorrectionRequest(facts({ changes: [{ action: 'add', direction: 'out', time: '12:00' }] })).ok).toBe(true);
    const twice = checkCorrectionRequest(facts({ changes: [{ action: 'add', direction: 'in', time: '07:50' }, { action: 'add', direction: 'out', time: '07:50' }] }));
    expect(twice).toMatchObject({ errors: [{ field: 'changes.1.time', code: 'duplicate' }] });
  });

  it('a void of a void punch, of an unknown punch, or twice the same punch', () => {
    expect(checkCorrectionRequest(facts({ changes: [{ action: 'void', punchId: PV }] }))).toMatchObject({ errors: [{ field: 'changes.0.punchId', code: 'not_found' }] });
    expect(checkCorrectionRequest(facts({ changes: [{ action: 'void', punchId: '0190a5d0-0000-7000-9a75-00000000ffff' }] }))).toMatchObject({ errors: [{ code: 'not_found' }] });
    const twice = checkCorrectionRequest(facts({ changes: [{ action: 'void', punchId: P2 }, { action: 'void', punchId: P2.toUpperCase() }] }));
    expect(twice).toMatchObject({ errors: [{ field: 'changes.1.punchId', code: 'duplicate' }] });
  });
});

describe('CSV', () => {
  it('formula injection: = + - @ TAB CR are prefixed with a quote; numbers untouched', () => {
    expect(['=1+1', '+33', '-2', '@SUM(A1)', '\tx', '\rx'].map(csvCell)).toEqual(["'=1+1", "'+33", "'-2", "'@SUM(A1)", "'\tx", "\"'\rx\""]);
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('Benali')).toBe('Benali');
  });

  it('quoting: separator, quotes and line breaks', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('dit "x"')).toBe('"dit ""x"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell('2026-09-01,2026-09-02')).toBe('2026-09-01,2026-09-02');
  });

  it('file: BOM, ; separator, CRLF; h:mm', () => {
    expect(toCsv([['a', 1], ['بن علي', '=x']])).toBe("﻿a;1\r\nبن علي;'=x\r\n");
    expect([0, 59, 60, 2410].map(hoursMinutes)).toEqual(['0:00', '0:59', '1:00', '40:10']);
  });
});
