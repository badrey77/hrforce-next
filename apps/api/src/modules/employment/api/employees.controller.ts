import { Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermission } from '../../../platform/authz/decorators.js';
import type { EmployeeDetail, EmployeeListView } from '../application/employee-views.js';
import { EmployeesService } from '../application/employees.service.js';
import {
  AssignDto,
  CreateEmployeeDto,
  EndEmploymentDto,
  isUuid,
  ListEmployeesQueryDto,
  SetBankDto,
  SetNssDto,
  SetSalaryDto,
  UpdatePersonDto,
} from './employees.dto.js';

/** A malformed id cannot exist: 404 like any unknown / other-tenant / out-of-scope id. */
function employmentId(id: string): string {
  if (!isUuid(id)) throw new NotFoundException('Employee not found');
  return id.toLowerCase();
}

/** Employee endpoints — docs/contracts/employment.md (`:id` = employment id). */
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermission('employee.read')
  list(@Query() query: ListEmployeesQueryDto): Promise<EmployeeListView> {
    return this.employees.list(query);
  }

  @Get(':id')
  @RequirePermission('employee.read')
  get(@Param('id') id: string): Promise<EmployeeDetail> {
    return this.employees.get(employmentId(id));
  }

  @Post()
  @RequirePermission('employee.create')
  async create(@Body() body: CreateEmployeeDto, @Res({ passthrough: true }) res: Response): Promise<EmployeeDetail> {
    const detail = await this.employees.create(body);
    res.location(`/api/employees/${detail.id}`);
    return detail;
  }

  @Patch(':id/person')
  @RequirePermission('employee.update')
  updatePerson(@Param('id') id: string, @Body() body: UpdatePersonDto): Promise<EmployeeDetail> {
    return this.employees.updatePerson(employmentId(id), body);
  }

  @Post(':id/assignments')
  @HttpCode(200)
  @RequirePermission('employee.update')
  assign(@Param('id') id: string, @Body() body: AssignDto): Promise<EmployeeDetail> {
    return this.employees.assign(employmentId(id), body);
  }

  @Post(':id/end')
  @HttpCode(200)
  @RequirePermission('employee.update')
  end(@Param('id') id: string, @Body() body: EndEmploymentDto): Promise<EmployeeDetail> {
    return this.employees.end(employmentId(id), body);
  }

  @Put(':id/salary')
  @RequirePermission('employee.salary.update')
  setSalary(@Param('id') id: string, @Body() body: SetSalaryDto): Promise<EmployeeDetail> {
    return this.employees.setSalary(employmentId(id), body);
  }

  @Put(':id/bank')
  @RequirePermission('employee.bank.update')
  setBank(@Param('id') id: string, @Body() body: SetBankDto): Promise<EmployeeDetail> {
    return this.employees.setBank(employmentId(id), body);
  }

  @Put(':id/nss')
  @RequirePermission('employee.nss.update')
  setNss(@Param('id') id: string, @Body() body: SetNssDto): Promise<EmployeeDetail> {
    return this.employees.setNss(employmentId(id), body);
  }
}
