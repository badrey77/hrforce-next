import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { RequirePermission } from '../../../platform/authz/decorators.js';
import type { EmployeeVariables, PeriodSummary, PeriodView, VariablesPage } from '../application/variables-views.js';
import { VariablesService } from '../application/variables.service.js';
import { CloseDto, DeleteLineQueryDto, isUuid, LineDto, PeriodsQueryDto, ReopenDto, VariablesQueryDto } from './variables.dto.js';

const employee = (id: string): string => {
  if (!isUuid(id)) throw new NotFoundException('Employee not found');
  return id.toLowerCase();
};

/** The months, their variables, adjustments, close and reopen (docs/contracts/payroll-variables.md › Endpoints). */
@Controller('payroll/periods')
export class PayrollVariablesController {
  constructor(private readonly variables: VariablesService) {}

  @Get()
  @RequirePermission('payroll.read')
  periods(@Query() query: PeriodsQueryDto): Promise<{ items: PeriodSummary[] }> {
    return this.variables.periods(query.year);
  }

  @Get(':month')
  @RequirePermission('payroll.read')
  period(@Param('month') month: string): Promise<PeriodView> {
    return this.variables.period(month);
  }

  @Get(':month/variables')
  @RequirePermission('payroll.read')
  list(@Param('month') month: string, @Query() query: VariablesQueryDto): Promise<VariablesPage> {
    return this.variables.variables(month, query);
  }

  @Get(':month/variables/:employeeId')
  @RequirePermission('payroll.read')
  one(@Param('month') month: string, @Param('employeeId') employeeId: string): Promise<EmployeeVariables> {
    return this.variables.employee(month, employee(employeeId));
  }

  @Put(':month/variables/:employeeId/lines')
  @RequirePermission('payroll.prepare')
  putLine(@Param('month') month: string, @Param('employeeId') employeeId: string, @Body() body: LineDto): Promise<EmployeeVariables> {
    return this.variables.putLine(month, employee(employeeId), body);
  }

  @Delete(':month/variables/:employeeId/lines/:rubriqueId')
  @RequirePermission('payroll.prepare')
  deleteLine(
    @Param('month') month: string,
    @Param('employeeId') employeeId: string,
    @Param('rubriqueId') rubriqueId: string,
    @Query() query: DeleteLineQueryDto,
  ): Promise<EmployeeVariables> {
    if (!isUuid(rubriqueId)) throw new NotFoundException('Rubrique not found');
    return this.variables.deleteLine(month, employee(employeeId), rubriqueId.toLowerCase(), query.originMonth);
  }

  @Post(':month/close')
  @HttpCode(200)
  @RequirePermission('payroll.close')
  close(@Param('month') month: string, @Body() _body: CloseDto): Promise<PeriodView> {
    return this.variables.close(month);
  }

  @Post(':month/reopen')
  @HttpCode(200)
  @RequirePermission('payroll.close')
  reopen(@Param('month') month: string, @Body() body: ReopenDto): Promise<PeriodView> {
    return this.variables.reopen(month, body.reason);
  }
}
