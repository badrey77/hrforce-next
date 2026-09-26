import { Module } from '@nestjs/common';
import { TasksController } from './api/tasks.controller.js';
import { WorkflowEngine } from './application/workflow-engine.js';
import { WorkflowSubjects } from './application/workflow-subjects.js';
import { WorkflowRepository } from './infra/workflow.repository.js';

/**
 * Workflow engine (ADR 006, docs/contracts/leave.md › Workflow engine): definitions, instances, tasks, "My tasks".
 * Subject modules (Leave) register their hooks in {@link WorkflowSubjects}.
 */
@Module({
  controllers: [TasksController],
  providers: [WorkflowEngine, WorkflowSubjects, WorkflowRepository],
  exports: [WorkflowEngine, WorkflowSubjects],
})
export class WorkflowModule {}
