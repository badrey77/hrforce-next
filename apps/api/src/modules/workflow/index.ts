/** Public surface of the Workflow module (the only file other modules may import). */
export { WorkflowModule } from './workflow.module.js';
export { WorkflowEngine, type DefinitionView, type StartInput, type WorkflowSubjectType } from './application/workflow-engine.js';
export { WorkflowSubjects, type HookContext, type ManagerCandidate, type WorkflowSubject } from './application/workflow-subjects.js';
export type { AssigneeView, OpenTaskView, TaskActionView, TaskHistoryView, UserRef, WorkflowProgressView } from './application/workflow-views.js';
export type { Labels, StepDef } from './domain/steps.js';
export { seedWorkflowDefinitions, SYSTEM_DEFINITIONS, type SeedDefinition } from './infra/workflow-seed.js';
