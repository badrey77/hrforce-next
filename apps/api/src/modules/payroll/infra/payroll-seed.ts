import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { DEFAULT_PAYROLL_SETTINGS, type PayrollSettings, type RubriqueSource, type RubriqueUnit } from '../domain/settings.js';

/*
 * Payroll defaults (docs/contracts/payroll-variables.md › Seed). Placeholder export codes, to replace with the real
 * PC-PAIE codes in the settings. Runs as the MIGRATOR (company_id written explicitly). Idempotent: existing rows are
 * left untouched, so HR edits survive a re-seed. The same list as migration 0024 (existing companies).
 */

type Executor = Kysely<DB> | Transaction<DB>;

/** Export code of the rubrique of a leave type (the default types; others: `CG_` + the type code). */
const LEAVE_CODES: Readonly<Record<string, string>> = {
  annual: 'CG_ANNUEL',
  recovery: 'CG_RECUP',
  sick: 'CG_MALADIE',
  maternity: 'CG_MATERNITE',
  marriage: 'CG_MARIAGE',
  birth: 'CG_NAISSANCE',
  child_marriage: 'CG_MARIAGE_ENF',
  bereavement: 'CG_DECES',
  circumcision: 'CG_CIRCONCISION',
  pilgrimage: 'CG_HADJ',
  unpaid: 'CG_SANS_SOLDE',
};

/** Leave types whose rubrique starts inactive (recovery is not a payroll event). */
const INACTIVE_LEAVE = new Set(['recovery']);

export function leaveExportCode(leaveTypeCode: string): string {
  return LEAVE_CODES[leaveTypeCode] ?? `CG_${leaveTypeCode.slice(0, 17).toUpperCase()}`;
}

interface DefaultRubrique {
  source: RubriqueSource;
  code: string;
  fr: string;
  ar: string;
  en: string;
  unit: RubriqueUnit;
  active: boolean;
  sortOrder: number;
}

/** The computed non-leave rubriques; lateness and overtime inactive (Law 90-11 art. 31: prior authorisation). */
export const DEFAULT_COMPUTED_RUBRIQUES: readonly DefaultRubrique[] = [
  { source: 'absence', code: 'ABS_NJ', fr: 'Absence non justifiée', ar: 'غياب غير مبرر', en: 'Unjustified absence', unit: 'days', active: true, sortOrder: 500 },
  { source: 'service_days', code: 'JRS_PRES', fr: 'Jours de présence', ar: 'أيام الحضور', en: 'Days employed', unit: 'days', active: true, sortOrder: 510 },
  { source: 'late', code: 'RETARD', fr: 'Retards', ar: 'التأخرات', en: 'Lateness', unit: 'hours', active: false, sortOrder: 520 },
  { source: 'overtime_normal', code: 'HS50', fr: 'Heures supplémentaires', ar: 'الساعات الإضافية', en: 'Overtime', unit: 'hours', active: false, sortOrder: 530 },
  { source: 'overtime_rest_day', code: 'HS75', fr: 'Heures supplémentaires — repos', ar: 'الساعات الإضافية — يوم الراحة', en: 'Overtime — rest day', unit: 'hours', active: false, sortOrder: 540 },
  { source: 'overtime_holiday', code: 'HS100', fr: 'Heures supplémentaires — jour férié', ar: 'الساعات الإضافية — يوم عطلة رسمية', en: 'Overtime — public holiday', unit: 'hours', active: false, sortOrder: 550 },
];

/** DEMO's items typed by hand (TEST DATA). */
export const DEMO_MANUAL_RUBRIQUES: readonly Omit<DefaultRubrique, 'source' | 'active'>[] = [
  { code: 'PRIME_REND', fr: 'Prime de rendement', ar: 'منحة المردودية', en: 'Performance bonus', unit: 'amount', sortOrder: 600 },
  { code: 'AVANCE', fr: 'Avance sur salaire', ar: 'تسبيق على الأجر', en: 'Salary advance', unit: 'amount', sortOrder: 610 },
  { code: 'IND_PANIER_J', fr: 'Indemnité de panier', ar: 'منحة القفة', en: 'Meal allowance', unit: 'days', sortOrder: 620 },
];

/**
 * The computed rubriques of a company: one per leave type (run after the leave defaults) and the six other sources
 * (bootstrap, seed:dev). Returns the number of rubriques the company has.
 */
export async function seedPayrollDefaults(db: Executor, companyId: string): Promise<number> {
  const types = await db.selectFrom('leave_type').select(['id', 'code', 'name_fr', 'name_ar', 'name_en', 'sort_order']).where('company_id', '=', companyId).execute();
  for (const t of types) {
    await sql`
      insert into payroll_rubrique (company_id, source, leave_type_id, export_code, name_fr, name_ar, name_en, unit, active, sort_order)
      values (${companyId}::uuid, 'leave', ${t.id}::uuid, ${leaveExportCode(t.code)}, ${t.name_fr.slice(0, 80)}, ${t.name_ar.slice(0, 80)},
              ${t.name_en.slice(0, 80)}, 'days', ${!INACTIVE_LEAVE.has(t.code)}, ${t.sort_order})
      on conflict do nothing`.execute(db);
  }
  for (const r of DEFAULT_COMPUTED_RUBRIQUES) {
    await sql`
      insert into payroll_rubrique (company_id, source, export_code, name_fr, name_ar, name_en, unit, active, sort_order)
      values (${companyId}::uuid, ${r.source}, ${r.code}, ${r.fr}, ${r.ar}, ${r.en}, ${r.unit}, ${r.active}, ${r.sortOrder})
      on conflict do nothing`.execute(db);
  }
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from payroll_rubrique where company_id = ${companyId}::uuid`.execute(db);
  return rows[0]?.n ?? 0;
}

/** The policy row of a company, ONLY when it has none. */
export async function seedPayrollPolicy(db: Executor, companyId: string, s: PayrollSettings = DEFAULT_PAYROLL_SETTINGS): Promise<void> {
  await sql`
    insert into payroll_policy (company_id, cutoff_day, regularization_months, overtime_min_minutes, layout, separator, decimal_separator,
                                encoding, header_row, columns, period_format, file_extension)
    values (${companyId}::uuid, ${s.cutoffDay}, ${s.regularizationMonths}, ${s.overtimeMinMinutes}, ${s.layout}, ${s.separator}, ${s.decimalSeparator},
            ${s.encoding}, ${s.headerRow}, ${s.columns}::text[], ${s.periodFormat}, ${s.fileExtension})
    on conflict (company_id) do nothing`.execute(db);
}

/**
 * seed:dev (DEMO, TEST DATA): the stored default policy (windows1252, per_line), the computed rubriques and the
 * three manual ones. Returns manual export code → rubrique id (for the closings API builder 2 seeds).
 */
export async function seedDemoPayrollRubriques(db: Executor, companyId: string): Promise<Map<string, string>> {
  await seedPayrollPolicy(db, companyId);
  await seedPayrollDefaults(db, companyId);
  for (const r of DEMO_MANUAL_RUBRIQUES) {
    await sql`
      insert into payroll_rubrique (company_id, source, export_code, name_fr, name_ar, name_en, unit, active, sort_order)
      select ${companyId}::uuid, 'manual', ${r.code}, ${r.fr}, ${r.ar}, ${r.en}, ${r.unit}, true, ${r.sortOrder}
       where not exists (select 1 from payroll_rubrique where company_id = ${companyId}::uuid and source = 'manual' and upper(export_code) = upper(${r.code}))
      on conflict do nothing`.execute(db);
  }
  const rows = await db.selectFrom('payroll_rubrique').select(['id', 'export_code']).where('company_id', '=', companyId).execute();
  return new Map(rows.map((r) => [r.export_code, r.id]));
}
