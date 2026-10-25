/** Public surface of the Employment module (the only file other modules may import). */
export { EmploymentModule } from './employment.module.js';
export { EmployeesService, EMPLOYEE_PERMISSIONS } from './application/employees.service.js';
export type { CreateEmployeeInput } from './application/employees.service.js';
// the body of POST /employees, reused as is by the hire of a recruited candidate (recruitment.md › Hire)
export { createEmployeeShape, refineCreateEmployee } from './api/employees.dto.js';
export { EmploymentClock } from './application/employment-clock.js';
export type { EmployeeDetail, EmployeeListItem, EmployeeListView, KnownPerson, NamePair, SiteRef, UnitRef } from './application/employee-views.js';
export {
  demoEmployees,
  seedDemoEmployees,
  seedEmployees,
  type SeedAssignment,
  type SeedEmployee,
  type SeedSalary,
} from './infra/demo-employees.js';
// personal details and the use cases the `profile` module applies requests through (docs/contracts/profile-changes.md)
export { PersonalDetailsService, PERSONAL_PERMISSIONS } from './application/personal-details.service.js';
export type { PersonalActor, PersonalView, ProfileFacts } from './application/personal-details.service.js';
export { bankInputSchema, contactInputSchema, emergencyInputSchema, familyInputSchema } from './api/personal.dto.js';
export {
  CONTACT_FIELDS,
  maskLast4,
  MAX_CHILDREN,
  MARITAL_STATUSES,
  RELATIONSHIPS,
  SPOUSE_EMPLOYED,
  type BankValues,
  type ChildInput,
  type ContactValues,
  type EmergencyValues,
  type FamilyInput,
  type FamilyValues,
  type PersonalFieldError,
} from './domain/personal.js';
export { PROFILE_DEFINITIONS, PROFILE_WORKFLOW_CODES, seedDemoPersonal, seedProfileDefaults } from './infra/personal-seed.js';
