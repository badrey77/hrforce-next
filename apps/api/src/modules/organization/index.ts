/** Public surface of the Organization module (the only file other modules may import). */
export { OrganizationModule } from './organization.module.js';
export { OrgUnitsService } from './application/org-units.service.js';
export { OrgClock } from './application/org-clock.js';
export { ORG_PERMISSIONS } from './application/org-actions.js';
export type { OrgTreeNode, OrgTreeView, OrgUnitDetail, OrgUnitSearchView, OrgUnitSummary } from './application/org-views.js';
export type { OrgAction, OrgUnitKind } from './domain/org-unit.js';
export { toIsoDate } from './domain/versions.js';
export {
  DEMO_COMPANY_ID,
  DEMO_ORGANIZATION,
  DEMO_USER_ID,
  seedOrganization,
  type SeedOrganization,
  type SeedUnit,
} from './infra/demo-seed.js';
