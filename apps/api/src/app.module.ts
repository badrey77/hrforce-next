import { Module } from '@nestjs/common';
import { IdentityModule } from './modules/identity/index.js';
import { OrganizationModule } from './modules/organization/index.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({
  imports: [PlatformModule, OrganizationModule, IdentityModule],
})
export class AppModule {}
