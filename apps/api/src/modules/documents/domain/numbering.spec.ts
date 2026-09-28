import { describe, expect, it } from 'vitest';
import { formatNumber, isValidNumberFormat, specimenNumber } from './numbering.js';

describe('number formats', () => {
  it('formats the defaults', () => {
    expect(formatNumber('ATT-{YYYY}-{SEQ:5}', 2026, 42)).toBe('ATT-2026-00042');
    expect(formatNumber('CT-{YYYY}-{SEQ:5}', 2027, 1)).toBe('CT-2027-00001');
    expect(formatNumber('TC/{YY}/{SEQ}', 2026, 7)).toBe('TC/26/7');
  });

  it('pads to at least n digits and grows beyond', () => {
    expect(formatNumber('A{YYYY}{SEQ:3}', 2026, 5)).toBe('A2026005');
    expect(formatNumber('A{YYYY}{SEQ:3}', 2026, 12345)).toBe('A202612345');
  });

  it('shows an ellipsis for previews', () => {
    expect(specimenNumber('ATT-{YYYY}-{SEQ:5}', 2026)).toBe('ATT-2026-…');
  });

  it.each([
    ['', 'empty'],
    ['ATT-{SEQ}', 'no year'],
    ['ATT-{YYYY}', 'no sequence'],
    ['ATT-{YYYY}-{SEQ}-{SEQ:2}', 'two sequences'],
    ['att-{YYYY}-{SEQ}', 'lower case literal'],
    ['ATT {YYYY}-{SEQ}', 'space'],
    ['ATT-{YYYY}-{SEQ:0}', 'width 0'],
    ['ATT-{YYYY}-{SEQ:10}', 'width 10'],
    ['ATT-{YEAR}-{SEQ}', 'unknown token'],
    ['{YYYY}-{SEQ}#', 'bad character'],
    [`${'A'.repeat(32)}-{YYYY}-{SEQ:5}`, 'too long once rendered'],
  ])('rejects %s (%s)', (format) => {
    expect(isValidNumberFormat(format)).toBe(false);
  });

  it.each(['ATT-{YYYY}-{SEQ:5}', '{YY}/{SEQ}', 'RH.{YYYY}_{SEQ:9}', 'CT-{YYYY}-0{SEQ:4}'])('accepts %s', (format) => {
    expect(isValidNumberFormat(format)).toBe(true);
  });
});
