import { describe, expect, it } from 'vitest';
import { KindCatalogue, type OrgKind } from './org-unit.js';
import { ancestorPath, buildTree, effectiveSite, type OrgSnapshotUnit } from './tree.js';

/** The v2 kind catalogue as seeded by migration 0006. */
const def = (code: string, sortOrder: number, allowedParents: string[], isRoot = false): OrgKind => ({
  code,
  isRoot,
  sortOrder,
  labels: { fr: code, ar: code, en: code },
  allowedParents,
});

const V2_CATALOGUE = new KindCatalogue([
  def('service', 50, ['department', 'region', 'agency']),
  def('direction_generale', 10, [], true),
  def('department', 20, ['direction_generale']),
  def('region', 30, ['department']),
  def('agency', 40, ['region']),
]);

const u = (id: string, kind: string, code: string, parentId: string | null, siteId: string | null = null): OrgSnapshotUnit => ({
  id,
  kind,
  code,
  name: code,
  parentId,
  siteId,
});

const units: OrgSnapshotUnit[] = [
  u('srv-adm', 'service', 'SRV-ADM-EST', 'est'),
  u('ag-cne', 'agency', 'AG-CNE', 'est', 'site-cne'),
  u('ag-ann', 'agency', 'AG-ANNABA', 'est', 'site-ann'),
  u('srv-cli', 'service', 'SRV-CLI-ANB', 'ag-ann'),
  u('est', 'region', 'REG-EST', 'rx', 'site-cne2'),
  u('rx', 'department', 'DEP-RX', 'dg'),
  u('rh', 'department', 'DEP-RH', 'dg'),
  u('dg', 'direction_generale', 'DG', null, 'site-hq'),
  u('orphan', 'service', 'ZZ', 'missing'),
];
const byId = new Map(units.map((x) => [x.id, x]));

describe('org tree', () => {
  it('builds the tree from the root kind, children sorted by kind sortOrder then code', () => {
    const root = buildTree(units, V2_CATALOGUE);
    expect(root?.unit.code).toBe('DG');
    expect(root?.children.map((c) => c.unit.code)).toEqual(['DEP-RH', 'DEP-RX']);
    const est = root?.children[1]?.children[0];
    // agencies (sortOrder 40) before services (50), then by code
    expect(est?.children.map((c) => c.unit.code)).toEqual(['AG-ANNABA', 'AG-CNE', 'SRV-ADM-EST']);
    expect(buildTree(units.filter((x) => x.kind !== 'direction_generale'), V2_CATALOGUE)).toBeUndefined();
  });

  it('ancestor paths run from the root down to the parent', () => {
    expect(ancestorPath('est', byId).map((p) => p.id)).toEqual(['dg', 'rx', 'est']);
    expect(ancestorPath(null, byId)).toEqual([]);
  });

  it('effective site: own site, else the nearest ancestor with one', () => {
    expect(effectiveSite('site-ann', 'est', byId)).toEqual({ siteId: 'site-ann', inherited: false });
    expect(effectiveSite(null, 'ag-ann', byId)).toEqual({ siteId: 'site-ann', inherited: true }); // service under agency
    expect(effectiveSite(null, 'est', byId)).toEqual({ siteId: 'site-cne2', inherited: true }); // service under region
    expect(effectiveSite(null, 'rh', byId)).toEqual({ siteId: 'site-hq', inherited: true }); // two levels up
    expect(effectiveSite(null, 'missing', byId)).toEqual({ siteId: null, inherited: false });
    expect(effectiveSite(null, null, byId)).toEqual({ siteId: null, inherited: false });
  });
});
