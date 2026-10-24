import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException } from '../../../platform/http/problem-details.js';
import { StaffingService } from '../../staffing/index.js';
import { buildExportFile, exportFilename, type ExportLine } from '../domain/export-file.js';
import { monthKey, monthOf } from '../domain/period.js';
import { columnsValid, PAYROLL_PERMISSIONS as P, type PayrollSettings, type RubriqueUnit } from '../domain/settings.js';
import { PayrollSettingsRepository, pgError, type RubriqueRow, type RubriqueWrite } from '../infra/payroll-settings.repository.js';
import { PayrollClock } from './payroll-clock.js';
import { PAYROLL_LINES_SOURCE, type PayrollLinesSource } from './payroll-lines.port.js';
import type { EmployeeCodeView, PayrollSettingsView, RubriqueView, SettingsPreview } from './payroll-settings-views.js';
import { toExportLine } from './payroll-export.service.js';

function tenant(): { companyId: string; userId: string } {
  const { companyId, userId } = requireContext();
  if (!companyId || !userId) throw new NotFoundException();
  return { companyId, userId };
}

export function toRubriqueView(r: RubriqueRow): RubriqueView {
  return {
    id: r.id,
    source: r.source,
    leaveType: r.leaveTypeId && r.leaveTypeCode !== null && r.leaveTypeNames ? { id: r.leaveTypeId, code: r.leaveTypeCode, labels: r.leaveTypeNames } : null,
    exportCode: r.exportCode,
    names: r.names,
    unit: r.unit,
    active: r.active,
    sortOrder: r.sortOrder,
  };
}

const codeTaken = () => new ProblemException(409, 'payroll-code-taken', 'Another active rubrique already uses this export code.', [{ field: 'exportCode', code: 'taken', message: 'Already used by an active rubrique' }]);

/** Lines invented for the settings preview when the current month has none in the caller's scope. */
const SAMPLE_LINES: readonly ExportLine[] = [
  { employeeId: 'sample-1', matricule: 'EMP-0001', lastName: 'Benali', firstName: 'Amine', unitCode: 'DG', rubriqueId: 'sample-annual', exportCode: 'CG_ANNUEL', label: 'Congé annuel', unit: 'days', sortOrder: 10, originMonth: '', value: 3 },
  { employeeId: 'sample-1', matricule: 'EMP-0001', lastName: 'Benali', firstName: 'Amine', unitCode: 'DG', rubriqueId: 'sample-prime', exportCode: 'PRIME_REND', label: 'Prime de rendement', unit: 'amount', sortOrder: 600, originMonth: '', value: 12500.5 },
  { employeeId: 'sample-2', matricule: 'EMP-0002', lastName: 'Cherif', firstName: 'Souad', unitCode: 'DR-EST', rubriqueId: 'sample-abs', exportCode: 'ABS_NJ', label: 'Absence non justifiée', unit: 'days', sortOrder: 500, originMonth: '', value: 1 },
  { employeeId: 'sample-2', matricule: 'EMP-0002', lastName: 'Cherif', firstName: 'Souad', unitCode: 'DR-EST', rubriqueId: 'sample-abs', exportCode: 'ABS_NJ', label: 'Absence non justifiée', unit: 'days', sortOrder: 500, originMonth: 'previous', value: -0.5 },
];

const PREVIEW_ROWS = 5;

/**
 * Settings (policy + export format), rubriques and payroll matricules (docs/contracts/payroll-variables.md ›
 * Endpoints). Settings and rubrique writes need a company-wide `payroll.configure`; a matricule follows the
 * employee's `payroll.prepare` scope.
 */
@Injectable()
export class PayrollSettingsService {
  constructor(
    private readonly repo: PayrollSettingsRepository,
    private readonly scopes: ScopeService,
    private readonly staffing: StaffingService,
    private readonly clock: PayrollClock,
    @Optional() @Inject(PAYROLL_LINES_SOURCE) private readonly lines: PayrollLinesSource | null,
  ) {}

  private async requireCompanyWide(): Promise<void> {
    if (!(await this.scopes.coversCompany(P.configure))) {
      throw new ProblemException(403, 'forbidden-scope', 'Payroll settings are changed company-wide only.');
    }
  }

  async settings(): Promise<PayrollSettingsView> {
    const { companyId } = tenant();
    await this.requireCompanyWide();
    return this.repo.settings(companyId);
  }

  async saveSettings(patch: Partial<PayrollSettings>): Promise<PayrollSettingsView> {
    const { companyId } = tenant();
    await this.requireCompanyWide();
    const current = await this.repo.settings(companyId);
    const next: PayrollSettings = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
    }
    if (!columnsValid(next.layout, next.columns)) {
      throw new ProblemException(422, 'validation-error', 'These columns do not suit the layout.', [
        { field: 'columns', code: 'invalid', message: next.layout === 'per_line' ? 'Distinct columns with matricule, rubrique and value' : 'Distinct identity columns with matricule' },
      ]);
    }
    await this.repo.saveSettings(companyId, next);
    return this.repo.settings(companyId);
  }

  /** The first rows of a file with the current settings: the current month's live lines in scope, else invented ones. */
  async preview(): Promise<SettingsPreview> {
    const { companyId } = tenant();
    await this.requireCompanyWide();
    const settings = await this.repo.settings(companyId);
    const month = monthKey(monthOf(this.clock.today()));
    const rubriques = await this.repo.rubriques(companyId);
    let lines: ExportLine[] = [];
    if (this.lines) {
      const result = await this.lines.linesFor({ month, permission: P.configure, draft: true });
      lines = result.lines.map(toExportLine);
    }
    if (lines.length === 0) {
      const previous = monthKey(monthOf(`${month}-01`, -1));
      lines = SAMPLE_LINES.map((l) => ({ ...l, originMonth: l.originMonth === 'previous' ? previous : month }));
    }
    const exportRubriques = rubriques.map((r) => ({ id: r.id, exportCode: r.exportCode, sortOrder: r.sortOrder, active: r.active }));
    const { text } = buildExportFile(settings, month, lines, exportRubriques);
    const sample = text.split('\r\n').slice(0, PREVIEW_ROWS).filter((row) => row !== '').join('\r\n');
    return { filename: exportFilename(month, null, true, settings.fileExtension), encoding: settings.encoding, sample };
  }

  async rubriques(): Promise<{ items: RubriqueView[] }> {
    const { companyId } = tenant();
    return { items: (await this.repo.rubriques(companyId)).map(toRubriqueView) };
  }

  async createRubrique(input: { exportCode: string; names: { fr: string; ar: string; en: string }; unit: RubriqueUnit }): Promise<RubriqueView> {
    const { companyId } = tenant();
    await this.requireCompanyWide();
    const write: RubriqueWrite = { exportCode: input.exportCode, names: input.names, unit: input.unit, active: true, sortOrder: await this.repo.nextSortOrder(companyId) };
    let id: string;
    try {
      id = await this.repo.createManual(companyId, write);
    } catch (error) {
      if (pgError(error)?.constraint === 'payroll_rubrique_code_uk') throw codeTaken();
      throw error;
    }
    return toRubriqueView((await this.repo.rubrique(companyId, id)) as RubriqueRow);
  }

  async updateRubrique(
    id: string,
    patch: { exportCode?: string | undefined; names?: { fr: string; ar: string; en: string } | undefined; unit?: RubriqueUnit | undefined; active?: boolean | undefined; sortOrder?: number | undefined },
  ): Promise<RubriqueView> {
    const { companyId } = tenant();
    await this.requireCompanyWide();
    const current = await this.repo.rubrique(companyId, id);
    if (!current) throw new NotFoundException('Rubrique not found');
    if (patch.unit !== undefined && patch.unit !== current.unit && current.source !== 'manual') {
      throw new ProblemException(422, 'validation-error', 'The unit of a computed rubrique is fixed.', [{ field: 'unit', code: 'fixed', message: 'Fixed by the source' }]);
    }
    const write: RubriqueWrite = {
      exportCode: patch.exportCode ?? current.exportCode,
      names: patch.names ?? current.names,
      unit: patch.unit ?? current.unit,
      active: patch.active ?? current.active,
      sortOrder: patch.sortOrder ?? current.sortOrder,
    };
    try {
      await this.repo.updateRubrique(companyId, id, write);
    } catch (error) {
      if (pgError(error)?.constraint === 'payroll_rubrique_code_uk') throw codeTaken();
      throw error;
    }
    return toRubriqueView((await this.repo.rubrique(companyId, id)) as RubriqueRow);
  }

  /** PUT /payroll/employee-codes/:employeeId: outside the read scope → 404; read but not prepare → 403. */
  async setEmployeeCode(employeeId: string, code: string | null): Promise<EmployeeCodeView> {
    const { companyId, userId } = tenant();
    const card = (await this.staffing.cards([employeeId], this.clock.today())).get(employeeId);
    if (!card || !(await this.scopes.inScope(P.read, card.unit.id))) throw new NotFoundException('Employee not found');
    if (!(await this.scopes.inScope(P.prepare, card.unit.id))) {
      throw new ProblemException(403, 'forbidden-scope', 'This employee is outside the scope where you can prepare payroll variables.');
    }
    try {
      await this.repo.setEmployeeCode(companyId, employeeId, code, userId);
    } catch (error) {
      if (pgError(error)?.constraint === 'payroll_employee_code_code_uk') {
        throw new ProblemException(409, 'payroll-matricule-taken', 'Another employee already has this payroll ID.', [{ field: 'code', code: 'taken', message: 'Already used' }]);
      }
      throw error;
    }
    return { employeeId, code: await this.repo.employeeCode(companyId, employeeId) };
  }
}
