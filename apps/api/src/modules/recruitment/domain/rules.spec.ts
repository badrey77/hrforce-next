import { describe, expect, it } from 'vitest';
import { addMonths, algiersDate, isPositiveMoney, isPurgeDue, likeContains, moveTargets, openingReference, phoneKey, restoredStage, STAGES } from './rules.js';

describe('recruitment rules', () => {
  it('moveTargets: free moves between received / shortlisted / interview, reject or withdraw from them; nothing from a final stage', () => {
    expect(moveTargets('received')).toEqual(['shortlisted', 'interview', 'rejected', 'withdrawn']);
    expect(moveTargets('shortlisted')).toEqual(['received', 'interview', 'rejected', 'withdrawn']);
    expect(moveTargets('interview')).toEqual(['received', 'shortlisted', 'rejected', 'withdrawn']);
    // the offer has its own endpoints (Phase B): only a rejection goes through the move
    expect(moveTargets('offer')).toEqual(['rejected']);
    for (const stage of ['hired', 'rejected', 'withdrawn'] as const) expect(moveTargets(stage)).toEqual([]);
    for (const stage of STAGES) expect(moveTargets(stage)).not.toContain(stage);
    for (const stage of STAGES) expect(moveTargets(stage).some((s) => s === 'offer' || s === 'hired')).toBe(false);
  });

  it('restoredStage: the stage before the closing; an offer comes back as an interview', () => {
    expect(restoredStage('received')).toBe('received');
    expect(restoredStage('interview')).toBe('interview');
    expect(restoredStage('offer')).toBe('interview');
    expect(restoredStage(null)).toBe('received');
    expect(restoredStage('rejected')).toBe('received');
  });

  it('openingReference: REC-<year>-<4 digits, more when needed>', () => {
    expect(openingReference(2026, 1)).toBe('REC-2026-0001');
    expect(openingReference(2026, 417)).toBe('REC-2026-0417');
    expect(openingReference(2027, 12345)).toBe('REC-2027-12345');
  });

  it('phoneKey: one key for the ways of writing an Algerian number', () => {
    for (const phone of ['0555 12 34 56', '+213 555 12 34 56', '00213555123456', '213-555-123-456', '(0555) 123.456']) expect(phoneKey(phone), phone).toBe('555123456');
    expect(phoneKey('+33 6 12 34 56 78')).toBe('33612345678');
    expect(phoneKey('0')).toBe('0');
    expect(phoneKey('poste 12')).toBe('12');
    expect(phoneKey('')).toBeNull();
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey('—')).toBeNull();
  });

  it('retention: due when the Algiers date of the decision + the months is before today', () => {
    expect(addMonths('2027-05-15', 12)).toBe('2028-05-15');
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('2028-02-29', 12)).toBe('2029-02-28');
    expect(addMonths('2027-11-30', 3)).toBe('2028-02-29');
    expect(isPurgeDue('2027-05-15', 12, '2028-05-15')).toBe(false);
    expect(isPurgeDue('2027-05-15', 12, '2028-05-16')).toBe(true);
    expect(isPurgeDue('2027-05-15', 1, '2027-06-16')).toBe(true);
    // Algiers is UTC+1: 23:30 UTC is already the next day
    expect(algiersDate(Date.parse('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(algiersDate(Date.parse('2026-12-31T22:59:00Z'))).toBe('2026-12-31');
  });

  it('money and search helpers', () => {
    for (const ok of ['85000', '85000.5', '85000.50', '1']) expect(isPositiveMoney(ok), ok).toBe(true);
    for (const bad of ['0', '0.00', '-5', '85 000', '85000.505', '12345678901', 'abc', '']) expect(isPositiveMoney(bad), bad).toBe(false);
    expect(likeContains('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
  });
});
