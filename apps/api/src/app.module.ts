import { Module } from '@nestjs/common';
import { OrganizationModule } from './modules/organization/index.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({
  imports: [PlatformModule, OrganizationModule],
})
export class AppModule {}
