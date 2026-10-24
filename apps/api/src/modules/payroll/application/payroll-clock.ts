import { Injectable } from '@nestjs/common';

/** Today in Algeria (YYYY-MM-DD). */
export function payrollToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The payroll "today" (current month, final days, cut-off); a provider so tests can pin it. */
@Injectable()
export class PayrollClock {
  today(): string {
    return payrollToday();
  }
}
