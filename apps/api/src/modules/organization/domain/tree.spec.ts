import { describe, expect, it } from 'vitest';
import { ancestorPath, buildTree, type OrgSnapshotUnit } from './tree.js';

const units: OrgSnapshotUnit[] = [
  { id: 's2', kind: 'site', code: 'BLIDA', name: 'Blida', parentId: 'r1' },
  { id: 'r2', kind: 'region', code: 'EST', name: 'Région Est', parentId: 'c' },
  { id: 'c', kind: 'company', code: 'GROUPE', name: 'Groupe', parentId: null },
  { id: 'r1', kind: 'region', code: 'CENTRE', name: 'Région Centre', parentId: 'c' },
  { id: 's1', kind: 'site', code: 'ALG-HQ', name: 'Alger', parentId: 'r1' },
  { id: 'orphan', kind: 'site', code: 'ZZ', name: 'Orphan', parentId: 'missing' },
];

describe('org tree', () => {
  it('builds the tree from the company root with children sorted by code', () => {
    const root = buildTree(units);
    expect(root?.unit.code).toBe('GROUPE');
    expect(root?.children.map((c) => c.unit.code)).toEqual(['CENTRE', 'EST']);
    expect(root?.children[0]?.children.map((c) => c.unit.code)).toEqual(['ALG-HQ', 'BLIDA']);
    expect(buildTree(units.filter((u) => u.kind !== 'company'))).toBeUndefined();
  });

  it('ancestor paths run from the root down to the parent', () => {
    const byId = new Map(units.map((u) => [u.id, u]));
    expect(ancestorPath('r1', byId)).toEqual([
      { id: 'c', name: 'Groupe' },
      { id: 'r1', name: 'Région Centre' },
    ]);
    expect(ancestorPath(null, byId)).toEqual([]);
  });
});
