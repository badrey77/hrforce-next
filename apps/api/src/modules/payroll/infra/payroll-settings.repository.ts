import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';
import type { DB } from '../../../platform/db/schema.js';
import { DEFAULT_PAYROLL_SETTINGS, type ExportColumn, type PayrollSettings, type RubriqueSource, type RubriqueUnit } from '../domain/settings.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Postgres error raised by a constraint (pg's DatabaseError fields). */
export function pgError(error: unknown): { code: string; constraint?: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (typeof code !== 'string') return undefined;
  return typeof constraint === 'string' ? { code, constraint } : { code };
}

export interface RubriqueRow {
  id: string;
  source: RubriqueSource;
  leaveTypeId: string | null;
  leaveTypeCode: string | null;
  leaveTypeNames: { fr: string; ar: string; en: string } | null;
  exportCode: string;
  names: { fr: string; ar: string; en: string };
  unit: RubriqueUnit;
  active: boolean;
  sortOrder: number;
}

export interface RubriqueWrite {
  exportCode: string;
  names: { fr: string; ar: string; en: string };
  unit: RubriqueUnit;
  active: boolean;
  sortOrder: number;
}

/** Settings, rubriques and payroll matricules — through the request transaction (RLS). */
@Injectable()
export class PayrollSettingsRepository {
  private db(tx?: Executor): Executor {
    return tx ?? currentTx();
  }

  async settings(companyId: string, tx?: Executor): Promise<PayrollSettings> {
    const { rows } = await sql<PayrollSettings>`
      select cutoff_day as "cutoffDay", regularization_months as "regularizationMonths", overtime_min_minutes as "overtimeMinMinutes",
             layout, separator, decimal_separator as "decimalSeparator", encoding, header_row as "headerRow", columns,
             period_format as "periodFormat", file_extension as "fileExtension"
        from payroll_policy where company_id = ${companyId}::uuid`.execute(this.db(tx));
    const row = rows[0];
    return row ? { ...row, columns: [...row.columns] as ExportColumn[] } : { ...DEFAULT_PAYROLL_SETTINGS, columns: [...DEFAULT_PAYROLL_SETTINGS.columns] };
  }

  /** Upsert; an unchanged policy writes nothing (no audit row). */
  async saveSettings(companyId: string, s: PayrollSettings, tx?: Executor): Promise<void> {
    await sql`
      insert into payroll_policy (company_id, cutoff_day, regularization_months, overtime_min_minutes, layout, separator, decimal_separator,
                                  encoding, header_row, columns, period_format, file_extension)
      values (${companyId}::uuid, ${s.cutoffDay}, ${s.regularizationMonths}, ${s.overtimeMinMinutes}, ${s.layout}, ${s.separator}, ${s.decimalSeparator},
              ${s.encoding}, ${s.headerRow}, ${s.columns}::text[], ${s.periodFormat}, ${s.fileExtension})
      on conflict (company_id) do update set
        cutoff_day = excluded.cutoff_day, regularization_months = excluded.regularization_months, overtime_min_minutes = excluded.overtime_min_minutes,
        layout = excluded.layout, separator = excluded.separator, decimal_separator = excluded.decimal_separator, encoding = excluded.encoding,
        header_row = excluded.header_row, columns = excluded.columns, period_format = excluded.period_format, file_extension = excluded.file_extension,
        updated_at = now()
      where (payroll_policy.cutoff_day, payroll_policy.regularization_months, payroll_policy.overtime_min_minutes, payroll_policy.layout,
             payroll_policy.separator, payroll_policy.decimal_separator, payroll_policy.encoding, payroll_policy.header_row, payroll_policy.columns,
             payroll_policy.period_format, payroll_policy.file_extension)
        is distinct from (excluded.cutoff_day, excluded.regularization_months, excluded.overtime_min_minutes, excluded.layout,
             excluded.separator, excluded.decimal_separator, excluded.encoding, excluded.header_row, excluded.columns,
             excluded.period_format, excluded.file_extension)`.execute(this.db(tx));
  }

  /** Every rubrique: active first, then sort order, then export code. */
  async rubriques(companyId: string, tx?: Executor): Promise<RubriqueRow[]> {
    const { rows } = await sql<{
      id: string; source: RubriqueSource; leave_type_id: string | null; lt_code: string | null; lt_fr: string | null; lt_ar: string | null; lt_en: string | null;
      export_code: string; name_fr: string; name_ar: string; name_en: string; unit: RubriqueUnit; active: boolean; sort_order: number;
    }>`
      select r.id, r.source, r.leave_type_id, lt.code as lt_code, lt.name_fr as lt_fr, lt.name_ar as lt_ar, lt.name_en as lt_en,
             r.export_code, r.name_fr, r.name_ar, r.name_en, r.unit, r.active, r.sort_order
        from payroll_rubrique r
        left join leave_type lt on lt.company_id = r.company_id and lt.id = r.leave_type_id
       where r.company_id = ${companyId}::uuid
       order by r.active desc, r.sort_order, upper(r.export_code), r.id`.execute(this.db(tx));
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      leaveTypeId: r.leave_type_id,
      leaveTypeCode: r.lt_code,
      leaveTypeNames: r.lt_code !== null ? { fr: r.lt_fr ?? '', ar: r.lt_ar ?? '', en: r.lt_en ?? '' } : null,
      exportCode: r.export_code,
      names: { fr: r.name_fr, ar: r.name_ar, en: r.name_en },
      unit: r.unit,
      active: r.active,
      sortOrder: r.sort_order,
    }));
  }

  async rubrique(companyId: string, id: string, tx?: Executor): Promise<RubriqueRow | undefined> {
    return (await this.rubriques(companyId, tx)).find((r) => r.id === id);
  }

  async nextSortOrder(companyId: string): Promise<number> {
    const { rows } = await sql<{ n: number | null }>`select max(sort_order)::int as n from payroll_rubrique where company_id = ${companyId}::uuid`.execute(this.db());
    return Math.min(100000, (rows[0]?.n ?? 0) + 10);
  }

  async createManual(companyId: string, r: RubriqueWrite): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into payroll_rubrique (company_id, source, export_code, name_fr, name_ar, name_en, unit, active, sort_order)
      values (${companyId}::uuid, 'manual', ${r.exportCode}, ${r.names.fr}, ${r.names.ar}, ${r.names.en}, ${r.unit}, ${r.active}, ${r.sortOrder})
      returning id`.execute(this.db());
    return (rows[0] as { id: string }).id;
  }

  /** An unchanged rubrique writes nothing (no audit row). */
  async updateRubrique(companyId: string, id: string, r: RubriqueWrite): Promise<void> {
    await sql`
      update payroll_rubrique
         set export_code = ${r.exportCode}, name_fr = ${r.names.fr}, name_ar = ${r.names.ar}, name_en = ${r.names.en},
             unit = ${r.unit}, active = ${r.active}, sort_order = ${r.sortOrder}
       where company_id = ${companyId}::uuid and id = ${id}::uuid
         and (export_code, name_fr, name_ar, name_en, unit, active, sort_order)
             is distinct from (${r.exportCode}, ${r.names.fr}, ${r.names.ar}, ${r.names.en}, ${r.unit}, ${r.active}, ${r.sortOrder}::int)`.execute(this.db());
  }

  async employeeCode(companyId: string, employmentId: string): Promise<string | null> {
    const row = await this.db()
      .selectFrom('payroll_employee_code')
      .select('code')
      .where('company_id', '=', companyId)
      .where('employment_id', '=', employmentId)
      .executeTakeFirst();
    return row?.code ?? null;
  }

  /** Sets (upsert, nothing written when unchanged) or removes the payroll matricule of an employment. */
  async setEmployeeCode(companyId: string, employmentId: string, code: string | null, userId: string): Promise<void> {
    if (code === null) {
      await sql`delete from payroll_employee_code where company_id = ${companyId}::uuid and employment_id = ${employmentId}::uuid`.execute(this.db());
      return;
    }
    await sql`
      insert into payroll_employee_code (company_id, employment_id, code, updated_by)
      values (${companyId}::uuid, ${employmentId}::uuid, ${code}, ${userId}::uuid)
      on conflict (company_id, employment_id) do update set code = excluded.code, updated_by = excluded.updated_by, updated_at = now()
      where payroll_employee_code.code is distinct from excluded.code`.execute(this.db());
  }

  /** The status of a month (`YYYY-MM-01`): a month without a row is open. */
  async periodStatus(companyId: string, month: string): Promise<'open' | 'closed'> {
    const { rows } = await sql<{ status: string }>`
      select status from payroll_period where company_id = ${companyId}::uuid and month = ${month}::date`.execute(this.db());
    return rows[0]?.status === 'closed' ? 'closed' : 'open';
  }

  async unitCode(companyId: string, unitId: string): Promise<string | null> {
    const row = await this.db().selectFrom('org_unit').select('code').where('company_id', '=', companyId).where('id', '=', unitId).executeTakeFirst();
    return row?.code ?? null;
  }
}
