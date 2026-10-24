import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/index.js';
import { LeaveModule } from '../leave/index.js';
import { StaffingModule } from '../staffing/index.js';
import { PayrollExportController, PayrollSettingsController } from './api/payroll-settings.controller.js';
import { PayrollVariablesController } from './api/variables.controller.js';
import { PayrollClock } from './application/payroll-clock.js';
import { PayrollEngine } from './application/payroll-engine.js';
import { PAYROLL_LINES_SOURCE } from './application/payroll-lines.port.js';
import { VariablesService } from './application/variables.service.js';
import { PayrollExportService } from './application/payroll-export.service.js';
import { PayrollSettingsService } from './application/payroll-settings.service.js';
import { PayrollSettingsRepository } from './infra/payroll-settings.repository.js';
import { VariablesRepository } from './infra/variables.repository.js';

/**
 * Payroll variables (docs/contracts/payroll-variables.md): the month's variables computed from leave, attendance and
 * employment, HR adjustments, the monthly closing and the export file for the payroll software (PC-PAIE).
 */
@Module({
  imports: [StaffingModule, LeaveModule, AttendanceModule],
  controllers: [PayrollSettingsController, PayrollExportController, PayrollVariablesController],
  providers: [
    PayrollClock,
    PayrollSettingsRepository,
    PayrollSettingsService,
    PayrollExportService,
    // the computation, variables, closings (API builder 2) and the lines port the export reads
    VariablesRepository,
    PayrollEngine,
    VariablesService,
    { provide: PAYROLL_LINES_SOURCE, useExisting: VariablesService },
  ],
})
export class PayrollModule {}
