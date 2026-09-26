/** Public surface of the Employment module (the only file other modules may import). */
export { EmploymentModule } from './employment.module.js';
export { EmployeesService, EMPLOYEE_PERMISSIONS } from './application/employees.service.js';
export { EmploymentClock } from './application/employment-clock.js';
export type { EmployeeDetail, EmployeeListItem, EmployeeListView } from './application/employee-views.js';
export {
  demoEmployees,
  seedDemoEmployees,
  seedEmployees,
  type SeedAssignment,
  type SeedEmployee,
  type SeedSalary,
} from './infra/demo-employees.js';
