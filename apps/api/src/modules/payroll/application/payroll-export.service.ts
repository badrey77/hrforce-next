import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/index.js';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException } from '../../../platform/http/problem-details.js';
import { buildExportFile, delimitedRows, exportContentType, exportFilename, formatPeriod, formatValue, type Cell, type ExportLine } from '../domain/export-file.js';
import { monthKey, monthOf, parseMonth } from '../domain/period.js';
import { PAYROLL_PERMISSIONS as P } from '../domain/settings.js';
import { PayrollSettingsRepository } from '../infra/payroll-settings.repository.js';
import { PayrollClock } from './payroll-clock.js';
import { PAYROLL_LINES_SOURCE, type PayrollExportLine, type PayrollLinesSource } from './payroll-lines.port.js';

function tenant(): { companyId: string } {
  const { companyId } = requireContext();
  if (!companyId) throw new NotFoundException();
  return { companyId };
}

export function toExportLine(l: PayrollExportLine): ExportLine {
  return {
    employeeId: l.employeeId,
    matricule: l.exportMatricule,
    lastName: l.lastName,
    firstName: l.firstName,
    unitCode: l.unitCode,
    rubriqueId: l.rubriqueId,
    exportCode: l.exportCode,
    label: l.names.fr,
    unit: l.unit,
    sortOrder: l.sortOrder,
    originMonth: l.originMonth,
    value: l.value,
  };
}

export interface DownloadFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

const CONTROL_HEADERS: Record<'fr' | 'ar', string[]> = {
  fr: ['Matricule', 'Matricule paie', 'Nom', 'Prénom', 'Unité', 'Rubrique', 'Libellé', 'Période d’origine', 'Valeur calculée', 'Valeur', 'Ajusté', 'Note'],
  ar: ['الرقم', 'رقم التسجيل في الأجور', 'اللقب', 'الاسم', 'الوحدة', 'البند', 'التسمية', 'الفترة الأصلية', 'القيمة المحسوبة', 'القيمة', 'معدَّل', 'ملاحظة'],
};
const YES_NO: Record<'fr' | 'ar', [string, string]> = { fr: ['Oui', 'Non'], ar: ['نعم', 'لا'] };

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** A number of the control report: decimal comma (Excel in a French locale), empty when none. */
const num = (v: number | null): Cell => ({ number: v === null ? '' : formatValue(v, 'comma') });

/**
 * GET /payroll/periods/:month/export and …/control.csv (docs/contracts/payroll-variables.md › Endpoints, Export
 * file). The lines come from the computation through {@link PayrollLinesSource}; a closed month exports its current
 * closing (identical bytes for the same filter and settings), an open month only as a draft.
 */
@Injectable()
export class PayrollExportService {
  constructor(
    private readonly repo: PayrollSettingsRepository,
    private readonly scopes: ScopeService,
    private readonly audit: AuditEvents,
    private readonly clock: PayrollClock,
    @Optional() @Inject(PAYROLL_LINES_SOURCE) private readonly lines: PayrollLinesSource | null,
  ) {}

  /** `YYYY-MM` → `YYYY-MM` (422 `month` invalid / future). */
  private month(value: string): string {
    const first = parseMonth(value);
    if (!first) throw new ProblemException(422, 'validation-error', 'The month must be written YYYY-MM.', [{ field: 'month', code: 'invalid', message: 'Must be YYYY-MM' }]);
    if (first > monthOf(this.clock.today())) {
      throw new ProblemException(422, 'validation-error', 'This month has not started yet.', [{ field: 'month', code: 'future', message: 'Not started yet' }]);
    }
    return monthKey(first);
  }

  private source(): PayrollLinesSource {
    if (!this.lines) throw new Error('payroll: no PayrollLinesSource bound (PAYROLL_LINES_SOURCE)');
    return this.lines;
  }

  /** The unit filter must be a unit of the caller's scope for `permission` (else 404, ADR 002). */
  private async unitCode(companyId: string, permission: string, unitId: string | undefined): Promise<string | null> {
    if (!unitId) return null;
    const code = await this.repo.unitCode(companyId, unitId);
    if (code === null || !(await this.scopes.inScope(permission, unitId))) throw new NotFoundException('Unit not found');
    return code;
  }

  async export(monthParam: string, query: { unitId?: string | undefined; includeSubUnits: boolean; draft: boolean }): Promise<DownloadFile> {
    const { companyId } = tenant();
    const month = this.month(monthParam);
    const unitCode = await this.unitCode(companyId, P.export, query.unitId);
    const status = await this.repo.periodStatus(companyId, `${month}-01`);
    if (status === 'open' && !query.draft) {
      throw new ProblemException(409, 'payroll-period-open', 'This month is not closed: export a draft or close it first.');
    }
    const draft = status === 'open';
    const result = await this.source().linesFor({ month, permission: P.export, unitId: query.unitId, includeSubUnits: query.includeSubUnits, draft });
    const [settings, rubriques] = await Promise.all([this.repo.settings(companyId), this.repo.rubriques(companyId)]);
    const lines = result.lines.filter((l) => l.value !== 0).map(toExportLine);
    const file = buildExportFile(
      settings,
      month,
      lines,
      rubriques.map((r) => ({ id: r.id, exportCode: r.exportCode, sortOrder: r.sortOrder, active: r.active })),
    );
    await this.audit.record({
      type: 'payroll.exported',
      subject: null,
      data: { month, unitId: query.unitId ?? null, draft, lines: lines.length, version: result.version },
    });
    return { filename: exportFilename(month, unitCode, draft, settings.fileExtension), contentType: exportContentType(settings.encoding), bytes: file.bytes };
  }

  async control(monthParam: string, query: { unitId?: string | undefined; includeSubUnits: boolean; lang: 'fr' | 'ar' }): Promise<DownloadFile> {
    const { companyId } = tenant();
    const month = this.month(monthParam);
    const unitCode = await this.unitCode(companyId, P.read, query.unitId);
    const result = await this.source().linesFor({ month, permission: P.read, unitId: query.unitId, includeSubUnits: query.includeSubUnits, draft: true });
    const settings = await this.repo.settings(companyId);
    const lang = query.lang;
    const arabic = lang === 'ar';
    const [yes, no] = YES_NO[lang];
    const sorted = result.lines
      .filter((l) => l.value !== 0 || l.adjusted)
      .toSorted((a, b) => byString(a.matricule, b.matricule) || byString(a.employeeId, b.employeeId) || a.sortOrder - b.sortOrder || byString(a.exportCode, b.exportCode) || byString(a.originMonth, b.originMonth));
    const rows: Cell[][] = [CONTROL_HEADERS[lang].map((text) => ({ text }))];
    for (const l of sorted) {
      rows.push([
        { text: l.matricule },
        { text: l.payrollCode ?? '' },
        { text: arabic ? l.lastNameAr?.trim() || l.lastName : l.lastName },
        { text: arabic ? l.firstNameAr?.trim() || l.firstName : l.firstName },
        { text: arabic ? l.unitNameAr?.trim() || l.unitName || l.unitCode || '' : l.unitName || l.unitCode || '' },
        { text: l.exportCode },
        { text: arabic ? l.names.ar : l.names.fr },
        { text: formatPeriod(l.originMonth, settings.periodFormat) },
        num(l.computed),
        num(l.value),
        { text: l.adjusted ? yes : no },
        { text: l.note ?? '' },
      ]);
    }
    await this.audit.record({ type: 'payroll.control_exported', subject: null, data: { month, unitId: query.unitId ?? null } });
    const text = '﻿' + delimitedRows(rows, ';');
    const unit = unitCode ? `-${unitCode.replace(/[^A-Za-z0-9_-]/g, '_')}` : '';
    return { filename: `etat-controle-paie-${month}${unit}.csv`, contentType: 'text/csv; charset=utf-8', bytes: new TextEncoder().encode(text) };
  }
}
