import { Injectable } from '@nestjs/common';

/** The SSO module's clock (claims date, fresh-login rule); a provider so tests can pin it. */
@Injectable()
export class SsoClock {
  nowMs(): number {
    return Date.now();
  }
}
