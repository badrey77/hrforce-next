import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { RequirePermission } from '../../../platform/authz/decorators.js';
import type { DeadlineItem, DeadlinePage, DeadlinePolicyView, DeadlineSummary } from '../application/deadline-views.js';
import { DeadlinesService } from '../application/deadlines.service.js';
import { AckDeadlineDto, DeadlinePolicyDto, DeadlinesQueryDto, isUuid } from './deadlines.dto.js';

/** Deadlines (docs/contracts/contracts-deadlines.md › Deadlines). `summary` and `settings` before `:id`-free routes. */
@Controller('deadlines')
export class DeadlinesController {
  constructor(private readonly deadlines: DeadlinesService) {}

  @Get()
  @RequirePermission('deadline.read')
  list(@Query() query: DeadlinesQueryDto): Promise<DeadlinePage> {
    return this.deadlines.list(query);
  }

  @Get('summary')
  @RequirePermission('deadline.read')
  summary(): Promise<DeadlineSummary> {
    return this.deadlines.summary();
  }

  @Post('acks')
  @RequirePermission('deadline.handle')
  ack(@Body() body: AckDeadlineDto): Promise<DeadlineItem> {
    return this.deadlines.ack(body);
  }

  @Delete('acks/:id')
  @HttpCode(204)
  @RequirePermission('deadline.handle')
  async unack(@Param('id') id: string): Promise<void> {
    if (!isUuid(id)) throw new NotFoundException('Acknowledgement not found');
    await this.deadlines.unack(id.toLowerCase());
  }

  @Get('settings')
  @RequirePermission('deadline.configure')
  settings(): Promise<DeadlinePolicyView> {
    return this.deadlines.settings();
  }

  @Put('settings')
  @RequirePermission('deadline.configure')
  saveSettings(@Body() body: DeadlinePolicyDto): Promise<DeadlinePolicyView> {
    return this.deadlines.saveSettings(body);
  }
}
