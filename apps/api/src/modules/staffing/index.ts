/** Public surface of the Staffing module (the only file other modules may import). */
export { StaffingModule } from './staffing.module.js';
export { StaffingClock } from './application/staffing-clock.js';
export {
  StaffingService,
  type EmployeeCard,
  type EmployeeClaim,
  type HeadView,
  type MyEmploymentView,
  type UnitHeadsView,
  type UnitRef,
  type UserEmploymentView,
} from './application/staffing.service.js';
export type { ManagerResolution } from './domain/manager.js';
export { scopeAssignmentSql } from './infra/staffing.repository.js';
export { seedHeads, seedLinks, type SeedHead, type SeedLink } from './infra/staffing-seed.js';
