import { describe, expect, it } from 'vitest';
import {
  assertNoCycle,
  assertParentAllowed,
  canHaveChildren,
  isOrgUnitCode,
  normalizeName,
  OrgRuleViolation,
  requiredParentKind,
  wouldCreateCycle,
} from './org-unit.js';

function violation(fn: () => void): OrgRuleViolation {
  try {
    fn();
  } catch (error) {
    if (error instanceof OrgRuleViolation) return error;
    throw error;
  }
  throw new Error('expected an OrgRuleViolation');
}

describe('org unit rules', () => {
  it('codes: ^[A-Z0-9][A-Z0-9_-]{1,31}$', () => {
    for (const ok of ['GROUPE', 'ALG-HQ', 'A1', 'X_Y-Z', '9' + 'A'.repeat(31)]) expect(isOrgUnitCode(ok), ok).toBe(true);
    for (const bad of ['A', 'alg-hq', '-AB', '_AB', 'AB CD', 'ÉTÉ', 'A'.repeat(33), '']) expect(isOrgUnitCode(bad), bad).toBe(false);
  });

  it('names are trimmed and 1–120 chars', () => {
    expect(normalizeName('  Région Est ')).toBe('Région Est');
    expect(normalizeName('   ')).toBeNull();
    expect(normalizeName('x'.repeat(120))).toHaveLength(120);
    expect(normalizeName(` ${'x'.repeat(120)} `)).toHaveLength(120);
    expect(normalizeName('x'.repeat(121))).toBeNull();
  });

  it('parent rules: region → company, site → region, company is the root', () => {
    expect(requiredParentKind('company')).toBeNull();
    expect(requiredParentKind('region')).toBe('company');
    expect(requiredParentKind('site')).toBe('region');
    expect(canHaveChildren('company')).toBe(true);
    expect(canHaveChildren('region')).toBe(true);
    expect(canHaveChildren('site')).toBe(false);

    expect(() => assertParentAllowed('region', { kind: 'company' })).not.toThrow();
    expect(() => assertParentAllowed('site', { kind: 'region' })).not.toThrow();
    expect(violation(() => assertParentAllowed('site', { kind: 'company' }))).toMatchObject({
      slug: 'org-unit-invalid-parent',
      field: 'parentId',
      code: 'invalid_parent_kind',
    });
    expect(violation(() => assertParentAllowed('region', { kind: 'site' })).slug).toBe('org-unit-invalid-parent');
    expect(violation(() => assertParentAllowed('site', undefined))).toMatchObject({ slug: 'org-unit-invalid-parent', code: 'not_found' });
    expect(violation(() => assertParentAllowed('company', { kind: 'company' })).slug).toBe('org-unit-root-immutable');
  });

  it('cycle detection', () => {
    // root ← a ← b ← c
    const parents: Record<string, string | null> = { root: null, a: 'root', b: 'a', c: 'b', other: 'root' };
    const parentOf = (id: string) => parents[id];
    expect(wouldCreateCycle('a', 'a', parentOf)).toBe(true);
    expect(wouldCreateCycle('a', 'c', parentOf)).toBe(true);
    expect(wouldCreateCycle('b', 'c', parentOf)).toBe(true);
    expect(wouldCreateCycle('c', 'other', parentOf)).toBe(false);
    expect(wouldCreateCycle('b', 'root', parentOf)).toBe(false);
    expect(violation(() => assertNoCycle('a', 'b', parentOf))).toMatchObject({ slug: 'org-unit-cycle', field: 'parentId' });
    // a corrupt pre-existing cycle is refused instead of looping forever
    const loop: Record<string, string> = { x: 'y', y: 'x' };
    expect(wouldCreateCycle('z', 'x', (id) => loop[id])).toBe(true);
  });
});
