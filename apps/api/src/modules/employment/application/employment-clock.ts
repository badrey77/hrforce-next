import { Injectable } from '@nestjs/common';
import { toIsoDate } from '../../organization/index.js';

/**
 * "Today" for employment data (status, scope assignment, default asOf): the server's local calendar date (set TZ,
 * e.g. Africa/Algiers, in deployments). A provider so tests can pin it.
 */
@Injectable()
export class EmploymentClock {
  today(): string {
    return toIsoDate(new Date());
  }
}
