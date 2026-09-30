import { Module } from '@nestjs/common';
import { AttendanceModule } from './modules/attendance/index.js';
import { AuditModule } from './modules/audit/index.js';
import { AuthorizationModule } from './modules/authorization/index.js';
import { DocumentsModule } from './modules/documents/index.js';
import { EmploymentModule } from './modules/employment/index.js';
import { IdentityModule } from './modules/identity/index.js';
import { LeaveModule } from './modules/leave/index.js';
import { NotificationsModule } from './modules/notifications/index.js';
import { OrganizationModule } from './modules/organization/index.js';
import { StaffingModule } from './modules/staffing/index.js';
import { WorkflowModule } from './modules/workflow/index.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({
  imports: [
    PlatformModule,
    AuditModule,
    AuthorizationModule,
    NotificationsModule,
    OrganizationModule,
    IdentityModule,
    EmploymentModule,
    StaffingModule,
    WorkflowModule,
    LeaveModule,
    DocumentsModule,
    AttendanceModule,
  ],
})
export class AppModule {}
