import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AllowWithoutMfa, Authenticated } from '../../../platform/authz/decorators.js';
import { clientOf } from '../application/client-info.js';
import type { MfaEnrollmentView, MfaStatusView, RecoveryCodesView } from '../application/mfa-views.js';
import { MfaService } from '../application/mfa.service.js';
import { MfaCodeRequestDto } from './mfa.dto.js';

/**
 * The caller's own second factor (docs/contracts/mfa.md › Endpoints). @AllowWithoutMfa: a user whom the company
 * requires to use two-step sign-in must be able to enroll before anything else works.
 */
@Controller('me/mfa')
@Authenticated()
@AllowWithoutMfa()
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Get()
  status(): Promise<MfaStatusView> {
    return this.mfa.status();
  }

  /** New pending secret → {secret, otpauthUri, qrPng}; 409 mfa-already-enabled. */
  @Post('enroll/start')
  @HttpCode(200)
  enrollStart(): Promise<MfaEnrollmentView> {
    return this.mfa.enrollStart();
  }

  /** {code} → activates; {recoveryCodes} returned once. 409 mfa-already-enabled; 422 mfa-invalid on `code`. */
  @Post('enroll/confirm')
  @HttpCode(200)
  enrollConfirm(@Body() body: MfaCodeRequestDto, @Req() req: Request): Promise<RecoveryCodesView> {
    return this.mfa.enrollConfirm(body.code, clientOf(req));
  }

  /** {code} → a new recovery set (the old one is void). */
  @Post('recovery-codes')
  @HttpCode(200)
  regenerate(@Body() body: MfaCodeRequestDto, @Req() req: Request): Promise<RecoveryCodesView> {
    return this.mfa.regenerate(body.code, clientOf(req));
  }

  /** {code} → 204; 409 mfa-required-by-policy when the company requires it. */
  @Post('disable')
  @HttpCode(204)
  disable(@Body() body: MfaCodeRequestDto, @Req() req: Request): Promise<void> {
    return this.mfa.disable(body.code, clientOf(req));
  }
}
