import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { seedWorkflowDefinitions } from '../../workflow/index.js';

/*
 * Default leave configuration of a company (docs/contracts/leave.md › Assumptions — Algerian defaults, Law 90-11,
 * TO BE CONFIRMED by the owner; every value is data editable with leave.configure). Used by seed:dev and the e2e
 * fixtures; runs as the MIGRATOR (company_id written explicitly). Idempotent: existing rows (same code / date) are
 * left untouched, so HR edits survive a re-seed.
 */

type Executor = Kysely<DB> | Transaction<DB>;

interface DefaultType {
  code: string;
  fr: string;
  ar: string;
  en: string;
  countMode: 'calendar' | 'working';
  hasBalance: boolean;
  accrual: number | null;
  maxYear: number | null;
  maxRequest: number | null;
  once: boolean;
  document: boolean;
  workflow: 'leave.manager_then_hr' | 'leave.hr_only';
}

/**
 * Special paid leaves (art. 54) are counted in WORKING days (3 working days); annual, maternity, sick, pilgrimage and
 * unpaid leave in calendar days.
 */
export const DEFAULT_LEAVE_TYPES: readonly DefaultType[] = [
  { code: 'annual', fr: 'Congé annuel', ar: 'العطلة السنوية', en: 'Annual leave', countMode: 'calendar', hasBalance: true, accrual: 2.5, maxYear: 30, maxRequest: null, once: false, document: false, workflow: 'leave.manager_then_hr' },
  { code: 'recovery', fr: 'Récupération', ar: 'عطلة تعويضية', en: 'Recovery leave', countMode: 'working', hasBalance: true, accrual: null, maxYear: null, maxRequest: null, once: false, document: false, workflow: 'leave.manager_then_hr' },
  { code: 'sick', fr: 'Congé de maladie', ar: 'عطلة مرضية', en: 'Sick leave', countMode: 'calendar', hasBalance: false, accrual: null, maxYear: null, maxRequest: null, once: false, document: true, workflow: 'leave.manager_then_hr' },
  { code: 'maternity', fr: 'Congé de maternité', ar: 'عطلة الأمومة', en: 'Maternity leave', countMode: 'calendar', hasBalance: false, accrual: null, maxYear: null, maxRequest: 98, once: false, document: false, workflow: 'leave.manager_then_hr' },
  { code: 'marriage', fr: 'Mariage du travailleur', ar: 'زواج العامل', en: 'Marriage of the worker', countMode: 'working', hasBalance: false, accrual: null, maxYear: null, maxRequest: 3, once: false, document: false, workflow: 'leave.manager_then_hr' },
  { code: 'birth', fr: 'Naissance d’un enfant', ar: 'ازدياد مولود', en: 'Birth of a child', countMode: 'working', hasBalance: false, accrual: null, maxYear: null, maxRequest: 3, once: false, document: false, workflow: 'leave.manager_then_hr' },
  { code: 'child_marriage', fr: 'Mariage d’un enfant', ar: 'زواج أحد الأبناء', en: 'Marriage of a child', countMode: 'working', hasBalance: false, accrual: null, maxYear: null, maxRequest: 3, once: false, document: false, workflow: 'leave.manager_then_hr' },
  { code: 'bereavement', fr: 'Décès d’un proche', ar: 'وفاة أحد الأقارب', en: 'Bereavement', countMode: 'working', hasBalance: false, accrual: null, maxYear: null, maxRequest: 3, once: false, document: false, workflow: 'leave.manager_then_hr' },
  { code: 'circumcision', fr: 'Circoncision d’un enfant', ar: 'ختان أحد الأبناء', en: 'Circumcision of a child', countMode: 'working', hasBalance: false, accrual: null, maxYear: null, maxRequest: 3, once: false, document: false, workflow: 'leave.manager_then_hr' },
  { code: 'pilgrimage', fr: 'Pèlerinage (Hajj)', ar: 'أداء فريضة الحج', en: 'Pilgrimage (Hajj)', countMode: 'calendar', hasBalance: false, accrual: null, maxYear: null, maxRequest: 30, once: true, document: false, workflow: 'leave.manager_then_hr' },
  { code: 'unpaid', fr: 'Congé sans solde', ar: 'عطلة بدون أجر', en: 'Unpaid leave', countMode: 'calendar', hasBalance: false, accrual: null, maxYear: null, maxRequest: null, once: false, document: false, workflow: 'leave.hr_only' },
];

interface DefaultHoliday {
  date: string;
  fr: string;
  ar: string;
  en: string;
  approximate: boolean;
}

const fixed = (year: number): DefaultHoliday[] => [
  { date: `${year}-01-01`, fr: 'Jour de l’an', ar: 'رأس السنة الميلادية', en: 'New Year’s Day', approximate: false },
  { date: `${year}-01-12`, fr: 'Yennayer', ar: 'يناير (رأس السنة الأمازيغية)', en: 'Yennayer (Amazigh New Year)', approximate: false },
  { date: `${year}-05-01`, fr: 'Fête du travail', ar: 'عيد العمال', en: 'Labour Day', approximate: false },
  { date: `${year}-07-05`, fr: 'Fête de l’indépendance', ar: 'عيد الاستقلال', en: 'Independence Day', approximate: false },
  { date: `${year}-11-01`, fr: 'Fête de la Révolution', ar: 'عيد الثورة', en: 'Revolution Day', approximate: false },
];

const lunar = (fitr: string, fitr2: string, adha: string, adha2: string, muharram: string, ashura: string, mawlid: string): DefaultHoliday[] => [
  { date: fitr, fr: 'Aïd el-Fitr', ar: 'عيد الفطر', en: 'Eid al-Fitr', approximate: true },
  { date: fitr2, fr: 'Aïd el-Fitr (2e jour)', ar: 'عيد الفطر (اليوم الثاني)', en: 'Eid al-Fitr (2nd day)', approximate: true },
  { date: adha, fr: 'Aïd el-Adha', ar: 'عيد الأضحى', en: 'Eid al-Adha', approximate: true },
  { date: adha2, fr: 'Aïd el-Adha (2e jour)', ar: 'عيد الأضحى (اليوم الثاني)', en: 'Eid al-Adha (2nd day)', approximate: true },
  { date: muharram, fr: 'Awal Muharram', ar: 'رأس السنة الهجرية', en: 'Islamic New Year', approximate: true },
  { date: ashura, fr: 'Achoura', ar: 'عاشوراء', en: 'Ashura', approximate: true },
  { date: mawlid, fr: 'Mawlid Ennabaoui', ar: 'المولد النبوي الشريف', en: 'Mawlid (Prophet’s birthday)', approximate: true },
];

/** 2026–2027: fixed-date holidays + the lunar ones (APPROXIMATE: HR confirms the dates each year). */
export const DEFAULT_HOLIDAYS: readonly DefaultHoliday[] = [
  ...fixed(2026),
  ...lunar('2026-03-20', '2026-03-21', '2026-05-27', '2026-05-28', '2026-06-16', '2026-06-25', '2026-08-25'),
  ...fixed(2027),
  ...lunar('2027-03-10', '2027-03-11', '2027-05-17', '2027-05-18', '2027-06-06', '2027-06-15', '2027-08-15'),
].toSorted((a, b) => (a.date < b.date ? -1 : 1));

/** Policy, workflow definitions, leave types and 2026–2027 holidays of a company (idempotent). Returns type code → id. */
export async function seedLeaveDefaults(db: Executor, companyId: string): Promise<Map<string, string>> {
  await sql`insert into leave_policy (company_id) values (${companyId}::uuid) on conflict (company_id) do nothing`.execute(db);
  const definitions = await seedWorkflowDefinitions(db, companyId);
  for (const [i, t] of DEFAULT_LEAVE_TYPES.entries()) {
    const workflowId = definitions.get(t.workflow);
    if (!workflowId) throw new Error(`seed: missing workflow definition ${t.workflow}`);
    await sql`
      insert into leave_type (company_id, code, name_fr, name_ar, name_en, count_mode, has_balance, accrual_days_per_month,
                              max_days_per_year, max_days_per_request, once_per_career, requires_document, workflow_definition_id, sort_order)
      values (${companyId}::uuid, ${t.code}, ${t.fr}, ${t.ar}, ${t.en}, ${t.countMode}, ${t.hasBalance}, ${t.accrual}, ${t.maxYear},
              ${t.maxRequest}, ${t.once}, ${t.document}, ${workflowId}::uuid, ${(i + 1) * 10})
      on conflict (company_id, code) do nothing`.execute(db);
  }
  for (const h of DEFAULT_HOLIDAYS) {
    await sql`
      insert into public_holiday (company_id, date, name_fr, name_ar, name_en, approximate)
      values (${companyId}::uuid, ${h.date}::date, ${h.fr}, ${h.ar}, ${h.en}, ${h.approximate})
      on conflict (company_id, date) do nothing`.execute(db);
  }
  const rows = await db.selectFrom('leave_type').select(['id', 'code']).where('company_id', '=', companyId).execute();
  return new Map(rows.map((r) => [r.code, r.id]));
}
