import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated } from '../../../platform/authz/decorators.js';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { WorkflowEngine } from '../application/workflow-engine.js';
import type { OpenTaskView, TaskActionView } from '../application/workflow-views.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TasksQueryDto extends createZodDto(z.object({ status: z.enum(['open']).default('open') })) {}

export class TaskDecisionDto extends createZodDto(
  z.object({
    comment: z
      .string()
      .trim()
      .max(1000, { message: 'At most 1000 characters' })
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
  }),
) {}

function taskId(id: string): string {
  if (!UUID.test(id)) throw new NotFoundException('Task not found');
  return id.toLowerCase();
}

/**
 * "My tasks" (docs/contracts/leave.md): open tasks where the caller is a candidate, and the decisions. No permission
 * is needed to call these routes: being a candidate of the task IS the authorization (checked by the engine; 404
 * otherwise, 409 `workflow-self-approval` / `workflow-task-closed`).
 */
@Controller('tasks')
export class TasksController {
  constructor(private readonly engine: WorkflowEngine) {}

  @Get()
  @Authenticated()
  list(@Query() _query: TasksQueryDto): Promise<{ items: OpenTaskView[] }> {
    return this.engine.myTasks();
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Authenticated()
  approve(@Param('id') id: string, @Body() body: TaskDecisionDto): Promise<TaskActionView> {
    return this.engine.act(taskId(id), 'approve', body.comment ?? null);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Authenticated()
  reject(@Param('id') id: string, @Body() body: TaskDecisionDto): Promise<TaskActionView> {
    return this.engine.act(taskId(id), 'reject', body.comment ?? null);
  }
}
