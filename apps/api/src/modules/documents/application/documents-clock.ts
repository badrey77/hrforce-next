import { Injectable } from '@nestjs/common';

/** Today in Algeria (YYYY-MM-DD): a document's issue date and the year of its number (contract assumption 3). */
export function algiersToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The issue date clock; a provider so tests can pin it (year rollover). */
@Injectable()
export class DocumentsClock {
  today(): string {
    return algiersToday();
  }
}
