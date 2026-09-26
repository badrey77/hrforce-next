import { Injectable } from '@nestjs/common';
import { toIsoDate } from '../../organization/index.js';

/** "Today" for links, heads and manager resolution (server local date; a provider so tests can pin it). */
@Injectable()
export class StaffingClock {
  today(): string {
    return toIsoDate(new Date());
  }
}
