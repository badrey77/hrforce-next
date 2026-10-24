/**
 * Response shapes of the settings, rubriques and payroll-matricule endpoints (docs/contracts/payroll-variables.md ›
 * Endpoints). No key may match /(password|hash|token|secret)/i (CONVENTIONS.md › Security).
 */
import type { PayrollSettings, RubriqueSource, RubriqueUnit } from '../domain/settings.js';

export type Labels = { fr: string; ar: string; en: string };

export interface RubriqueView {
  id: string;
  source: RubriqueSource;
  leaveType: { id: string; code: string; labels: Labels } | null;
  exportCode: string;
  names: Labels;
  unit: RubriqueUnit;
  active: boolean;
  sortOrder: number;
}

export type PayrollSettingsView = PayrollSettings;

export interface SettingsPreview {
  filename: string;
  encoding: PayrollSettings['encoding'];
  /** the first 5 rows of the file (header included), as text */
  sample: string;
}

export interface EmployeeCodeView {
  employeeId: string;
  code: string | null;
}
