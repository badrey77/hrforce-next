import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Authenticated, RequirePermission } from '../../../platform/authz/decorators.js';
import type {
  EmployeeDaysView,
  MyDaysView,
  PresenceBoardView,
  PunchResultView,
  PunchView,
  ScheduleSegmentsView,
  TeamPresenceView,
} from '../application/attendance-views.js';
import { CheckInService } from '../application/check-in.service.js';
import { PresenceService } from '../application/presence.service.js';
import { PunchesService } from '../application/punches.service.js';
import { DayRangeQueryDto, isUuid, ManualPunchDto, PresenceQueryDto, TeamQueryDto, VoidPunchDto } from './attendance.dto.js';

function idParam(id: string, what: string): string {
  if (!isUuid(id)) throw new NotFoundException(`${what} not found`);
  return id.toLowerCase();
}

/** Self-service (docs/contracts/attendance.md › Self-service and team): my punch, my days, my team. */
@Controller('me')
export class MyAttendanceController {
  constructor(
    private readonly checkIn: CheckInService,
    private readonly presence: PresenceService,
  ) {}

  /** Redeems the scan receipt: 201 new punch, 200 `duplicate: true`. */
  @Post('attendance/punches')
  @RequirePermission('attendance.punch_self')
  async punch(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<PunchResultView> {
    const { status, view } = await this.checkIn.punch(req, res);
    res.status(status);
    return view;
  }

  @Get('attendance/days')
  @RequirePermission('attendance.punch_self')
  days(@Query() query: DayRangeQueryDto): Promise<MyDaysView> {
    return this.presence.myDays(query);
  }

  /** The units the caller heads on the date and their sub-units — no permission needed (as the leave manager step). */
  @Get('team/presence')
  @Authenticated()
  team(@Query() query: TeamQueryDto): Promise<TeamPresenceView> {
    return this.presence.team(query);
  }
}

/** HR presence (docs/contracts/attendance.md › HR): the board, an employee's days and schedule, manual punches, voids. */
@Controller()
export class AttendanceController {
  constructor(
    private readonly presence: PresenceService,
    private readonly punches: PunchesService,
  ) {}

  @Get('attendance/presence')
  @RequirePermission('attendance.read')
  board(@Query() query: PresenceQueryDto): Promise<PresenceBoardView> {
    return this.presence.board(query);
  }

  @Post('attendance/punches/:id/void')
  @HttpCode(200)
  @RequirePermission('attendance.manage')
  void(@Param('id') id: string, @Body() body: VoidPunchDto): Promise<PunchView> {
    return this.punches.void(idParam(id, 'Punch'), body.reason);
  }

  @Get('employees/:id/attendance/days')
  @RequirePermission('attendance.read')
  employeeDays(@Param('id') id: string, @Query() query: DayRangeQueryDto): Promise<EmployeeDaysView> {
    return this.presence.employeeDays(idParam(id, 'Employee'), query);
  }

  @Get('employees/:id/attendance/schedule')
  @RequirePermission('attendance.read')
  employeeSchedule(@Param('id') id: string, @Query() query: DayRangeQueryDto): Promise<ScheduleSegmentsView> {
    return this.presence.employeeSchedule(idParam(id, 'Employee'), query);
  }

  @Post('employees/:id/attendance/punches')
  @RequirePermission('attendance.manage')
  manual(@Param('id') id: string, @Body() body: ManualPunchDto): Promise<PunchView> {
    return this.punches.manual(idParam(id, 'Employee'), body);
  }
}
