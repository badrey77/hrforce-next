import { numberFormatError, parseNumber, renderNumber } from './documents.models';

describe('number format helpers', () => {
  it('renders year and zero-padded sequence tokens', () => {
    expect(renderNumber('ATT-{YYYY}-{SEQ:5}', 2026, 42)).toBe('ATT-2026-00042');
    expect(renderNumber('TC/{YY}/{SEQ}', 2026, 7)).toBe('TC/26/7');
    expect(renderNumber('CT-{YYYY}-{SEQ:2}', 2026, 123)).toBe('CT-2026-123');
  });

  it('validates the format like the API (literals, one SEQ, a year, 40 characters)', () => {
    expect(numberFormatError('ATT-{YYYY}-{SEQ:5}')).toBeNull();
    expect(numberFormatError('att-{YYYY}-{SEQ}')).toBe('literal');
    expect(numberFormatError('ATT {YYYY}#{SEQ}')).toBe('literal');
    expect(numberFormatError('ATT-{YYYY}')).toBe('seq');
    expect(numberFormatError('ATT-{YYYY}-{SEQ}-{SEQ}')).toBe('seq');
    expect(numberFormatError('ATT-{SEQ:5}')).toBe('year');
    expect(numberFormatError(`${'A'.repeat(36)}{YYYY}{SEQ}`)).toBe('length');
  });

  it('reads year and sequence back from a number rendered with a format', () => {
    expect(parseNumber('ATT-{YYYY}-{SEQ:5}', 'ATT-2026-00043')).toEqual({ year: 2026, seq: 43 });
    expect(parseNumber('TC.{YY}.{SEQ}', 'TC.26.9')).toEqual({ year: 2026, seq: 9 });
    expect(parseNumber('ATT-{YYYY}-{SEQ:5}', 'CT-2026-00001')).toBeNull();
  });
});
