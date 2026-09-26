import type { InstanceStatus, Labels, StepDef, StepProgress, TaskOutcome, TaskStatus } from '../domain/steps.js';

export interface UserRef {
  id: string;
  displayName: string;
}

export type AssigneeView = { kind: 'user'; user: UserRef } | { kind: 'permission'; permission: string } | { kind: 'none' };

/** One task of an instance's history. */
export interface TaskHistoryView {
  id: string;
  stepKey: string;
  stepIndex: number;
  assignee: AssigneeView;
  status: TaskStatus;
  outcome: TaskOutcome | null;
  actedBy: UserRef | null;
  actedAt: string | null;
  comment: string | null;
  createdAt: string;
}

/** Progress of an instance (list rows). `currentStep` null once finished. */
export interface WorkflowProgressView {
  instanceId: string;
  status: InstanceStatus;
  currentStep: number | null;
  steps: (StepDef & { state: StepProgress['state'] })[];
}

/** An open task in "My tasks". */
export interface OpenTaskView {
  id: string;
  instanceId: string;
  stepKey: string;
  stepIndex: number;
  stepLabels: Labels;
  /** an earlier manager step of the instance was escalated to this one */
  escalated: boolean;
  createdAt: string;
  subject: { type: string; id: string } & Record<string, unknown>;
}

export interface TaskActionView {
  taskId: string;
  outcome: 'approve' | 'reject';
  workflow: WorkflowProgressView;
  history: TaskHistoryView[];
}
