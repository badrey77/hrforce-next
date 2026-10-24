import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Res, StreamableFile, Query } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermission } from '../../../platform/authz/decorators.js';
import { PayrollExportService } from '../application/payroll-export.service.js';
import type { EmployeeCodeView, PayrollSettingsView, RubriqueView, SettingsPreview } from '../application/payroll-settings-views.js';
import { PayrollSettingsService } from '../application/payroll-settings.service.js';
import { ControlQueryDto, CreateRubriqueDto, EmployeeCodeDto, ExportQueryDto, isUuid, PayrollSettingsDto, UpdateRubriqueDto } from './payroll-settings.dto.js';

function id(value: string, what: string): string {
  if (!isUuid(value)) throw new NotFoundException(`${what} not found`);
  return value.toLowerCase();
}

/** Settings, rubriques and payroll matricules (docs/contracts/payroll-variables.md › Endpoints). */
@Controller('payroll')
export class PayrollSettingsController {
  constructor(private readonly settings: PayrollSettingsService) {}

  @Get('settings')
  @RequirePermission('payroll.configure')
  get(): Promise<PayrollSettingsView> {
    return this.settings.settings();
  }

  @Put('settings')
  @RequirePermission('payroll.configure')
  save(@Body() body: PayrollSettingsDto): Promise<PayrollSettingsView> {
    return this.settings.saveSettings(body);
  }

  @Get('settings/preview')
  @RequirePermission('payroll.configure')
  preview(): Promise<SettingsPreview> {
    return this.settings.preview();
  }

  @Get('rubriques')
  @RequirePermission('payroll.read')
  rubriques(): Promise<{ items: RubriqueView[] }> {
    return this.settings.rubriques();
  }

  @Post('rubriques')
  @HttpCode(201)
  @RequirePermission('payroll.configure')
  create(@Body() body: CreateRubriqueDto): Promise<RubriqueView> {
    return this.settings.createRubrique(body);
  }

  @Put('rubriques/:id')
  @RequirePermission('payroll.configure')
  update(@Param('id') rubriqueId: string, @Body() body: UpdateRubriqueDto): Promise<RubriqueView> {
    return this.settings.updateRubrique(id(rubriqueId, 'Rubrique'), body);
  }

  @Put('employee-codes/:employeeId')
  @RequirePermission('payroll.prepare')
  employeeCode(@Param('employeeId') employeeId: string, @Body() body: EmployeeCodeDto): Promise<EmployeeCodeView> {
    return this.settings.setEmployeeCode(id(employeeId, 'Employee'), body.code);
  }
}

/** The payroll file and the control report of a month (docs/contracts/payroll-variables.md › Export file). */
@Controller('payroll/periods')
export class PayrollExportController {
  constructor(private readonly exports: PayrollExportService) {}

  @Get(':month/export')
  @RequirePermission('payroll.export')
  async export(@Param('month') month: string, @Query() query: ExportQueryDto, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await this.exports.export(month, query);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from(file.bytes));
  }

  @Get(':month/control.csv')
  @RequirePermission('payroll.read')
  async control(@Param('month') month: string, @Query() query: ControlQueryDto, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await this.exports.control(month, query);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from(file.bytes));
  }
}
