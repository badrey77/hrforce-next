import { Injectable } from '@nestjs/common';

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * "Today" for date-effective grants (`valid @> today`): the server's local calendar date (set TZ, e.g.
 * Africa/Algiers, in deployments), same rule as the Organization module's clock. A provider so tests can pin it.
 */
@Injectable()
export class AccessClock {
  today(): string {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
}
