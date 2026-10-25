import { Module } from '@nestjs/common';
import { ContractsModule } from '../contracts/index.js';
import { EmployeesController } from './api/employees.controller.js';
import { EmployeesService } from './application/employees.service.js';
import { EmploymentClock } from './application/employment-clock.js';
import { PersonalDetailsService } from './application/personal-details.service.js';
import { EmployeeRepository } from './infra/employee.repository.js';
import { PersonalRepository } from './infra/personal.repository.js';

/**
 * Employment (docs/contracts/employment.md): persons, employments, date-effective assignments and salaries, sensitive
 * data (NSS, RIB) behind field-level permissions, personal details (contact, emergency contact, family —
 * docs/contracts/profile-changes.md) with the use cases the `profile` module applies requests through. Scope and
 * permissions come from the platform ScopeService.
 */
@Module({
  imports: [ContractsModule],
  controllers: [EmployeesController],
  providers: [EmployeesService, EmployeeRepository, EmploymentClock, PersonalDetailsService, PersonalRepository],
  exports: [EmployeesService, PersonalDetailsService],
})
export class EmploymentModule {}
