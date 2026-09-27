import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../../platform/authz/decorators.js';
import { SkipTransaction } from '../../../platform/context/skip-transaction.decorator.js';
import { AuthService } from '../application/auth.service.js';
import { PasswordService } from '../application/password.service.js';
import { AuthXsrf } from './auth-xsrf.guard.js';
import type { MfaRequiredView } from '../application/mfa-views.js';
import { ForgotPasswordRequestDto, LoginRequestDto, MfaVerifyRequestDto, PasswordSetupRequestDto } from './auth.dto.js';

/**
 * docs/contracts/identity.md › Endpoints. No request transaction (@SkipTransaction): failed logins must still be
 * recorded and a detected refresh-token reuse must still revoke the family although the response is an error; each
 * auth.* function call is atomic (see IdentityRepository).
 */
@Controller('auth')
@SkipTransaction()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly recovery: PasswordService,
  ) {}

  @Get('csrf')
  @Public()
  @HttpCode(204)
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    return this.auth.ensureXsrf(req, res);
  }

  @Post('login')
  @Public()
  @AuthXsrf()
  @HttpCode(204)
  async login(@Body() body: LoginRequestDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<MfaRequiredView | undefined> {
    const result = await this.auth.login(req, res, body);
    // second factor needed (docs/contracts/mfa.md): 200 {mfaRequired: true} + hrf_mfa, no session cookies yet
    if (result) res.status(200);
    return result;
  }

  /** Second step of a login with MFA; needs the hrf_mfa cookie (Path=/api/auth/mfa). */
  @Post('mfa/verify')
  @Public()
  @AuthXsrf()
  @HttpCode(204)
  verifyMfa(@Body() body: MfaVerifyRequestDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    return this.auth.verifyMfa(req, res, body);
  }

  @Post('refresh')
  @Public()
  @AuthXsrf()
  @HttpCode(204)
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    return this.auth.refresh(req, res);
  }

  @Post('logout')
  @Public()
  @AuthXsrf()
  @HttpCode(204)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    return this.auth.logout(req, res);
  }

  @Post('password/forgot')
  @Public()
  @AuthXsrf()
  @HttpCode(202)
  async forgot(@Body() body: ForgotPasswordRequestDto): Promise<void> {
    await this.recovery.forgot(body.email);
  }

  @Post('password/setup')
  @Public()
  @AuthXsrf()
  @HttpCode(204)
  async setup(@Body() body: PasswordSetupRequestDto): Promise<void> {
    await this.recovery.setup(body.token, body.password);
  }
}
