/** Public surface of the Leave module (the only file other modules may import). */
export { LeaveModule } from './leave.module.js';
export { LeaveClock } from './application/leave-clock.js';
export { LEAVE_PERMISSIONS } from './application/leave.service.js';
export { runAccruals, type AccrualRunResult } from './infra/accrual-run.js';
export { DEFAULT_HOLIDAYS, DEFAULT_LEAVE_TYPES, seedLeaveDefaults } from './infra/leave-defaults.js';
export { DEMO_HEADS, demoEmployment, LEAVE_DEMO, LEAVE_DEMO_USERS, seedDemoLeave, type SeedDemoLeaveOptions } from './infra/demo-leave.js';
