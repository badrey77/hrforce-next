import { Injectable } from '@nestjs/common';
import type { Database } from '../../../platform/db/database.js';
import type { Employee } from '../domain/employee.js';
@Injectable()
export class EmployeeRepository { constructor(readonly db: Database) {} find(): Employee[] { return []; } }
