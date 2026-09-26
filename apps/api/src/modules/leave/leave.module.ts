import { Module } from '@nestjs/common';
import { StaffingModule } from '../staffing/index.js';
import { WorkflowModule } from '../workflow/index.js';
import { EmployeeLeaveController, LeaveController, MyLeaveController } from './api/leave.controller.js';
import { LeaveClock } from './application/leave-clock.js';
import { LeaveConfigService } from './application/leave-config.service.js';
import { LeaveService } from './application/leave.service.js';
import { LeaveRepository } from './infra/leave.repository.js';

/**
 * Leave (docs/contracts/leave.md): configuration (types, holidays, policy), requests approved through the workflow
 * engine (subject `leave_request`), the balance ledger, accruals and the self-service / HR endpoints.
 */
@Module({
  imports: [StaffingModule, WorkflowModule],
  controllers: [MyLeaveController, LeaveController, EmployeeLeaveController],
  providers: [LeaveService, LeaveConfigService, LeaveRepository, LeaveClock],
})
export class LeaveModule {}
