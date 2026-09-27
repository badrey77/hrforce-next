/** Public surface of the Authorization module (the only file other modules may import). */
export { AuthorizationModule } from './authorization.module.js';
export { AccessClock } from './infra/access-clock.js';
export { ACCESS_PERMISSIONS, PERMISSION_CODES, SYSTEM_ROLES, type PermissionCode, type SystemRole } from './domain/catalogue.js';
export type { AccessUserView, GrantView, PermissionView, RoleView, SecurityPolicyView } from './application/access-views.js';
export { seedGrants, seedSecurityPolicy, seedSystemRoles, type SeedGrant } from './infra/access-seed.js';
export { DEMO_GRANTS, seedDemoAccess } from './infra/demo-access.js';
