import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../../platform/authz/decorators.js';
import { SkipTransaction } from '../../../platform/context/skip-transaction.decorator.js';
import { XsrfUnbound } from '../../../platform/security/xsrf.guard.js';
import type { KioskQrView, KioskSessionView, ScanView } from '../application/attendance-views.js';
import { CheckInService } from '../application/check-in.service.js';
import { PairKioskDto, ScanRequestDto } from './attendance.dto.js';

/**
 * The entrance kiosk's own routes (docs/contracts/attendance.md › Device side, ADR 009 §1–2). No user: the device is
 * identified by its `hrf_kiosk` credential cookie (Path=/api/kiosk). Each call runs in its own transaction bound to the
 * kiosk's company (hence @SkipTransaction). The credential reads nothing personal: its only data are the kiosk's
 * labels, the company name and signed QR codes.
 */
@Controller('kiosk')
@Public()
@SkipTransaction()
export class KioskController {
  constructor(private readonly checkIn: CheckInService) {}

  /** `{code}` → 200 + the `hrf_kiosk` cookie; 422 malformed; 410 unknown / expired / used / revoked. */
  @Post('pair')
  @HttpCode(200)
  pair(@Body() body: PairKioskDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<KioskSessionView> {
    return this.checkIn.pair(body.code, req, res);
  }

  @Get('session')
  session(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<KioskSessionView> {
    res.setHeader('Cache-Control', 'no-store');
    return this.checkIn.session(req, res);
  }

  @Get('qr')
  qr(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<KioskQrView> {
    res.setHeader('Cache-Control', 'no-store');
    return this.checkIn.qr(req, res);
  }
}

/**
 * The phone's first call after its camera opened `/punch#<token>` (ADR 009 §3). Public — the session has usually
 * expired overnight — and XSRF-unbound (platform/security: the double submit only), because the phone's XSRF cookie
 * may still be bound to that dead session. It writes nothing: its only effect is the `hrf_scan` receipt cookie.
 */
@Controller('attendance')
export class ScanController {
  constructor(private readonly checkIn: CheckInService) {}

  @Post('scan')
  @HttpCode(200)
  @Public()
  @XsrfUnbound()
  @SkipTransaction()
  scan(@Body() body: ScanRequestDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ScanView> {
    return this.checkIn.scan(body.token, req, res);
  }
}
