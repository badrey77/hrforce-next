import { Injectable } from '@nestjs/common';

/** Wall clock of the TOTP checks (overridden in tests to step through 30-second periods). */
@Injectable()
export class MfaClock {
  nowMs(): number {
    return Date.now();
  }
}
