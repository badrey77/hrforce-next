import { Module } from '@nestjs/common';
import { EmployeesController } from './api/employees.controller.js';
import { EmployeesService } from './application/employees.service.js';
import { EmploymentClock } from './application/employment-clock.js';
import { EmployeeRepository } from './infra/employee.repository.js';

/**
 * Employment (docs/contracts/employment.md): persons, employments, date-effective assignments and salaries, sensitive
 * data (NSS, RIB) behind field-level permissions. Scope and permissions come from the platform ScopeService.
 */
@Module({
  controllers: [EmployeesController],
  providers: [EmployeesService, EmployeeRepository, EmploymentClock],
  exports: [EmployeesService],
})
export class EmploymentModule {}
