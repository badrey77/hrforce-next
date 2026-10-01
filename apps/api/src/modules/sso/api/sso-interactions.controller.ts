import { Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Authenticated, Public } from '../../../platform/authz/decorators.js';
import { SkipTransaction } from '../../../platform/context/skip-transaction.decorator.js';
import { interactionUid, SsoInteractionsService } from '../application/sso-interactions.service.js';
import type { SsoInteractionView, SsoRedirectView } from '../application/sso-views.js';

/**
 * The sign-in handoff (docs/contracts/sso.md › Sign-in handoff). The provider's interaction URL is this API path, so
 * its `hrf_op_interaction` cookie (Path=/api/sso/interactions/<uid>) reaches these routes together with HRForce's
 * own cookies. No request transaction: `complete` works in the CLIENT's company, not the session's.
 */
@Controller('sso/interactions')
@SkipTransaction()
export class SsoInteractionsController {
  constructor(private readonly interactions: SsoInteractionsService) {}

  /** The interaction entry: only exists because of the cookie path; hands over to the Angular page. */
  @Get(':uid')
  @Public()
  entry(@Param('uid') uid: string, @Res() res: Response): void {
    const valid = interactionUid(uid);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(303, `/sso/${valid}`);
  }

  @Get(':uid/details')
  @Public()
  details(@Param('uid') uid: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SsoInteractionView> {
    res.setHeader('Cache-Control', 'no-store');
    return this.interactions.details(req, res, interactionUid(uid));
  }

  @Post(':uid/complete')
  @Authenticated()
  @HttpCode(200)
  complete(@Param('uid') uid: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SsoRedirectView> {
    res.setHeader('Cache-Control', 'no-store');
    return this.interactions.complete(req, res, interactionUid(uid));
  }

  @Post(':uid/abort')
  @Public()
  @HttpCode(200)
  abort(@Param('uid') uid: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SsoRedirectView> {
    res.setHeader('Cache-Control', 'no-store');
    return this.interactions.abort(req, res, interactionUid(uid));
  }
}
