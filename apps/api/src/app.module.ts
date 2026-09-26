import { Module } from '@nestjs/common';
import { AuthorizationModule } from './modules/authorization/index.js';
import { IdentityModule } from './modules/identity/index.js';
import { OrganizationModule } from './modules/organization/index.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({
  imports: [PlatformModule, AuthorizationModule, OrganizationModule, IdentityModule],
})
export class AppModule {}
