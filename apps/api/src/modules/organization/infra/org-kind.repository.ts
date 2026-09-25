import { Injectable } from '@nestjs/common';
import { currentTx } from '../../../platform/context/request-context.js';
import { KindCatalogue, type OrgKind } from '../domain/org-unit.js';

/**
 * The kind catalogue (org_unit_kind + org_unit_kind_parent): global reference data seeded by migrations, so it is
 * cached for the life of the process (one cache per provider instance, i.e. per app). The first load reads through
 * the request transaction like every other query; a failed load is not cached.
 */
@Injectable()
export class OrgKindRepository {
  private cached: KindCatalogue | undefined;

  async catalogue(): Promise<KindCatalogue> {
    if (this.cached) return this.cached;
    const tx = currentTx();
    const [kinds, parents] = await Promise.all([
      tx.selectFrom('org_unit_kind').select(['code', 'label_fr', 'label_ar', 'label_en', 'sort_order', 'is_root']).execute(),
      tx.selectFrom('org_unit_kind_parent').select(['kind', 'parent_kind']).orderBy('parent_kind').execute(),
    ]);
    const entries: OrgKind[] = kinds.map((k) => ({
      code: k.code,
      isRoot: k.is_root,
      sortOrder: k.sort_order,
      labels: { fr: k.label_fr, ar: k.label_ar, en: k.label_en },
      allowedParents: parents.filter((p) => p.kind === k.code).map((p) => p.parent_kind),
    }));
    // allowedParents in catalogue order (sortOrder), not alphabetical
    const order = new Map(entries.map((k) => [k.code, k.sortOrder]));
    const sorted = entries.map((k) => ({
      ...k,
      allowedParents: k.allowedParents.toSorted((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
    }));
    this.cached = new KindCatalogue(sorted);
    return this.cached;
  }
}
