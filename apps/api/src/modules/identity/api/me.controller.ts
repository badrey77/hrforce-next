import { Controller, Get } from '@nestjs/common';
import { AllowWithoutMfa, Authenticated } from '../../../platform/authz/decorators.js';
import type { MeView } from '../application/identity-views.js';
import { MeService } from '../application/me.service.js';

@Controller('me')
export class MeController {
  constructor(private readonly service: MeService) {}

  /** The signed-in user + active company + memberships (docs/contracts/identity.md). */
  @Get()
  @Authenticated()
  @AllowWithoutMfa() // the web learns here that the user must enroll first (mfa.required && !mfa.enabled)
  me(): Promise<MeView> {
    return this.service.me();
  }
}
