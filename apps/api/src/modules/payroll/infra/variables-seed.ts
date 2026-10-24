import { sql, type Kysely, type Transaction } from 'kysely';
import { runWithContext } from '../../../platform/context/request-context.js';
import type { DB } from '../../../platform/db/schema.js';
import { standalonePresenceEngine } from '../../attendance/index.js';
import { LeaveFacts } from '../../leave/index.js';
import type { PayrollClock } from '../application/payroll-clock.js';
import { PayrollEngine } from '../application/payroll-engine.js';
import { lastDayOf, monthOf } from '../domain/period.js';
import { VariablesRepository } from './variables.repository.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface DemoPayrollClosingOptions {
  companyId: string;
  /** the closing's author (rh.admin) */
  closedBy: string;
  /** Algerian today: the previous month is closed */
  today: string;
  /** export code → rubrique id of the manual rubriques (seedDemoPayrollRubriques) */
  manual: ReadonlyMap<string, string>;
  /** [employment id, matricule paie] for two employees */
  payrollCodes: readonly [string, string][];
  /** the employment that gets a bonus (PRIME_REND) in the closed month */
  bonusEmploymentId: string;
  /** the employment whose sick leave in the closed month is approved after the closing (→ a régularisation) */
  lateLeaveEmploymentId: string;
}

export interface DemoPayrollClosingResult {
  /** YYYY-MM-01 */
  closedMonth: string;
  /** false when the month was already closed (the seed is idempotent) */
  closed: boolean;
  lines: number;
  employees: number;
}

/**
 * DEMO payroll (docs/contracts/payroll-variables.md › Seed, TEST DATA): two payroll matricules, the PREVIOUS month
 * closed (version 1) with one adjusted line and one PRIME_REND bonus, computed by the real engine; then a sick leave in
 * that month approved after the closing, so the current (open) month shows a régularisation. Idempotent: a month that
 * already has a closing is left as is. Runs inside `runWithContext` on the seed transaction (owner role).
 */
export async function seedDemoPayrollClosing(db: Executor, o: DemoPayrollClosingOptions): Promise<DemoPayrollClosingResult> {
  const month = monthOf(o.today, -1);
  const repo = new VariablesRepository();
  const clock = { today: () => o.today } as PayrollClock;
  const engine = new PayrollEngine(repo, standalonePresenceEngine(), new LeaveFacts(), clock);
  const tx = db as Transaction<DB>;
  return runWithContext({ requestId: 'seed-dev', userId: o.closedBy, companyId: o.companyId, tx }, async () => {
    // the tenant of the reads that need it (auth.company_members), as a request would set it
    await sql`select set_config('app.company_id', ${o.companyId}, true), set_config('app.user_id', ${o.closedBy}, true)`.execute(tx);
    for (const [employmentId, code] of o.payrollCodes) {
      await sql`insert into payroll_employee_code (company_id, employment_id, code, updated_by)
                values (${o.companyId}::uuid, ${employmentId}::uuid, ${code}, ${o.closedBy}::uuid) on conflict do nothing`.execute(tx);
    }
    const existing = await repo.closings(o.companyId, [month]);
    if (existing.length > 0) return { closedMonth: month, closed: false, lines: existing.at(-1)?.lines ?? 0, employees: existing.at(-1)?.employees ?? 0 };

    const period = await repo.lockPeriod(o.companyId, month, 'update');
    let book = await engine.book(o.companyId);
    // a bonus (amount, central HR only) and one adjusted computed line (else a typed meal allowance)
    const prime = o.manual.get('PRIME_REND');
    if (prime) {
      await repo.upsertAdjustment(o.companyId, { month, originMonth: month, employmentId: o.bonusEmploymentId, rubriqueId: prime, value: 15000, note: 'Prime de rendement (démo)', by: o.closedBy });
    }
    const ids = await repo.activeIn(o.companyId, month, lastDayOf(month));
    const rows = await engine.live(book, month, await repo.employments(o.companyId, ids));
    const computed = rows.flatMap((r) => r.lines.filter((l) => l.source !== 'manual' && l.value > 1).map((l) => ({ employmentId: r.employment.id, line: l })))[0];
    if (computed) {
      await repo.upsertAdjustment(o.companyId, {
        month,
        originMonth: month,
        employmentId: computed.employmentId,
        rubriqueId: computed.line.rubriqueId,
        value: computed.line.value - 1,
        note: 'Ajusté par les RH (démo)',
        by: o.closedBy,
      });
    } else {
      const meal = o.manual.get('IND_PANIER_J');
      if (meal) await repo.upsertAdjustment(o.companyId, { month, originMonth: month, employmentId: o.bonusEmploymentId, rubriqueId: meal, value: 20, note: 'Saisie RH (démo)', by: o.closedBy });
    }
    book = await engine.book(o.companyId);
    const result = await engine.close(book, month, period.id, o.closedBy);

    // approved after the closing: two days of sick leave in the closed month (no balance), the 10th and 11th
    await sql`
      insert into leave_request (company_id, employment_id, leave_type_id, org_unit_id, start_date, end_date, days, status, requested_by, document_ref, reason)
      select ${o.companyId}::uuid, e.id, t.id, a.org_unit_id, ${`${month.slice(0, 8)}10`}::date, ${`${month.slice(0, 8)}11`}::date, 2, 'approved',
             ${o.closedBy}::uuid, 'Certificat médical (démo)', 'Certificat reçu après la clôture (démo)'
        from employment e
        join leave_type t on t.company_id = e.company_id and t.code = 'sick'
        join lateral (select org_unit_id from assignment where company_id = e.company_id and employment_id = e.id order by lower(valid) desc limit 1) a on true
       where e.company_id = ${o.companyId}::uuid and e.id = ${o.lateLeaveEmploymentId}::uuid
      on conflict do nothing`.execute(tx);
    return { closedMonth: month, closed: true, lines: result.lines, employees: result.employees };
  });
}
