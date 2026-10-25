import { describe, expect, it } from 'vitest';
import {
  changedFields,
  familyToApply,
  fileTitle,
  filesRequired,
  maskBankValue,
  maskNin,
  maskRib,
  modeOf,
  purgeDue,
  sameSection,
  workflowOf,
  type ContactValues,
  type FamilyValues,
} from './profile.js';

const contact: ContactValues = {
  mobilePhone: '+213555123456',
  otherPhone: null,
  personalEmail: 'a@example.dz',
  addressLine: '12 rue des Oliviers',
  commune: 'Annaba',
  wilayaCode: '23',
  postalCode: '23000',
};

const family: FamilyValues = {
  maritalStatus: 'married',
  maritalStatusSince: '2018-06-01',
  spouseEmployed: 'no',
  children: [
    { id: 'c1', firstName: 'Lina', birthDate: '2019-04-02', sex: 'F', dependent: true },
    { id: 'c2', firstName: 'Adam', birthDate: '2021-09-12', sex: 'M', dependent: true },
  ],
};

describe('changedFields', () => {
  it('lists the contact fields that differ (null and undefined are equal)', () => {
    expect(changedFields('contact', contact, { ...contact })).toEqual([]);
    expect(changedFields('contact', contact, { ...contact, mobilePhone: '+213555000000', commune: 'El Bouni' })).toEqual(['mobilePhone', 'commune']);
    expect(changedFields('contact', { ...contact, otherPhone: undefined }, contact)).toEqual([]);
  });

  it('emergency: adding or removing the person changes every field', () => {
    const person = { fullName: 'Samia B.', relationship: 'spouse', phone: '+213555111222' };
    expect(changedFields('emergency', null, null)).toEqual([]);
    expect(changedFields('emergency', null, person)).toEqual(['fullName', 'relationship', 'phone']);
    expect(changedFields('emergency', person, null)).toEqual(['fullName', 'relationship', 'phone']);
    expect(changedFields('emergency', person, { ...person, phone: '+213555999999' })).toEqual(['phone']);
  });

  it('family: children added, removed, changed or reordered', () => {
    expect(changedFields('family', family, { ...family, children: family.children.toReversed() })).toEqual([]);
    expect(changedFields('family', family, { ...family, children: [...family.children, { firstName: 'Yasmine', birthDate: '2025-01-01', sex: 'F', dependent: true }] })).toEqual(['children']);
    expect(changedFields('family', family, { ...family, children: family.children.slice(1) })).toEqual(['children']);
    const renamed = family.children.map((c) => (c.id === 'c2' ? { ...c, dependent: false } : c));
    expect(changedFields('family', family, { ...family, children: renamed })).toEqual(['children']);
    expect(changedFields('family', family, { ...family, maritalStatus: 'divorced', spouseEmployed: null })).toEqual(['maritalStatus', 'spouseEmployed']);
  });

  it('bank and identity note', () => {
    expect(changedFields('bank', { rib: '00799999000123456789', bankName: 'BNA' }, { rib: '00799999000123456789', bankName: 'CPA' })).toEqual(['bankName']);
    expect(changedFields('identity_note', null, { note: 'Ma date de naissance est fausse' })).toEqual(['note']);
  });
});

describe('sameSection (changed since the request)', () => {
  it('compares the section values; an identity note never changes', () => {
    expect(sameSection('contact', contact, { ...contact })).toBe(true);
    expect(sameSection('contact', contact, { ...contact, postalCode: '23001' })).toBe(false);
    expect(sameSection('identity_note', { note: 'a' }, { note: 'b' })).toBe(true);
  });
});

describe('filesRequired', () => {
  it('family only when the marital status or the children change; bank always', () => {
    expect(filesRequired('family', ['spouseEmployed'])).toBe(false);
    expect(filesRequired('family', ['maritalStatus'])).toBe(true);
    expect(filesRequired('family', ['maritalStatusSince'])).toBe(true);
    expect(filesRequired('family', ['spouseEmployed', 'children'])).toBe(true);
    expect(filesRequired('bank', ['bankName'])).toBe(true);
    expect(filesRequired('contact', ['mobilePhone'])).toBe(false);
    expect(filesRequired('emergency', ['phone'])).toBe(false);
    expect(filesRequired('identity_note', ['note'])).toBe(false);
  });
});

describe('modes and workflows', () => {
  const modes = { contact: 'immediate', emergency: 'immediate', family: 'approval' } as const;
  it('bank and identity note always need approval', () => {
    expect(modeOf('contact', modes)).toBe('immediate');
    expect(modeOf('family', modes)).toBe('approval');
    expect(modeOf('bank', { ...modes, family: 'immediate' })).toBe('approval');
    expect(modeOf('identity_note', modes)).toBe('approval');
    expect(workflowOf('bank')).toBe('profile.bank');
    expect(workflowOf('family')).toBe('profile.hr');
    expect(workflowOf('identity_note')).toBe('profile.hr');
  });
});

describe('masking', () => {
  it('RIB and NIN keep the last 4 digits', () => {
    expect(maskRib('00799999000123456789')).toBe('•••• •••• 6789');
    expect(maskRib(null)).toBeNull();
    expect(maskRib('123')).toBe('••••');
    expect(maskNin('109870123456789012')).toBe('•••• 9012');
    expect(maskNin(undefined)).toBeNull();
    expect(maskBankValue({ rib: '00799999000123456789', bankName: 'BNA' })).toEqual({ rib: '•••• •••• 6789', bankName: 'BNA' });
    expect(maskBankValue(null)).toBeNull();
  });
});

describe('familyToApply', () => {
  it('a child removed by HR since the request is applied as a new one', () => {
    const applied = familyToApply(family, new Set(['c1']));
    expect(applied.children[0]).toEqual(family.children[0]);
    expect(applied.children[1]).toEqual({ firstName: 'Adam', birthDate: '2021-09-12', sex: 'M', dependent: true });
  });
});

describe('fileTitle', () => {
  it('names the section and the request date', () => {
    expect(fileTitle('family', '2026-10-24T08:00:00Z')).toBe('Situation familiale — demande du 24/10/2026');
  });
});

describe('purgeDue', () => {
  const now = new Date('2026-11-30T03:00:00Z');
  const decidedAt = new Date('2026-10-30T10:00:00Z');
  it('rejected / cancelled after the retention, approved once copied, never pending', () => {
    expect(purgeDue({ status: 'rejected', decidedAt, copied: false, retentionDays: 30, now })).toBe(true);
    expect(purgeDue({ status: 'cancelled', decidedAt, copied: false, retentionDays: 31, now })).toBe(false);
    expect(purgeDue({ status: 'approved', decidedAt: now, copied: true, retentionDays: 30, now })).toBe(true);
    expect(purgeDue({ status: 'approved', decidedAt: now, copied: false, retentionDays: 30, now })).toBe(false);
    expect(purgeDue({ status: 'pending', decidedAt: null, copied: false, retentionDays: 7, now })).toBe(false);
  });
});
