import { Module } from '@nestjs/common';
import { AuditModule } from './modules/audit/index.js';
import { AuthorizationModule } from './modules/authorization/index.js';
import { EmploymentModule } from './modules/employment/index.js';
import { IdentityModule } from './modules/identity/index.js';
import { OrganizationModule } from './modules/organization/index.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({
  imports: [PlatformModule, AuditModule, AuthorizationModule, OrganizationModule, IdentityModule, EmploymentModule],
})
export class AppModule {}
