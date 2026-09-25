import type { HttpTestingController } from '@angular/common/http/testing';
import type { OrgKind, OrgKindList, Site } from '../app/core/org/org.models';

/** The kind catalogue as seeded by the contract (docs/contracts/organization.md v2). */
export const ORG_KINDS: readonly OrgKind[] = [
  {
    code: 'direction_generale',
    isRoot: true,
    sortOrder: 10,
    labels: { fr: 'Direction générale', ar: 'المديرية العامة', en: 'Head office' },
    allowedParents: [],
  },
  {
    code: 'department',
    isRoot: false,
    sortOrder: 20,
    labels: { fr: 'Département', ar: 'دائرة', en: 'Department' },
    allowedParents: ['direction_generale'],
  },
  {
    code: 'region',
    isRoot: false,
    sortOrder: 30,
    labels: { fr: 'Région', ar: 'منطقة', en: 'Region' },
    allowedParents: ['department'],
  },
  {
    code: 'agency',
    isRoot: false,
    sortOrder: 40,
    labels: { fr: 'Agence', ar: 'وكالة', en: 'Agency' },
    allowedParents: ['region'],
  },
  {
    code: 'service',
    isRoot: false,
    sortOrder: 50,
    labels: { fr: 'Service', ar: 'مصلحة', en: 'Service' },
    allowedParents: ['department', 'region', 'agency'],
  },
];

export const ORG_KIND_LIST: OrgKindList = { items: ORG_KINDS };

export const SITE_HQ: Site = { id: 's-hq', code: 'ALG-HQ', name: 'Alger – Siège', wilaya: 'Alger', address: null };
export const SITE_CNE: Site = { id: 's-cne', code: 'CNE', name: 'Constantine', wilaya: 'Constantine', address: null };
export const SITE_ANNABA: Site = { id: 's-annaba', code: 'ANNABA', name: 'Annaba', wilaya: 'Annaba', address: '1 rue du Port' };
export const SITES: readonly Site[] = [SITE_HQ, SITE_ANNABA, SITE_CNE];

/** Answers the one `GET /api/org/kinds` the KindCatalog sends (call after a `TestBed.tick()`). */
export function flushKinds(http: HttpTestingController): void {
  http.expectOne('/api/org/kinds').flush(ORG_KIND_LIST);
}
