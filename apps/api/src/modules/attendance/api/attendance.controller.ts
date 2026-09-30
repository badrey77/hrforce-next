import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Authenticated, RequirePermission } from '../../../platform/authz/decorators.js';
import type {
  CorrectionDetailView,
  CorrectionPage,
  CorrectionView,
  EmployeeDaysView,
  MonthlyReportView,
  ReceiptView,
  MyDaysView,
  PresenceBoardView,
  PunchResultView,
  PunchView,
  ScheduleSegmentsView,
  TeamPresenceView,
} from '../application/attendance-views.js';
import { CheckInService } from '../application/check-in.service.js';
import { CorrectionsService } from '../application/corrections.service.js';
import { ReportsService } from '../application/reports.service.js';
import { PresenceService } from '../application/presence.service.js';
import { PunchesService } from '../application/punches.service.js';
import {
  CorrectionListQueryDto,
  CorrectionRequestDto,
  CorrectionStatusQueryDto,
  DayRangeQueryDto,
  isUuid,
  ManualPunchDto,
  MonthlyReportQueryDto,
  PresenceQueryDto,
  TeamQueryDto,
  VoidPunchDto,
} from './attendance.dto.js';

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
    private readonly corrections: CorrectionsService,
  ) {}

  /**
   * What redeeming the scan receipt would record (kiosk, time, inferred direction, duplicate) — read before the /punch
   * one-tap confirmation; writes nothing, keeps the receipt.
   */
  @Get('attendance/receipt')
  @RequirePermission('attendance.punch_self')
  receipt(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ReceiptView> {
    res.setHeader('Cache-Control', 'no-store');
    return this.checkIn.receiptPreview(req);
  }

  /** Phase B: a correction request for one day (1–4 changes) → 201, through the workflow engine. */
  @Post('attendance/corrections')
  @RequirePermission('attendance.punch_self')
  requestCorrection(@Body() body: CorrectionRequestDto): Promise<CorrectionView> {
    return this.corrections.request(body);
  }

  @Get('attendance/corrections')
  @RequirePermission('attendance.punch_self')
  myCorrections(@Query() query: CorrectionStatusQueryDto): Promise<{ items: CorrectionView[] }> {
    return this.corrections.mine(query.status);
  }

  @Post('attendance/corrections/:id/cancel')
  @HttpCode(200)
  @RequirePermission('attendance.punch_self')
  cancelCorrection(@Param('id') id: string): Promise<CorrectionView> {
    return this.corrections.cancelOwn(idParam(id, 'Correction'));
  }

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

/**
 * Phase B, HR side (docs/contracts/attendance.md › Phase B › Endpoints): the scoped corrections list and a correction's
 * detail, the monthly report and its CSV export. Approval / rejection go through POST /tasks/:id/approve|reject.
 */
@Controller('attendance')
export class AttendanceCorrectionsController {
  constructor(
    private readonly corrections: CorrectionsService,
    private readonly reports: ReportsService,
  ) {}

  @Get('corrections')
  @RequirePermission('attendance.read')
  list(@Query() query: CorrectionListQueryDto): Promise<CorrectionPage> {
    return this.corrections.list(query);
  }

  /** The employee's linked user, a current candidate of its task, or attendance.read over the employee (else 404). */
  @Get('corrections/:id')
  @Authenticated()
  detail(@Param('id') id: string): Promise<CorrectionDetailView> {
    return this.corrections.detail(idParam(id, 'Correction'));
  }

  @Get('reports/monthly')
  @RequirePermission('attendance.read')
  monthly(@Query() query: MonthlyReportQueryDto): Promise<MonthlyReportView> {
    return this.reports.monthly(query);
  }

  /** UTF-8 with BOM, `;`-separated, CRLF, header in `lang` (fr | ar); every row (≤ 5 000); audited. */
  @Get('reports/monthly.csv')
  @RequirePermission('attendance.read')
  async monthlyCsv(@Query() query: MonthlyReportQueryDto, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await this.reports.monthlyCsv(query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from(file.body, 'utf8'));
  }
}
