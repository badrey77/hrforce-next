import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { decideAccrual } from '../domain/accrual.js';
import { monthEnd } from '../domain/dates.js';
import { periodStartOf, toTenths } from '../domain/rules.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface AccrualRunResult {
  month: string;
  /** employments employed during the month (in the run's scope) */
  employees: number;
  /** of which worked ≥ 15 days */
  eligible: number;
  /** accrual rows written by this run */
  created: number;
  /** (employment, type) pairs already accrued for this month — the run is idempotent */
  alreadyAccrued: number;
}

/**
 * The monthly accrual run (POST /leave/accruals/run; `seed:dev`; later the M2 worker). For every employment employed
 * during `month` (optionally restricted to `employmentIds`, the caller's scope) and every active type with an accrual
 * rate, writes ONE `accrual` ledger row per (employment, type, month) — the partial unique index
 * leave_ledger_accrual_uk makes a second run (or a concurrent one) a no-op. Rules: domain/accrual.ts.
 * Runs on the given executor: the request transaction (API) or the migrator (seed).
 */
export async function runAccruals(
  db: Executor,
  companyId: string,
  month: string,
  options: { employmentIds?: readonly string[] | null; actorUserId: string | null },
): Promise<AccrualRunResult> {
  const last = monthEnd(month);
  const policy = (
    await sql<{ start: number }>`select reference_start_month as start from leave_policy where company_id = ${companyId}::uuid`.execute(db)
  ).rows[0] ?? { start: 7 };
  const types = (
    await sql<{ id: string; rate: string; max: string | null }>`
      select id, accrual_days_per_month::text as rate, max_days_per_year::text as max
        from leave_type where company_id = ${companyId}::uuid and active and accrual_days_per_month is not null`.execute(db)
  ).rows;
  const restrict = options.employmentIds ? sql`and e.id = any(${[...options.employmentIds]}::uuid[])` : sql``;
  // employments employed during the month, with the southern supplement of their site (assignment site, else the
  // unit's effective site on the last day of the month)
  const employments = (
    await sql<{ id: string; hire: string; end: string | null; supplement: number }>`
      with recursive
      uv as (
        select distinct on (v.org_unit_id) v.org_unit_id as id, v.parent_id, v.site_id
          from org_unit_version v
         where v.company_id = ${companyId}::uuid
         order by v.org_unit_id, (v.valid @> ${last}::date) desc, lower(v.valid) asc
      ),
      eff (id, site_id, depth) as (
        select uv.id, uv.site_id, 0 from uv where uv.parent_id is null
        union all
        select uv.id, coalesce(uv.site_id, eff.site_id), eff.depth + 1 from uv join eff on uv.parent_id = eff.id where eff.depth < 64
      )
      select e.id, e.hire_date::text as hire, e.end_date::text as "end", coalesce(s.south_supplement_days, 0) as supplement
        from employment e
        join lateral (
          select x.org_unit_id, x.site_id from assignment x
           where x.company_id = e.company_id and x.employment_id = e.id
           order by case when x.valid @> ${last}::date then 0 when lower(x.valid) <= ${last}::date then 1 else 2 end,
                    case when lower(x.valid) <= ${last}::date then lower(x.valid) end desc nulls last, lower(x.valid) asc
           limit 1
        ) a on true
        left join eff on eff.id = a.org_unit_id
        left join site s on s.company_id = e.company_id and s.id = coalesce(a.site_id, eff.site_id)
       where e.company_id = ${companyId}::uuid and e.hire_date <= ${last}::date
         and (e.end_date is null or e.end_date >= ${month}::date) ${restrict}
       order by e.id`.execute(db)
  ).rows;
  const periodStart = periodStartOf(month, policy.start);
  const prior = (
    await sql<{ employment: string; type: string; month: string | null; tenths: number }>`
      select employment_id as employment, leave_type_id as type, accrual_month::text as month, round(days * 10)::int as tenths
        from leave_ledger
       where company_id = ${companyId}::uuid and kind = 'accrual' and period_start = ${periodStart}::date
         and accrual_month <= ${month}::date`.execute(db)
  ).rows;
  const done = new Set(prior.filter((p) => p.month === month).map((p) => `${p.employment}:${p.type}`));
  const soFar = new Map<string, number>();
  for (const p of prior) if (p.month !== month) soFar.set(`${p.employment}:${p.type}`, (soFar.get(`${p.employment}:${p.type}`) ?? 0) + p.tenths);

  const result: AccrualRunResult = { month: month.slice(0, 7), employees: employments.length, eligible: 0, created: 0, alreadyAccrued: 0 };
  for (const e of employments) {
    let eligible = false;
    for (const type of types) {
      const key = `${e.id}:${type.id}`;
      const decision = decideAccrual({
        month,
        hireDate: e.hire,
        endDate: e.end,
        ratePerMonth: toTenths(type.rate),
        maxPerYear: type.max === null ? null : toTenths(type.max),
        supplementPerYear: e.supplement,
        referenceStartMonth: policy.start,
        accruedSoFar: soFar.get(key) ?? 0,
      });
      eligible ||= decision.counts;
      if (done.has(key)) {
        result.alreadyAccrued += 1;
        continue;
      }
      if (decision.days <= 0) continue;
      const inserted = await sql`
        insert into leave_ledger (company_id, employment_id, leave_type_id, period_start, kind, days, accrual_month, created_by)
        values (${companyId}::uuid, ${e.id}::uuid, ${type.id}::uuid, ${decision.periodStart}::date, 'accrual', ${decision.days / 10},
                ${month}::date, ${options.actorUserId}::uuid)
        on conflict (employment_id, leave_type_id, accrual_month) where kind = 'accrual' do nothing`.execute(db);
      if (Number(inserted.numAffectedRows ?? 0) > 0) result.created += 1;
      else result.alreadyAccrued += 1;
    }
    if (eligible) result.eligible += 1;
  }
  return result;
}
