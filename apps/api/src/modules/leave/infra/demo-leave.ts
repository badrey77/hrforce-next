/*
 * Demo leave data for `seed:dev` and the e2e fixtures (docs/contracts/leave.md › Seed additions). TEST DATA.
 * Runs as the MIGRATOR (owner, BYPASSRLS): company_id written explicitly. Deterministic and idempotent (fixed ids,
 * `on conflict do nothing`; a request that already exists is left with its history).
 *
 *   users   agent.annaba@demo.dz (EMP-0030, Agence Annaba) and chef.annaba@demo.dz (EMP-0029, head of Agence Annaba),
 *           role `employe` on DG (+ sub-units); rh.est@demo.dz is linked to EMP-0022 (director of Région Est) and
 *           also gets `employe` (Karim is HR and a manager)
 *   heads   DG EMP-0001, DEP-RH EMP-0003, REG-EST EMP-0022 (from 2026-01-01), AG-ANNABA EMP-0029 (from 2026-04-01, his
 *           move date), AG-CNE EMP-0025 until 2026-06-30 (resigned) then EMP-0026 (no linked user → escalations)
 *   ledger  accruals of every month from July 2025 to September 2026: the 2025-26 reference year (30 days, usable from
 *           1 July 2026) and the first months of 2026-27
 *   requests (optional) one or more in each status, with their workflow history
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { seedGrants } from '../../authorization/index.js';
import { demoEmployees } from '../../employment/index.js';
import { DEMO_USERS, seedIdentity, type DemoUser } from '../../identity/index.js';
import { DEMO_ORGANIZATION } from '../../organization/index.js';
import { seedHeads, seedLinks } from '../../staffing/index.js';
import { addMonths } from '../domain/dates.js';
import { runAccruals } from './accrual-run.js';
import { seedLeaveDefaults } from './leave-defaults.js';

type Executor = Kysely<DB> | Transaction<DB>;

const fixed = (kind: number, n: number) => `0190a5d0-0000-7000-${8000 + kind}-${n.toString(16).padStart(12, '0')}`;
const companyId = DEMO_ORGANIZATION.company.id;

function unitId(code: string): string {
  const unit = DEMO_ORGANIZATION.units.find((u) => u.code === code);
  if (!unit) throw new Error(`demo leave: unknown unit ${code}`);
  return unit.id;
}

function userId(email: string, extra: readonly DemoUser[] = []): string {
  const user = [...DEMO_USERS, ...extra].find((u) => u.email === email);
  if (!user) throw new Error(`demo leave: unknown user ${email}`);
  return user.id;
}

const EMPLOYEES = demoEmployees();
/** Employment id of EMP-000n (1-based). */
export function demoEmployment(n: number): string {
  const e = EMPLOYEES[n - 1];
  if (!e) throw new Error(`demo leave: unknown employee ${n}`);
  return e.employmentId;
}

function displayName(n: number): string {
  const e = EMPLOYEES[n - 1];
  return e ? `${e.firstName} ${e.lastName}` : `EMP-${n}`;
}

/** The two self-service demo users (password: DEMO_PASSWORD, like the others). */
export const LEAVE_DEMO_USERS: readonly DemoUser[] = [
  { id: '0190a5d0-0000-7000-8000-0000000000a1', email: 'agent.annaba@demo.dz', displayName: displayName(30), locale: 'fr' },
  { id: '0190a5d0-0000-7000-8000-0000000000a2', email: 'chef.annaba@demo.dz', displayName: displayName(29), locale: 'fr' },
];

export const LEAVE_DEMO = {
  agent: { userId: LEAVE_DEMO_USERS[0]?.id ?? '', employmentId: demoEmployment(30) },
  chef: { userId: LEAVE_DEMO_USERS[1]?.id ?? '', employmentId: demoEmployment(29) },
  karim: { userId: userId('rh.est@demo.dz'), employmentId: demoEmployment(22) },
} as const;

export const DEMO_HEADS = [
  { id: fixed(6, 1), orgUnitId: unitId('DG'), employmentId: demoEmployment(1), validFrom: '2026-01-01', validTo: null },
  { id: fixed(6, 2), orgUnitId: unitId('DEP-RH'), employmentId: demoEmployment(3), validFrom: '2026-01-01', validTo: null },
  { id: fixed(6, 3), orgUnitId: unitId('REG-EST'), employmentId: demoEmployment(22), validFrom: '2026-01-01', validTo: null },
  { id: fixed(6, 4), orgUnitId: unitId('AG-ANNABA'), employmentId: demoEmployment(29), validFrom: '2026-04-01', validTo: null },
  { id: fixed(6, 5), orgUnitId: unitId('AG-CNE'), employmentId: demoEmployment(25), validFrom: '2026-01-01', validTo: '2026-07-01' },
  { id: fixed(6, 6), orgUnitId: unitId('AG-CNE'), employmentId: demoEmployment(26), validFrom: '2026-07-01', validTo: null },
] as const;

export interface SeedDemoLeaveOptions {
  /** also write the demo requests with their workflow history (seed:dev) */
  requests?: boolean;
  /** accrual months, inclusive (default 2025-07 → 2026-09) */
  accrualFrom?: string;
  accrualTo?: string;
}

/** Leave defaults, demo users, links, heads, employe grants and accruals of the demo company (+ requests). */
export async function seedDemoLeave(db: Executor, options: SeedDemoLeaveOptions = {}): Promise<{ accrualRows: number; requests: number }> {
  const types = await seedLeaveDefaults(db, companyId);
  await seedIdentity(db, companyId, LEAVE_DEMO_USERS);
  await seedLinks(db, companyId, [
    { id: fixed(5, 1), userId: LEAVE_DEMO.karim.userId, employmentId: LEAVE_DEMO.karim.employmentId },
    { id: fixed(5, 2), userId: LEAVE_DEMO.agent.userId, employmentId: LEAVE_DEMO.agent.employmentId },
    { id: fixed(5, 3), userId: LEAVE_DEMO.chef.userId, employmentId: LEAVE_DEMO.chef.employmentId },
  ]);
  await seedHeads(db, companyId, DEMO_HEADS);
  await seedGrants(db, companyId, [
    { id: '0190a5d0-0000-7000-8000-000000000304', userId: LEAVE_DEMO.agent.userId, roleCode: 'employe', orgUnitId: unitId('DG'), includeDescendants: true, validFrom: '2026-01-01' },
    { id: '0190a5d0-0000-7000-8000-000000000305', userId: LEAVE_DEMO.chef.userId, roleCode: 'employe', orgUnitId: unitId('DG'), includeDescendants: true, validFrom: '2026-01-01' },
    { id: '0190a5d0-0000-7000-8000-000000000306', userId: LEAVE_DEMO.karim.userId, roleCode: 'employe', orgUnitId: unitId('DG'), includeDescendants: true, validFrom: '2026-01-01' },
  ]);
  let accrualRows = 0;
  const from = `${options.accrualFrom ?? '2025-07'}-01`;
  const to = `${options.accrualTo ?? '2026-09'}-01`;
  for (let month = from; month <= to; month = addMonths(month, 1)) {
    accrualRows += (await runAccruals(db, companyId, month, { actorUserId: null })).created;
  }
  const requests = options.requests ? await seedDemoRequests(db, types) : 0;
  return { accrualRows, requests };
}

// ── demo requests ───────────────────────────────────────────────────────────────────────────────────────────────

interface SeedTask {
  step: 'manager' | 'hr';
  kind: 'user' | 'permission' | 'none';
  user?: string;
  status: 'open' | 'done' | 'skipped' | 'cancelled';
  outcome?: 'approve' | 'reject' | 'escalated';
  actedBy?: string;
  at: string;
  actedAt?: string;
  comment?: string;
}

interface SeedRequest {
  n: number;
  employee: number;
  unit: string;
  type: string;
  start: string;
  end: string;
  days: number;
  reason?: string;
  documentRef?: string;
  requestedBy: string;
  subjectUser: string | null;
  at: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  definition: 'leave.manager_then_hr' | 'leave.hr_only';
  finishedAt?: string;
  tasks: SeedTask[];
  /** taken rows (approved): reference year → days */
  taken?: { periodStart: string; days: number }[];
}

const HR = 'leave.approve_hr';

function demoRequests(): SeedRequest[] {
  const { agent, chef, karim } = LEAVE_DEMO;
  const admin = userId('rh.admin@demo.dz');
  return [
    {
      n: 1, employee: 30, unit: 'AG-ANNABA', type: 'annual', start: '2026-08-09', end: '2026-08-13', days: 5, reason: 'Vacances d’été',
      requestedBy: agent.userId, subjectUser: agent.userId, at: '2026-07-20T08:30:00Z', status: 'approved', definition: 'leave.manager_then_hr', finishedAt: '2026-07-22T10:05:00Z',
      tasks: [
        { step: 'manager', kind: 'user', user: chef.userId, status: 'done', outcome: 'approve', actedBy: chef.userId, at: '2026-07-20T08:30:00Z', actedAt: '2026-07-21T09:00:00Z' },
        { step: 'hr', kind: 'permission', status: 'done', outcome: 'approve', actedBy: karim.userId, at: '2026-07-21T09:00:00Z', actedAt: '2026-07-22T10:05:00Z', comment: 'Bon repos.' },
      ],
      taken: [{ periodStart: '2025-07-01', days: 5 }],
    },
    {
      n: 2, employee: 30, unit: 'AG-ANNABA', type: 'sick', start: '2026-06-14', end: '2026-06-15', days: 2, documentRef: 'CM-2026-0613',
      requestedBy: agent.userId, subjectUser: agent.userId, at: '2026-06-13T07:45:00Z', status: 'cancelled', definition: 'leave.manager_then_hr', finishedAt: '2026-06-13T12:00:00Z',
      tasks: [{ step: 'manager', kind: 'user', user: chef.userId, status: 'cancelled', at: '2026-06-13T07:45:00Z' }],
    },
    {
      n: 3, employee: 30, unit: 'AG-ANNABA', type: 'annual', start: '2026-12-27', end: '2026-12-31', days: 5,
      requestedBy: agent.userId, subjectUser: agent.userId, at: '2026-09-10T09:15:00Z', status: 'rejected', definition: 'leave.manager_then_hr', finishedAt: '2026-09-11T08:20:00Z',
      tasks: [
        { step: 'manager', kind: 'user', user: chef.userId, status: 'done', outcome: 'reject', actedBy: chef.userId, at: '2026-09-10T09:15:00Z', actedAt: '2026-09-11T08:20:00Z', comment: 'Clôture de fin d’année : présence requise. Merci de proposer une autre période.' },
      ],
    },
    {
      n: 4, employee: 31, unit: 'AG-ANNABA', type: 'annual', start: '2026-10-18', end: '2026-10-22', days: 5,
      requestedBy: admin, subjectUser: null, at: '2026-09-22T10:00:00Z', status: 'pending', definition: 'leave.manager_then_hr',
      tasks: [{ step: 'manager', kind: 'user', user: chef.userId, status: 'open', at: '2026-09-22T10:00:00Z' }],
    },
    {
      n: 5, employee: 32, unit: 'SRV-CLI-ANB', type: 'annual', start: '2026-11-08', end: '2026-11-12', days: 5,
      requestedBy: admin, subjectUser: null, at: '2026-09-18T11:30:00Z', status: 'pending', definition: 'leave.manager_then_hr',
      tasks: [
        { step: 'manager', kind: 'user', user: chef.userId, status: 'done', outcome: 'approve', actedBy: chef.userId, at: '2026-09-18T11:30:00Z', actedAt: '2026-09-21T08:10:00Z' },
        { step: 'hr', kind: 'permission', status: 'open', at: '2026-09-21T08:10:00Z' },
      ],
    },
    {
      n: 6, employee: 27, unit: 'AG-CNE', type: 'annual', start: '2026-10-25', end: '2026-10-29', days: 5,
      requestedBy: admin, subjectUser: null, at: '2026-09-23T14:00:00Z', status: 'pending', definition: 'leave.manager_then_hr',
      tasks: [
        { step: 'manager', kind: 'none', status: 'skipped', outcome: 'escalated', at: '2026-09-23T14:00:00Z', comment: 'manager-not-linked' },
        { step: 'hr', kind: 'permission', status: 'open', at: '2026-09-23T14:00:00Z' },
      ],
    },
    {
      n: 7, employee: 29, unit: 'AG-ANNABA', type: 'annual', start: '2026-10-11', end: '2026-10-15', days: 5, reason: 'Affaires familiales',
      requestedBy: chef.userId, subjectUser: chef.userId, at: '2026-09-14T08:00:00Z', status: 'approved', definition: 'leave.manager_then_hr', finishedAt: '2026-09-16T09:30:00Z',
      tasks: [
        // the chef heads his own unit: the manager step goes up to the head of Région Est (Karim)
        { step: 'manager', kind: 'user', user: karim.userId, status: 'done', outcome: 'approve', actedBy: karim.userId, at: '2026-09-14T08:00:00Z', actedAt: '2026-09-15T07:50:00Z' },
        { step: 'hr', kind: 'permission', status: 'done', outcome: 'approve', actedBy: admin, at: '2026-09-15T07:50:00Z', actedAt: '2026-09-16T09:30:00Z' },
      ],
      taken: [{ periodStart: '2025-07-01', days: 5 }],
    },
  ];
}

async function seedDemoRequests(db: Executor, types: ReadonlyMap<string, string>): Promise<number> {
  const definitions = new Map(
    (await db.selectFrom('workflow_definition').select(['id', 'code']).where('company_id', '=', companyId).execute()).map((d) => [d.code, d.id]),
  );
  let created = 0;
  for (const r of demoRequests()) {
    const requestId = fixed(10, r.n);
    const instanceId = fixed(11, r.n);
    const typeId = types.get(r.type);
    const definitionId = definitions.get(r.definition);
    if (!typeId || !definitionId) throw new Error(`demo leave: missing type ${r.type} or definition ${r.definition}`);
    const inserted = await sql`
      insert into leave_request (id, company_id, employment_id, leave_type_id, org_unit_id, start_date, end_date, days, reason, document_ref,
                                 status, requested_by, requested_at)
      values (${requestId}::uuid, ${companyId}::uuid, ${demoEmployment(r.employee)}::uuid, ${typeId}::uuid, ${unitId(r.unit)}::uuid,
              ${r.start}::date, ${r.end}::date, ${r.days}, ${r.reason ?? null}, ${r.documentRef ?? null}, ${r.status},
              ${r.requestedBy}::uuid, ${r.at}::timestamptz)
      on conflict do nothing`.execute(db);
    if (Number(inserted.numAffectedRows ?? 0) === 0) continue;
    created += 1;
    const current = Math.max(0, r.tasks.length - 1);
    await sql`
      insert into workflow_instance (id, company_id, definition_id, subject_type, subject_id, status, current_step, started_by, subject_user_id,
                                     started_at, finished_at)
      values (${instanceId}::uuid, ${companyId}::uuid, ${definitionId}::uuid, 'leave_request', ${requestId}::uuid, ${r.status}, ${current},
              ${r.requestedBy}::uuid, ${r.subjectUser}::uuid, ${r.at}::timestamptz, ${r.finishedAt ?? null}::timestamptz)`.execute(db);
    for (const [k, t] of r.tasks.entries()) {
      await sql`
        insert into workflow_task (id, company_id, instance_id, step_key, step_index, assignee_kind, assignee_user_id, permission, scope_unit_id,
                                   status, outcome, acted_by, acted_at, comment, created_at)
        values (${fixed(12, r.n * 10 + k)}::uuid, ${companyId}::uuid, ${instanceId}::uuid, ${t.step}, ${k}, ${t.kind},
                ${t.kind === 'user' ? (t.user ?? null) : null}::uuid, ${t.kind === 'permission' ? HR : null}, ${unitId(r.unit)}::uuid,
                ${t.status}, ${t.outcome ?? null}, ${t.actedBy ?? null}::uuid, ${t.actedAt ?? null}::timestamptz, ${t.comment ?? null},
                ${t.at}::timestamptz)`.execute(db);
    }
    await sql`update leave_request set workflow_instance_id = ${instanceId}::uuid where id = ${requestId}::uuid`.execute(db);
    for (const [k, t] of (r.taken ?? []).entries()) {
      await sql`
        insert into leave_ledger (id, company_id, employment_id, leave_type_id, period_start, kind, days, request_id, created_by, created_at)
        values (${fixed(13, r.n * 10 + k)}::uuid, ${companyId}::uuid, ${demoEmployment(r.employee)}::uuid, ${typeId}::uuid, ${t.periodStart}::date,
                'taken', ${-t.days}, ${requestId}::uuid, ${r.tasks.at(-1)?.actedBy ?? null}::uuid, ${r.finishedAt ?? r.at}::timestamptz)`.execute(db);
    }
  }
  return created;
}
