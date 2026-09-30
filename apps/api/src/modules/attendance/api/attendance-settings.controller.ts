import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { RequirePermission } from '../../../platform/authz/decorators.js';
import type { AssignmentView, KioskView, OverrideView, PairingCodeView, PolicyView, ScheduleView } from '../application/attendance-views.js';
import { KiosksService } from '../application/kiosks.service.js';
import { AttendanceSettingsService } from '../application/settings.service.js';
import {
  AssignmentsQueryDto,
  CreateAssignmentDto,
  CreateKioskDto,
  CreateScheduleDto,
  EndAssignmentDto,
  isUuid,
  OverrideDto,
  OverridesQueryDto,
  PolicyDto,
  RevokeKioskDto,
  ScheduleVersionDto,
  UpdateKioskDto,
  UpdateScheduleDto,
} from './attendance.dto.js';

function idParam(id: string, what: string): string {
  if (!isUuid(id)) throw new NotFoundException(`${what} not found`);
  return id.toLowerCase();
}

/**
 * Attendance configuration (docs/contracts/attendance.md › HR endpoints): policy, schedules and versions, overrides,
 * assignments, kiosks. Writes need attendance.configure over the whole company (checked by the services).
 */
@Controller('attendance')
export class AttendanceSettingsController {
  constructor(
    private readonly settings: AttendanceSettingsService,
    private readonly kiosks: KiosksService,
  ) {}

  // ── policy ──
  @Get('policy')
  @RequirePermission('attendance.read')
  policy(): Promise<PolicyView> {
    return this.settings.policy();
  }

  @Put('policy')
  @RequirePermission('attendance.configure')
  savePolicy(@Body() body: PolicyDto): Promise<PolicyView> {
    return this.settings.savePolicy(body);
  }

  // ── schedules ──
  @Get('schedules')
  @RequirePermission('attendance.read')
  schedules(): Promise<{ items: ScheduleView[] }> {
    return this.settings.schedules();
  }

  @Post('schedules')
  @RequirePermission('attendance.configure')
  createSchedule(@Body() body: CreateScheduleDto): Promise<ScheduleView> {
    return this.settings.createSchedule(body);
  }

  @Patch('schedules/:id')
  @RequirePermission('attendance.configure')
  updateSchedule(@Param('id') id: string, @Body() body: UpdateScheduleDto): Promise<ScheduleView> {
    return this.settings.updateSchedule(idParam(id, 'Schedule'), body);
  }

  @Post('schedules/:id/versions')
  @RequirePermission('attendance.configure')
  addVersion(@Param('id') id: string, @Body() body: ScheduleVersionDto): Promise<ScheduleView> {
    return this.settings.addVersion(idParam(id, 'Schedule'), body);
  }

  // ── overrides ──
  @Get('schedule-overrides')
  @RequirePermission('attendance.read')
  overrides(@Query() query: OverridesQueryDto): Promise<{ items: OverrideView[] }> {
    return this.settings.overrides(query.year);
  }

  @Post('schedule-overrides')
  @RequirePermission('attendance.configure')
  createOverride(@Body() body: OverrideDto): Promise<OverrideView> {
    return this.settings.createOverride(body);
  }

  @Put('schedule-overrides/:id')
  @RequirePermission('attendance.configure')
  updateOverride(@Param('id') id: string, @Body() body: OverrideDto): Promise<OverrideView> {
    return this.settings.updateOverride(idParam(id, 'Override'), body);
  }

  @Delete('schedule-overrides/:id')
  @HttpCode(204)
  @RequirePermission('attendance.configure')
  deleteOverride(@Param('id') id: string): Promise<void> {
    return this.settings.deleteOverride(idParam(id, 'Override'));
  }

  // ── assignments ──
  @Get('schedule-assignments')
  @RequirePermission('attendance.read')
  assignments(@Query() query: AssignmentsQueryDto): Promise<{ items: AssignmentView[] }> {
    return this.settings.assignments(query);
  }

  @Post('schedule-assignments')
  @RequirePermission('attendance.configure')
  createAssignment(@Body() body: CreateAssignmentDto): Promise<AssignmentView> {
    return this.settings.createAssignment(body);
  }

  @Post('schedule-assignments/:id/end')
  @HttpCode(200)
  @RequirePermission('attendance.configure')
  endAssignment(@Param('id') id: string, @Body() body: EndAssignmentDto): Promise<AssignmentView> {
    return this.settings.endAssignment(idParam(id, 'Assignment'), body.validTo);
  }

  @Delete('schedule-assignments/:id')
  @HttpCode(204)
  @RequirePermission('attendance.configure')
  deleteAssignment(@Param('id') id: string): Promise<void> {
    return this.settings.deleteAssignment(idParam(id, 'Assignment'));
  }

  // ── kiosks ──
  @Get('kiosks')
  @RequirePermission('attendance.configure')
  kiosksList(): Promise<{ items: KioskView[] }> {
    return this.kiosks.list();
  }

  /** 201 with the kiosk and its first pairing code (shown once). */
  @Post('kiosks')
  @RequirePermission('attendance.configure')
  createKiosk(@Body() body: CreateKioskDto): Promise<{ kiosk: KioskView; pairing: PairingCodeView }> {
    return this.kiosks.create(body);
  }

  @Patch('kiosks/:id')
  @RequirePermission('attendance.configure')
  updateKiosk(@Param('id') id: string, @Body() body: UpdateKioskDto): Promise<KioskView> {
    return this.kiosks.update(idParam(id, 'Kiosk'), body);
  }

  @Post('kiosks/:id/pairing-code')
  @HttpCode(200)
  @RequirePermission('attendance.configure')
  pairingCode(@Param('id') id: string): Promise<PairingCodeView> {
    return this.kiosks.pairingCode(idParam(id, 'Kiosk'));
  }

  @Post('kiosks/:id/revoke')
  @HttpCode(200)
  @RequirePermission('attendance.configure')
  revoke(@Param('id') id: string, @Body() body: RevokeKioskDto): Promise<KioskView> {
    return this.kiosks.revoke(idParam(id, 'Kiosk'), body.reason);
  }
}
