/** Public surface of the Deadlines module (the only file other modules — and the worker — may import). */
export { DeadlinesModule } from './deadlines.module.js';
export { DeadlinesClock, deadlinesToday } from './application/deadlines-clock.js';
export { digestSubjectId, runDeadlineDigest, type DigestRunResult } from './application/deadline-digest.js';
export type { DeadlineItem, DeadlinePage, DeadlinePolicyView, DeadlineSummary } from './application/deadline-views.js';
export { DEADLINE_KINDS, DEADLINE_PERMISSIONS, DEFAULT_DEADLINE_POLICY, type DeadlineKind, type DeadlinePolicy } from './domain/types.js';
export { DEMO_DEADLINE_POLICY, seedDeadlinePolicy, seedDemoDeadlineAcks } from './infra/deadlines-seed.js';
