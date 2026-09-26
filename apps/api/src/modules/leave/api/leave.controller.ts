import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { Authenticated, RequirePermission } from '../../../platform/authz/decorators.js';
import type { DefinitionView } from '../../workflow/index.js';
import { LeaveConfigService } from '../application/leave-config.service.js';
import type { BalancesView, HolidayView, LedgerView, LeaveRequestDetail, LeaveRequestPage, LeaveRequestSummary, LeaveTypeView, PolicyView, PreviewView } from '../application/leave-views.js';
import { LeaveService } from '../application/leave.service.js';
import type { AccrualRunResult } from '../infra/accrual-run.js';
import {
  AccrualRunDto,
  AdjustmentDto,
  BalancesQueryDto,
  HolidayDto,
  HolidaysQueryDto,
  isUuid,
  LeaveListQueryDto,
  LeavePreviewDto,
  LeaveRequestDto,
  PolicyDto,
  UpdateLeaveTypeDto,
} from './leave.dto.js';

function idParam(id: string, what: string): string {
  if (!isUuid(id)) throw new NotFoundException(`${what} not found`);
  return id.toLowerCase();
}

/** Self-service leave (docs/contracts/leave.md › Endpoints: /me/leave/*). Needs a linked employment (409 leave-not-linked). */
@Controller('me/leave')
export class MyLeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get('balances')
  @RequirePermission('leave.request_self')
  balances(@Query() query: BalancesQueryDto): Promise<BalancesView> {
    return this.leave.myBalances(query.asOf);
  }

  @Get('requests')
  @RequirePermission('leave.request_self')
  requests(): Promise<{ items: LeaveRequestSummary[] }> {
    return this.leave.myRequests();
  }

  @Post('requests')
  @RequirePermission('leave.request_self')
  create(@Body() body: LeaveRequestDto): Promise<LeaveRequestDetail> {
    return this.leave.requestSelf(body);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @RequirePermission('leave.request_self')
  cancel(@Param('id') id: string): Promise<LeaveRequestDetail> {
    return this.leave.cancelOwn(idParam(id, 'Leave request'));
  }
}

/** Leave reference data, configuration, HR list / detail, preview and the accrual run (/leave/*). */
@Controller('leave')
export class LeaveController {
  constructor(
    private readonly leave: LeaveService,
    private readonly config: LeaveConfigService,
  ) {}

  /** `leave.request_self` (own) or `leave.request` over `employmentId` — checked by the service. */
  @Post('preview')
  @HttpCode(200)
  @Authenticated()
  preview(@Body() body: LeavePreviewDto): Promise<PreviewView> {
    return this.leave.preview(body);
  }

  @Get('types')
  @Authenticated()
  types(): Promise<{ items: LeaveTypeView[] }> {
    return this.config.types();
  }

  @Put('types/:id')
  @RequirePermission('leave.configure')
  updateType(@Param('id') id: string, @Body() body: UpdateLeaveTypeDto): Promise<LeaveTypeView> {
    return this.config.updateType(idParam(id, 'Leave type'), body);
  }

  @Get('holidays')
  @Authenticated()
  holidays(@Query() query: HolidaysQueryDto): Promise<{ year: number; items: HolidayView[] }> {
    return this.config.holidays(query.year);
  }

  @Post('holidays')
  @RequirePermission('leave.configure')
  createHoliday(@Body() body: HolidayDto): Promise<HolidayView> {
    return this.config.createHoliday(body);
  }

  @Put('holidays/:id')
  @RequirePermission('leave.configure')
  updateHoliday(@Param('id') id: string, @Body() body: HolidayDto): Promise<HolidayView> {
    return this.config.updateHoliday(idParam(id, 'Holiday'), body);
  }

  @Delete('holidays/:id')
  @HttpCode(204)
  @RequirePermission('leave.configure')
  deleteHoliday(@Param('id') id: string): Promise<void> {
    return this.config.deleteHoliday(idParam(id, 'Holiday'));
  }

  @Get('policy')
  @Authenticated()
  policy(): Promise<PolicyView> {
    return this.config.policy();
  }

  @Put('policy')
  @RequirePermission('leave.configure')
  savePolicy(@Body() body: PolicyDto): Promise<PolicyView> {
    return this.config.savePolicy(body);
  }

  @Get('workflows')
  @RequirePermission('leave.configure')
  workflows(): Promise<{ items: DefinitionView[] }> {
    return this.config.workflows();
  }

  @Get('requests')
  @RequirePermission('leave.read')
  list(@Query() query: LeaveListQueryDto): Promise<LeaveRequestPage> {
    return this.leave.list(query);
  }

  /** The requester, the employee's linked user, a current candidate, or leave.read in scope — checked by the service. */
  @Get('requests/:id')
  @Authenticated()
  get(@Param('id') id: string): Promise<LeaveRequestDetail> {
    return this.leave.get(idParam(id, 'Leave request'));
  }

  @Post('accruals/run')
  @HttpCode(200)
  @RequirePermission('leave.adjust')
  runAccruals(@Body() body: AccrualRunDto): Promise<AccrualRunResult> {
    return this.leave.runAccruals(body.month);
  }
}

/** Leave of one employee (HR): /employees/:id/leave/*. Scope: the employee's scope unit today. */
@Controller('employees/:id/leave')
export class EmployeeLeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Post('requests')
  @RequirePermission('leave.request')
  request(@Param('id') id: string, @Body() body: LeaveRequestDto): Promise<LeaveRequestDetail> {
    return this.leave.requestOnBehalf(idParam(id, 'Employee'), body);
  }

  @Get('balances')
  @RequirePermission('leave.read')
  balances(@Param('id') id: string, @Query() query: BalancesQueryDto): Promise<BalancesView> {
    return this.leave.employeeBalances(idParam(id, 'Employee'), query.asOf);
  }

  @Get('ledger')
  @RequirePermission('leave.read')
  ledger(@Param('id') id: string): Promise<{ items: LedgerView[] }> {
    return this.leave.employeeLedger(idParam(id, 'Employee'));
  }

  @Post('adjustments')
  @RequirePermission('leave.adjust')
  adjust(@Param('id') id: string, @Body() body: AdjustmentDto): Promise<LedgerView> {
    return this.leave.adjust(idParam(id, 'Employee'), body);
  }
}
