import { Module } from '@nestjs/common';
import { DocumentsModule, EmployeeFileUploadInterceptor } from '../documents/index.js';
import { EmploymentModule } from '../employment/index.js';
import { StaffingModule } from '../staffing/index.js';
import { WorkflowModule } from '../workflow/index.js';
import { MyInterviewsController, RecruitmentHireController, RecruitmentInterviewsController } from './api/interviews.controller.js';
import { MyRecruitmentController, RecruitmentCandidatesController, RecruitmentOpeningsController, RecruitmentSettingsController } from './api/recruitment.controller.js';
import { ApplicationsService } from './application/applications.service.js';
import { CandidateFilesService } from './application/candidate-files.service.js';
import { HireService, OffersService, RecruitmentLocks } from './application/hire.service.js';
import { InterviewNotices, InterviewReads } from './application/interview-support.js';
import { InterviewsService } from './application/interviews.service.js';
import { OpeningsService } from './application/openings.service.js';
import { RecruitmentAccess, RecruitmentClock } from './application/recruitment-access.js';
import { RecruitmentSettingsService } from './application/recruitment-settings.service.js';
import { CandidatesRepository } from './infra/candidates.repository.js';
import { InterviewsRepository } from './infra/interviews.repository.js';
import { RecruitmentRepository } from './infra/recruitment.repository.js';

/**
 * Recruitment, Phase A (docs/contracts/recruitment.md): job openings approved through the workflow engine (subject
 * type `recruitment_opening`), candidates and their applications with duplicate detection limited to what the caller
 * can see, the pipeline board and its stage machine (`expectedStage` under a row lock), the salary block behind its own
 * permissions, notes, candidate files (the employee file's validation and download rules, from the Documents module),
 * settings, the unit heads' restricted view, the home counts, the erasure on request and the retention purge.
 * Candidate data is audited as events without personal payload (migrations 0019 and 0020).
 * Phase B: evaluation criteria (a company list copied per opening), interviews with 1–5 interviewers and their
 * evaluations (« my interviews » needs no permission), the comparison per opening, offers, and the hire — one request
 * transaction that creates the employee through the Employment module's own use case and copies the chosen candidate
 * files into the employee file (Documents' EmployeeFileImporter) — with its undo.
 */
@Module({
  imports: [StaffingModule, WorkflowModule, EmploymentModule, DocumentsModule],
  controllers: [
    RecruitmentOpeningsController,
    RecruitmentCandidatesController,
    RecruitmentSettingsController,
    MyRecruitmentController,
    RecruitmentInterviewsController,
    RecruitmentHireController,
    MyInterviewsController,
  ],
  providers: [
    RecruitmentClock,
    RecruitmentAccess,
    RecruitmentRepository,
    CandidatesRepository,
    InterviewsRepository,
    InterviewReads,
    InterviewNotices,
    InterviewsService,
    RecruitmentLocks,
    OffersService,
    HireService,
    OpeningsService,
    ApplicationsService,
    CandidateFilesService,
    RecruitmentSettingsService,
    EmployeeFileUploadInterceptor,
  ],
})
export class RecruitmentModule {}
