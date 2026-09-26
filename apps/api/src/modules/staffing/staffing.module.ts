import { Module } from '@nestjs/common';
import { StaffingController } from './api/staffing.controller.js';
import { StaffingClock } from './application/staffing-clock.js';
import { StaffingService } from './application/staffing.service.js';
import { StaffingRepository } from './infra/staffing.repository.js';

/**
 * Staffing (docs/contracts/leave.md › Links added to M1 data): which user IS which employee (self-service link),
 * who heads which unit (date-effective), and the manager of an employee derived from both.
 */
@Module({
  controllers: [StaffingController],
  providers: [StaffingService, StaffingRepository, StaffingClock],
  exports: [StaffingService],
})
export class StaffingModule {}
