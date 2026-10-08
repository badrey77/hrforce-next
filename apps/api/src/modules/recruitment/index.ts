/** Public surface of the Recruitment module (the only file other modules may import). */
export { RecruitmentModule } from './recruitment.module.js';
export { RecruitmentClock } from './application/recruitment-access.js';
export { runRecruitmentRetention, type RecruitmentRetentionResult } from './application/recruitment-retention.js';
export { algiersDate as recruitmentAlgiersDate, RECRUITMENT_PERMISSIONS, STAGES, type Stage } from './domain/rules.js';
export {
  DEMO_OPENINGS,
  demoApplication,
  demoCandidate,
  demoCandidateFile,
  demoRecruitment,
  RECRUITMENT_DEFINITIONS,
  seedDemoRecruitment,
  seedRecruitment,
  seedRecruitmentDefaults,
  SYSTEM_REJECTION_REASONS,
  type SeedApplication,
  type SeedCandidate,
  type SeedOpening,
  type SeedRecruitment,
} from './infra/recruitment-seed.js';
