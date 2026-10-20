import { Module } from '@nestjs/common';
import { StaffingModule } from '../staffing/index.js';
import { DeadlinesController } from './api/deadlines.controller.js';
import { DeadlinesClock } from './application/deadlines-clock.js';
import { DeadlinesService } from './application/deadlines.service.js';
import { DeadlinesRepository } from './infra/deadlines.repository.js';

/**
 * Deadlines (docs/contracts/contracts-deadlines.md › Deadlines): probation and contract ends, expiring employee-file
 * documents, retirement, missing contracts — computed at read time from the contracts, employments and files, with
 * acknowledgements and a per-company policy. The daily job (`deadlines.daily`, src/worker/tasks.ts) sends the digest.
 */
@Module({
  imports: [StaffingModule],
  controllers: [DeadlinesController],
  providers: [DeadlinesRepository, DeadlinesService, DeadlinesClock],
})
export class DeadlinesModule {}
