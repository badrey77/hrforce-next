import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV } from '../../../platform/config/config.module.js';
import { DEV_ATTENDANCE_KEY, type Env } from '../../../platform/config/env.schema.js';
import { algiersDate } from '../domain/time.js';
import { deriveKeys, type AttendanceKeys as Keys } from '../domain/tokens.js';

/**
 * The attendance clock (docs/contracts/attendance.md › Daily computation): the server's instant and "today" in
 * Africa/Algiers. A provider so the tests can pin it (token windows, receipts, days near midnight).
 */
@Injectable()
export class AttendanceClock {
  nowMs(): number {
    return Date.now();
  }

  today(): string {
    return algiersDate(this.nowMs());
  }
}

/**
 * The check-in's HMAC subkeys (K_qr, K_scan, K_dev) derived from ATTENDANCE_KEY; development/test fall back to the
 * public DEV_ATTENDANCE_KEY (insecure; production refuses to boot without its own key — platform/config).
 */
@Injectable()
export class AttendanceKeys {
  readonly keys: Keys;
  private readonly logger = new Logger('AttendanceKeys');

  constructor(@Inject(ENV) env: Env) {
    const master = Buffer.from(env.ATTENDANCE_KEY ?? DEV_ATTENDANCE_KEY, 'base64');
    if (master.length !== 32) throw new Error('ATTENDANCE_KEY must decode to 32 bytes');
    if (env.ATTENDANCE_KEY === undefined && env.NODE_ENV === 'development') {
      this.logger.warn('ATTENDANCE_KEY is not set: check-in codes use the PUBLIC development key (insecure; development/test only).');
    }
    this.keys = deriveKeys(master);
  }
}
