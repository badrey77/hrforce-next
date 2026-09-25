import { Controller, Get } from '@nestjs/common';
import { Authenticated } from '../../../platform/authz/decorators.js';
import type { MeView } from '../application/identity-views.js';
import { MeService } from '../application/me.service.js';

@Controller('me')
export class MeController {
  constructor(private readonly service: MeService) {}

  /** The signed-in user + active company + memberships (docs/contracts/identity.md). */
  @Get()
  @Authenticated()
  me(): Promise<MeView> {
    return this.service.me();
  }
}
