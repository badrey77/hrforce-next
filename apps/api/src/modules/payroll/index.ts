/** Public surface of the Payroll module (the only file other modules — and scripts — may import). */
export { PayrollModule } from './payroll.module.js';
export { PayrollClock, payrollToday } from './application/payroll-clock.js';
export { PAYROLL_LINES_SOURCE, type PayrollExportLine, type PayrollLinesQuery, type PayrollLinesResult, type PayrollLinesSource } from './application/payroll-lines.port.js';
export { DEFAULT_PAYROLL_SETTINGS, PAYROLL_PERMISSIONS, type PayrollSettings } from './domain/settings.js';
export { DEFAULT_COMPUTED_RUBRIQUES, DEMO_MANUAL_RUBRIQUES, leaveExportCode, seedDemoPayrollRubriques, seedPayrollDefaults, seedPayrollPolicy } from './infra/payroll-seed.js';
export { seedDemoPayrollClosing, type DemoPayrollClosingOptions, type DemoPayrollClosingResult } from './infra/variables-seed.js';
