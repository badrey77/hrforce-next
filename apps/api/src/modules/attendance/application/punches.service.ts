import { Injectable, NotFoundException } from '@nestjs/common';
import { ProblemException, ValidationProblemException, type FieldError } from '../../../platform/http/problem-details.js';
import { algiersInstant, retentionCutoff } from '../domain/time.js';
import { AttendanceRepository } from '../infra/attendance.repository.js';
import { SchedulesRepository } from '../infra/schedules.repository.js';
import { AttendanceClock } from './attendance-clock.js';
import type { PunchView } from './attendance-views.js';
import { isEmployedOn, PresenceEngine } from './presence-engine.js';
import { ATTENDANCE_PERMISSIONS as P, caller, PresenceService } from './presence.service.js';

export interface ManualPunchInput {
  direction: 'in' | 'out';
  date: string;
  time: string;
  reason: string;
  siteId?: string | undefined;
}

const selfManage = () => new ProblemException(409, 'attendance-self-manage', 'You cannot record or void punches of your own employment.');

/**
 * HR punches (docs/contracts/attendance.md › Endpoints): a manual punch (network down, phone broken…) and the void of
 * a punch — both with a reason, both audited as punch events, never on one's own employment (separation of duties).
 * Scope: the employee's unit today — out of attendance.read → 404, readable but outside attendance.manage → 403.
 */
@Injectable()
export class PunchesService {
  constructor(
    private readonly repo: AttendanceRepository,
    private readonly schedules: SchedulesRepository,
    private readonly engine: PresenceEngine,
    private readonly presence: PresenceService,
    private readonly clock: AttendanceClock,
  ) {}

  private async assertNotSelf(employmentId: string): Promise<void> {
    const { companyId, userId } = caller();
    if ((await this.repo.linkedEmployment(companyId, userId)) === employmentId) throw selfManage();
  }

  async manual(employmentId: string, input: ManualPunchInput): Promise<PunchView> {
    const { companyId, userId } = caller();
    await this.presence.employeeInScope(employmentId, P.manage);
    await this.assertNotSelf(employmentId);
    const today = this.clock.today();
    const at = algiersInstant(input.date, input.time);
    const policy = await this.schedules.policy(companyId);
    const errors: FieldError[] = [];
    if (at > this.clock.nowMs()) errors.push({ field: 'time', code: 'future', message: 'Not in the future.' });
    if (input.date < retentionCutoff(today, policy.retentionMonths)) {
      errors.push({ field: 'date', code: 'too_old', message: `Older than the retention period (${policy.retentionMonths} months).` });
    }
    if (input.siteId && !(await this.repo.sites(companyId)).has(input.siteId)) {
      errors.push({ field: 'siteId', code: 'not_found', message: 'Unknown site.' });
    }
    if (errors.length > 0) throw new ValidationProblemException(errors);

    const data = await this.engine.load(companyId, [employmentId], input.date, input.date);
    const e = data.employment(employmentId);
    if (!e) throw new NotFoundException('Employee not found');
    if (!isEmployedOn(e, input.date)) throw new ProblemException(409, 'attendance-not-employed', 'The employee is not employed on this date.');
    await this.repo.lockEmployment(companyId, employmentId);
    if (await this.repo.liveInMinute(companyId, employmentId, new Date(at))) {
      throw new ProblemException(409, 'attendance-punch-exists', 'The employee already has a punch at this minute.', [
        { field: 'time', code: 'exists', message: 'A punch already exists at this minute.' },
      ]);
    }
    const id = await this.repo.insertPunch(companyId, {
      employmentId,
      direction: input.direction,
      occurredAt: new Date(at),
      source: 'manual',
      deviceId: null,
      qrWindow: null,
      siteId: input.siteId ?? data.placement(e, input.date)?.siteId ?? null,
      deviceRef: null,
      reason: input.reason,
      createdBy: userId,
    });
    const punch = await this.repo.punch(companyId, id);
    if (!punch) throw new Error('punch not found after insert');
    return data.punchView(punch, true);
  }

  async void(punchId: string, reason: string): Promise<PunchView> {
    const { companyId, userId } = caller();
    const punch = await this.repo.punch(companyId, punchId);
    if (!punch) throw new NotFoundException('Punch not found');
    await this.presence.employeeInScope(punch.employmentId, P.manage);
    await this.assertNotSelf(punch.employmentId);
    const locked = await this.repo.punch(companyId, punchId, { lock: true });
    if (!locked || locked.status === 'void') throw new ProblemException(409, 'attendance-punch-void', 'This punch is already void.');
    await this.repo.voidPunch(companyId, punchId, userId, reason);
    const after = await this.repo.punch(companyId, punchId);
    if (!after) throw new Error('punch vanished');
    const data = await this.engine.load(companyId, [punch.employmentId], punch.workDate, punch.workDate);
    return data.punchView(after, true);
  }
}
