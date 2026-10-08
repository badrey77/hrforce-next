import { Module } from '@nestjs/common';
import { EmployeeFileUploadInterceptor } from '../documents/index.js';
import { EmploymentModule } from '../employment/index.js';
import { StaffingModule } from '../staffing/index.js';
import { WorkflowModule } from '../workflow/index.js';
import { MyRecruitmentController, RecruitmentCandidatesController, RecruitmentOpeningsController, RecruitmentSettingsController } from './api/recruitment.controller.js';
import { ApplicationsService } from './application/applications.service.js';
import { CandidateFilesService } from './application/candidate-files.service.js';
import { OpeningsService } from './application/openings.service.js';
import { RecruitmentAccess, RecruitmentClock } from './application/recruitment-access.js';
import { RecruitmentSettingsService } from './application/recruitment-settings.service.js';
import { CandidatesRepository } from './infra/candidates.repository.js';
import { RecruitmentRepository } from './infra/recruitment.repository.js';

/**
 * Recruitment, Phase A (docs/contracts/recruitment.md): job openings approved through the workflow engine (subject
 * type `recruitment_opening`), candidates and their applications with duplicate detection limited to what the caller
 * can see, the pipeline board and its stage machine (`expectedStage` under a row lock), the salary block behind its own
 * permissions, notes, candidate files (the employee file's validation and download rules, from the Documents module),
 * settings, the unit heads' restricted view, the home counts, the erasure on request and the retention purge.
 * Candidate data is audited as events without personal payload (migration 0019). Phase B adds criteria, interviews,
 * evaluations, the comparison, offers and the hire.
 */
@Module({
  imports: [StaffingModule, WorkflowModule, EmploymentModule],
  controllers: [RecruitmentOpeningsController, RecruitmentCandidatesController, RecruitmentSettingsController, MyRecruitmentController],
  providers: [
    RecruitmentClock,
    RecruitmentAccess,
    RecruitmentRepository,
    CandidatesRepository,
    OpeningsService,
    ApplicationsService,
    CandidateFilesService,
    RecruitmentSettingsService,
    EmployeeFileUploadInterceptor,
  ],
})
export class RecruitmentModule {}
