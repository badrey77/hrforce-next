/** Public surface of the Profile module (the only file other modules — and the worker — may import). */
export { ProfileModule } from './profile.module.js';
export { runProfileFilePurge, type ProfilePurgeResult } from './application/profile-file-purge.js';
export type { MyProfileView, ProfileRequestDetail, ProfileRequestView, ProfileSettings } from './application/profile-views.js';
export { PROFILE_SECTIONS, type ProfileSection } from './domain/profile.js';
export { DEMO_PROFILE_REQUESTS, seedDemoProfileRequests } from './infra/profile-seed.js';
