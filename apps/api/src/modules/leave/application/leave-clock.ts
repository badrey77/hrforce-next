import { Injectable } from '@nestjs/common';
import { toIsoDate } from '../../organization/index.js';

/** "Today" for leave (cancellation, balances asOf, accrual month limit): server local date; a provider so tests can pin it. */
@Injectable()
export class LeaveClock {
  today(): string {
    return toIsoDate(new Date());
  }
}
