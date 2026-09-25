import { Injectable } from '@nestjs/common';
import { toIsoDate } from '../domain/versions.js';

/**
 * "Today" for date-effective org data: the server's local calendar date (set TZ, e.g. Africa/Algiers, in
 * deployments). A provider so tests can pin it.
 */
@Injectable()
export class OrgClock {
  today(): string {
    return toIsoDate(new Date());
  }
}
