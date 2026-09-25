import { describe, expect, it } from 'vitest';
import {
  assertNoCycle,
  assertParentAllowed,
  assertRootSite,
  isOrgUnitCode,
  KindCatalogue,
  normalizeName,
  type OrgKind,
  OrgRuleViolation,
  wouldCreateCycle,
} from './org-unit.js';

/** The v2 kind catalogue as seeded by migration 0006. */
const def = (code: string, sortOrder: number, allowedParents: string[], isRoot = false): OrgKind => ({
  code,
  isRoot,
  sortOrder,
  labels: { fr: code, ar: code, en: code },
  allowedParents,
});

const kinds = new KindCatalogue([
  def('service', 50, ['department', 'region', 'agency']),
  def('direction_generale', 10, [], true),
  def('department', 20, ['direction_generale']),
  def('region', 30, ['department']),
  def('agency', 40, ['region']),
]);

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

  it('catalogue: sorted by sortOrder, one root, create_child only for kinds that are a parent of some kind', () => {
    expect(kinds.kinds.map((k) => k.code)).toEqual(['direction_generale', 'department', 'region', 'agency', 'service']);
    expect(kinds.isRoot('direction_generale')).toBe(true);
    expect(kinds.isRoot('department')).toBe(false);
    expect(kinds.creatableKinds()).toEqual(['department', 'region', 'agency', 'service']);
    for (const k of ['direction_generale', 'department', 'region', 'agency']) expect(kinds.canHaveChildren(k), k).toBe(true);
    expect(kinds.canHaveChildren('service')).toBe(false);
    expect(kinds.canHaveChildren('unknown')).toBe(false);
    expect(kinds.sortOrder('unknown')).toBeGreaterThan(kinds.sortOrder('service'));
  });

  it('parent rules come from the catalogue: every allowed pair passes, every other pair is invalid_parent_kind', () => {
    const allowed = new Set([
      'department<direction_generale',
      'region<department',
      'agency<region',
      'service<department',
      'service<region',
      'service<agency',
    ]);
    for (const child of kinds.creatableKinds()) {
      for (const parent of kinds.kinds.map((k) => k.code)) {
        const run = () => assertParentAllowed(kinds, child, { kind: parent });
        if (allowed.has(`${child}<${parent}`)) expect(run, `${child} under ${parent}`).not.toThrow();
        else
          expect(violation(run), `${child} under ${parent}`).toMatchObject({
            slug: 'org-unit-invalid-parent',
            field: 'parentId',
            code: 'invalid_parent_kind',
          });
      }
    }
    expect(violation(() => assertParentAllowed(kinds, 'service', undefined))).toMatchObject({ slug: 'org-unit-invalid-parent', code: 'not_found' });
    expect(violation(() => assertParentAllowed(kinds, 'direction_generale', { kind: 'department' })).slug).toBe('org-unit-root-immutable');
  });

  it('the root unit must keep a site', () => {
    expect(() => assertRootSite(kinds, 'direction_generale', 'site-1')).not.toThrow();
    expect(() => assertRootSite(kinds, 'agency', null)).not.toThrow();
    expect(violation(() => assertRootSite(kinds, 'direction_generale', null))).toMatchObject({
      slug: 'org-unit-root-site-required',
      field: 'siteId',
    });
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
