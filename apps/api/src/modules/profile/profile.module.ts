import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/index.js';
import { EmploymentModule } from '../employment/index.js';
import { StaffingModule } from '../staffing/index.js';
import { WorkflowModule } from '../workflow/index.js';
import { MyProfileController, ProfileRequestsController } from './api/profile.controller.js';
import { ProfileUploadInterceptor } from './api/profile-upload.interceptor.js';
import { ProfileRequestsService } from './application/profile-requests.service.js';
import { ProfileSettingsService } from './application/profile-settings.service.js';
import { ProfileRepository } from './infra/profile.repository.js';

/**
 * Self-service profile changes (docs/contracts/profile-changes.md › Self-service requests): employees' change requests
 * (immediate or approved by HR through the workflow engine, subject type `profile_change_request`), their supporting
 * files, the HR list / detail and the company policy. Applies changes through the Employment use cases and copies the
 * approved files into the employee file (Documents' EmployeeFileImporter).
 */
@Module({
  imports: [EmploymentModule, StaffingModule, WorkflowModule, DocumentsModule],
  controllers: [MyProfileController, ProfileRequestsController],
  providers: [ProfileRequestsService, ProfileSettingsService, ProfileRepository, ProfileUploadInterceptor],
})
export class ProfileModule {}
