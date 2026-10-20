import { Injectable } from '@nestjs/common';

/** Today in Algeria (YYYY-MM-DD). */
export function deadlinesToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The board's "today"; a provider so tests can pin it. */
@Injectable()
export class DeadlinesClock {
  today(): string {
    return deadlinesToday();
  }
}
