/*
 * Demo change requests (docs/contracts/profile-changes.md › Seed) for agent.annaba@demo.dz (EMP-0030, Agence Annaba):
 * one PENDING family request (a new child, with a fake PDF « livret de famille ») at the HR step, one APPLIED contact
 * change (an immediate one) and one REJECTED bank request (with a fake RIB PDF and a rejection comment). chef.annaba has
 * nothing pending.
 *
 *   !!! TEST DATA — fictitious !!!  Names, phones and the RIB are invented.
 *
 * Runs as the MIGRATOR (owner, BYPASSRLS) after seedDemoPersonal and seedProfileDefaults: company_id is explicit.
 * Idempotent (fixed ids, `on conflict do nothing`, skipped once the first request exists).
 */
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { demoPdf } from '../../documents/index.js';
import { DEMO_USERS } from '../../identity/index.js';
import { LEAVE_DEMO } from '../../leave/index.js';
import { DEMO_COMPANY_ID, DEMO_ORGANIZATION, toIsoDate } from '../../organization/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

const fixed = (n: number) => `0190a5d0-0000-7000-8000-${String(900_000 + n).padStart(12, '0')}`;

export const DEMO_PROFILE_REQUESTS = {
  pendingFamily: fixed(1),
  appliedContact: fixed(2),
  rejectedBank: fixed(3),
} as const;

function unitId(code: string): string {
  const unit = DEMO_ORGANIZATION.units.find((u) => u.code === code);
  if (!unit) throw new Error(`profile seed: unit ${code}`);
  return unit.id;
}

// pg returns a `date` as a Date at local midnight: take its local calendar day (toISOString() is a day early east of UTC).
const day = (d: unknown) => (d instanceof Date ? toIsoDate(d) : String(d));

/** → how many requests were created (0 when already seeded). */
export async function seedDemoProfileRequests(db: Executor, companyId: string = DEMO_COMPANY_ID): Promise<number> {
  const { employmentId, userId } = LEAVE_DEMO.agent;
  const admin = DEMO_USERS.find((u) => u.email === 'rh.admin@demo.dz')?.id ?? '';
  const employment = await db.selectFrom('employment').select('person_id').where('company_id', '=', companyId).where('id', '=', employmentId).executeTakeFirst();
  if (!employment) return 0;
  const personId = employment.person_id;
  const exists = await db.selectFrom('profile_change_request').select('id').where('company_id', '=', companyId).where('id', '=', DEMO_PROFILE_REQUESTS.pendingFamily).executeTakeFirst();
  if (exists) return 0;
  const definitions = new Map(
    (await db.selectFrom('workflow_definition').select(['id', 'code']).where('company_id', '=', companyId).where('code', 'in', ['profile.hr', 'profile.bank']).execute()).map((d) => [d.code, d.id]),
  );
  const hr = definitions.get('profile.hr');
  const bank = definitions.get('profile.bank');
  if (!hr || !bank) throw new Error('profile seed: workflow definitions profile.hr / profile.bank missing (seedProfileDefaults first)');

  // the current values (seedDemoPersonal)
  const contact = await db.selectFrom('person_contact').selectAll().where('company_id', '=', companyId).where('person_id', '=', personId).executeTakeFirst();
  const family = await db.selectFrom('person_family').selectAll().where('company_id', '=', companyId).where('person_id', '=', personId).executeTakeFirst();
  const children = await db.selectFrom('person_child').selectAll().where('company_id', '=', companyId).where('person_id', '=', personId).orderBy('birth_date').execute();
  const sensitive = await db.selectFrom('person_sensitive').select(['rib', 'bank_name']).where('company_id', '=', companyId).where('person_id', '=', personId).executeTakeFirst();

  const contactNow = {
    mobilePhone: contact?.mobile_phone ?? '+213555300030',
    otherPhone: contact?.other_phone ?? null,
    personalEmail: contact?.personal_email ?? null,
    addressLine: contact?.address_line ?? null,
    commune: contact?.commune ?? null,
    wilayaCode: contact?.wilaya_code ?? null,
    postalCode: contact?.postal_code ?? null,
  };
  const familyNow = {
    maritalStatus: (family?.marital_status ?? null) as string | null,
    maritalStatusSince: family?.marital_status_since ? day(family.marital_status_since) : null,
    spouseEmployed: (family?.spouse_employed ?? null) as string | null,
    children: children.map((c) => ({ id: c.id, firstName: c.first_name, birthDate: day(c.birth_date), sex: c.sex, dependent: c.dependent })),
  };
  const annaba = unitId('AG-ANNABA');

  const insertRequest = async (r: { id: string; section: string; status: string; payload: unknown; before: unknown; comment: string | null; at: string; decidedAt: string | null }) => {
    await sql`
      insert into profile_change_request (id, company_id, employment_id, person_id, section, status, payload, before, employee_comment, requested_by, requested_at, decided_at)
      values (${r.id}::uuid, ${companyId}::uuid, ${employmentId}::uuid, ${personId}::uuid, ${r.section}, ${r.status}, ${JSON.stringify(r.payload)}::jsonb,
              ${r.before === null ? null : JSON.stringify(r.before)}::jsonb, ${r.comment}, ${userId}::uuid, ${r.at}::timestamptz, ${r.decidedAt}::timestamptz)
      on conflict do nothing`.execute(db);
  };
  const insertFile = async (requestId: string, name: string, text: string) => {
    const content = demoPdf(text);
    await sql`
      insert into profile_change_file (company_id, request_id, original_filename, mime, size_bytes, sha256, content)
      values (${companyId}::uuid, ${requestId}::uuid, ${name}, 'application/pdf', ${content.length}, ${createHash('sha256').update(content).digest()}, ${content})`.execute(db);
  };

  // 1. an applied (immediate) contact change: a new mobile number
  await insertRequest({
    id: DEMO_PROFILE_REQUESTS.appliedContact,
    section: 'contact',
    status: 'applied',
    payload: contactNow,
    before: { ...contactNow, mobilePhone: '+213555300099' },
    comment: null,
    at: '2026-09-02T08:15:00Z',
    decidedAt: '2026-09-02T08:15:00Z',
  });

  // 2. a rejected bank request (central HR: the RIB document was unreadable)
  const bankInstance = fixed(31);
  await insertRequest({
    id: DEMO_PROFILE_REQUESTS.rejectedBank,
    section: 'bank',
    status: 'rejected',
    payload: { rib: '00799999000300300030', bankName: 'CPA' },
    before: { rib: sensitive?.rib ?? null, bankName: sensitive?.bank_name ?? null },
    comment: 'Nouveau compte à la CPA.',
    at: '2026-09-10T10:00:00Z',
    decidedAt: '2026-09-11T09:30:00Z',
  });
  await insertFile(DEMO_PROFILE_REQUESTS.rejectedBank, 'rib-cpa.pdf', 'RIB CPA - DONNEES FICTIVES');
  await sql`
    insert into workflow_instance (id, company_id, definition_id, subject_type, subject_id, status, current_step, started_by, subject_user_id, started_at, finished_at)
    values (${bankInstance}::uuid, ${companyId}::uuid, ${bank}::uuid, 'profile_change_request', ${DEMO_PROFILE_REQUESTS.rejectedBank}::uuid, 'rejected', 0,
            ${userId}::uuid, ${userId}::uuid, '2026-09-10T10:00:00Z', '2026-09-11T09:30:00Z')`.execute(db);
  await sql`
    insert into workflow_task (id, company_id, instance_id, step_key, step_index, assignee_kind, permission, scope_unit_id, status, outcome, acted_by, acted_at, comment, created_at)
    values (${fixed(32)}::uuid, ${companyId}::uuid, ${bankInstance}::uuid, 'hr', 0, 'permission', 'employee.bank.update', ${annaba}::uuid, 'done', 'reject',
            ${admin}::uuid, '2026-09-11T09:30:00Z', 'Le RIB joint est illisible : merci de joindre un RIB signé par la banque.', '2026-09-10T10:00:00Z')`.execute(db);
  await sql`update profile_change_request set workflow_instance_id = ${bankInstance}::uuid where id = ${DEMO_PROFILE_REQUESTS.rejectedBank}::uuid`.execute(db);

  // 3. a pending family request: a new child (born last month), with the livret de famille
  const familyInstance = fixed(11);
  await insertRequest({
    id: DEMO_PROFILE_REQUESTS.pendingFamily,
    section: 'family',
    status: 'pending',
    payload: { ...familyNow, children: [...familyNow.children, { firstName: 'Nour', birthDate: '2026-09-18', sex: 'F', dependent: true }] },
    before: familyNow,
    comment: 'Naissance de notre fille.',
    at: '2026-10-20T07:45:00Z',
    decidedAt: null,
  });
  await insertFile(DEMO_PROFILE_REQUESTS.pendingFamily, 'livret-de-famille.pdf', 'LIVRET DE FAMILLE - DONNEES FICTIVES');
  await sql`
    insert into workflow_instance (id, company_id, definition_id, subject_type, subject_id, status, current_step, started_by, subject_user_id, started_at)
    values (${familyInstance}::uuid, ${companyId}::uuid, ${hr}::uuid, 'profile_change_request', ${DEMO_PROFILE_REQUESTS.pendingFamily}::uuid, 'pending', 0,
            ${userId}::uuid, ${userId}::uuid, '2026-10-20T07:45:00Z')`.execute(db);
  await sql`
    insert into workflow_task (id, company_id, instance_id, step_key, step_index, assignee_kind, permission, scope_unit_id, created_at)
    values (${fixed(12)}::uuid, ${companyId}::uuid, ${familyInstance}::uuid, 'hr', 0, 'permission', 'employee.personal.update', ${annaba}::uuid, '2026-10-20T07:45:00Z')`.execute(db);
  await sql`update profile_change_request set workflow_instance_id = ${familyInstance}::uuid where id = ${DEMO_PROFILE_REQUESTS.pendingFamily}::uuid`.execute(db);
  return 3;
}
