/** Public surface of the Organization module (the only file other modules may import). */
export { OrganizationModule } from './organization.module.js';
export { OrgUnitsService } from './application/org-units.service.js';
export { SitesService } from './application/sites.service.js';
export { OrgClock } from './application/org-clock.js';
export { ORG_PERMISSIONS, SITE_PERMISSIONS } from './application/org-actions.js';
export type {
  OrgKindsView,
  OrgTreeNode,
  OrgTreeView,
  OrgUnitDetail,
  OrgUnitSearchView,
  OrgUnitSummary,
  Site,
  SiteRef,
  SitesView,
} from './application/org-views.js';
export type { OrgAction, OrgKind, OrgUnitKind } from './domain/org-unit.js';
export { isIsoDate, toIsoDate } from './domain/versions.js';
export { ancestorPath, effectiveSite, type EffectiveSite, type OrgSnapshotUnit } from './domain/tree.js';
export {
  DEMO_COMPANY_ID,
  DEMO_ORGANIZATION,
  DEMO_USER_ID,
  seedOrganization,
  type SeedOrganization,
  type SeedSite,
  type SeedUnit,
} from './infra/demo-seed.js';
