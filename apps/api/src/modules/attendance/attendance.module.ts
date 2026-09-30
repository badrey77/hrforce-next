import { Module } from '@nestjs/common';
import { LeaveModule } from '../leave/index.js';
import { StaffingModule } from '../staffing/index.js';
import { AttendanceSettingsController } from './api/attendance-settings.controller.js';
import { AttendanceController, MyAttendanceController } from './api/attendance.controller.js';
import { KioskController, ScanController } from './api/check-in.controller.js';
import { AttendanceClock, AttendanceKeys } from './application/attendance-clock.js';
import { CheckInService } from './application/check-in.service.js';
import { KiosksService } from './application/kiosks.service.js';
import { PresenceEngine } from './application/presence-engine.js';
import { PresenceService } from './application/presence.service.js';
import { PunchesService } from './application/punches.service.js';
import { AttendanceSettingsService } from './application/settings.service.js';
import { AttendanceRepository } from './infra/attendance.repository.js';
import { KiosksRepository } from './infra/kiosks.repository.js';
import { SchedulesRepository } from './infra/schedules.repository.js';

/**
 * Attendance, Phase A (docs/contracts/attendance.md, ADR 009): entrance kiosks paired with a one-time code, rotating
 * signed QR codes scanned by the employee's own phone (scan receipt → punch), manual punches and voids, schedules with
 * versions, overrides and assignments, the daily presence computed on read (leave, holidays and rest days from the
 * Leave module and the schedules), the HR board, the unit heads' team view, the employee's own days, retention.
 */
@Module({
  imports: [LeaveModule, StaffingModule],
  controllers: [KioskController, ScanController, MyAttendanceController, AttendanceController, AttendanceSettingsController],
  providers: [
    AttendanceClock,
    AttendanceKeys,
    AttendanceRepository,
    KiosksRepository,
    SchedulesRepository,
    PresenceEngine,
    PresenceService,
    CheckInService,
    PunchesService,
    AttendanceSettingsService,
    KiosksService,
  ],
})
export class AttendanceModule {}
