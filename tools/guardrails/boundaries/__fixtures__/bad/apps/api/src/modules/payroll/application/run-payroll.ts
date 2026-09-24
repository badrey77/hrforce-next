import { EmployeeRepository } from '../../employee/infra/employee.repository.js';
import { EmployeeRepository as ViaIndex } from '../../employee/index.js';
export const deps = [EmployeeRepository, ViaIndex];
// type-only deep import into another module: still a boundary violation
import type { Db } from '../../employee/domain/employee.js';
export type PayrollDb = Db;
