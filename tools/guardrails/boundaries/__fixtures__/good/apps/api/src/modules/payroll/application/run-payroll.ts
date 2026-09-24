import { EmployeeRepository, type Employee } from '../../employee/index.js';
export const run = (repo: EmployeeRepository): Employee[] => repo.find();
