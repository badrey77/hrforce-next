/*
 * Recruitment defaults of a company (bootstrap, seed:dev, e2e fixtures) and the DEMO recruitment data (seed:dev) —
 * docs/contracts/recruitment.md › Seed. TEST DATA: every candidate is fictitious. Runs as the MIGRATOR (owner,
 * BYPASSRLS): company_id written explicitly. Deterministic and idempotent: fixed ids, `on conflict do nothing`; the
 * rows of an opening / a candidate / an application are written only when that row itself was inserted.
 */
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { demoLogoPng, demoPdf } from '../../documents/index.js';
import { demoEmployees } from '../../employment/index.js';
import { DEMO_USERS } from '../../identity/index.js';
import { LEAVE_DEMO } from '../../leave/index.js';
import { DEMO_ORGANIZATION } from '../../organization/index.js';
import { seedWorkflowDefinitions, type SeedDefinition } from '../../workflow/index.js';
import { isFinalStage, phoneKey, type AutoCause, type ContractType, type FileKind, type OpeningStatus, type Source, type Stage } from '../domain/rules.js';

type Executor = Kysely<DB> | Transaction<DB>;

// ── defaults (every company) ────────────────────────────────────────────────────────────────────────────────────

const HR_STEP = { key: 'hr', kind: 'permission' as const, permission: 'recruitment.approve_opening', labels: { fr: 'RH', ar: 'الموارد البشرية', en: 'HR' } };

/** The approval chains of an opening request (migration 0019 did existing companies). */
export const RECRUITMENT_DEFINITIONS: readonly SeedDefinition[] = [
  {
    code: 'recruitment.manager_then_hr',
    names: { fr: 'Responsable puis RH', ar: 'المسؤول المباشر ثم الموارد البشرية', en: 'Manager then HR' },
    steps: [{ key: 'manager', kind: 'manager', labels: { fr: 'Responsable', ar: 'المسؤول المباشر', en: 'Manager' } }, HR_STEP],
  },
  { code: 'recruitment.hr_only', names: { fr: 'RH uniquement', ar: 'الموارد البشرية فقط', en: 'HR only' }, steps: [HR_STEP] },
];

/** The seeded rejection reasons of every company; the two `autoOnly` ones are set by the system only. */
export const SYSTEM_REJECTION_REASONS: readonly { code: string; names: { fr: string; ar: string; en: string }; sortOrder: number; autoOnly: boolean }[] = [
  { code: 'profile_mismatch', names: { fr: 'Profil ne correspondant pas au poste', ar: 'عدم توافق المؤهلات مع المنصب', en: 'Profile does not match the position' }, sortOrder: 10, autoOnly: false },
  { code: 'experience', names: { fr: 'Expérience insuffisante', ar: 'خبرة غير كافية', en: 'Insufficient experience' }, sortOrder: 20, autoOnly: false },
  { code: 'qualification', names: { fr: 'Diplôme ou qualification requis non détenu', ar: 'عدم حيازة الشهادة أو التأهيل المطلوب', en: 'Required degree or qualification not held' }, sortOrder: 30, autoOnly: false },
  { code: 'salary', names: { fr: 'Prétentions salariales', ar: 'المطالب المتعلقة بالأجر', en: 'Salary expectations' }, sortOrder: 40, autoOnly: false },
  { code: 'other_selected', names: { fr: 'Autre candidature retenue', ar: 'تم اختيار ترشح آخر', en: 'Another application selected' }, sortOrder: 50, autoOnly: false },
  { code: 'no_show', names: { fr: "Absence à l'entretien", ar: 'الغياب عن المقابلة', en: 'Did not attend the interview' }, sortOrder: 60, autoOnly: false },
  { code: 'incomplete', names: { fr: 'Dossier incomplet', ar: 'ملف ناقص', en: 'Incomplete file' }, sortOrder: 70, autoOnly: false },
  { code: 'other', names: { fr: 'Autre', ar: 'سبب آخر', en: 'Other' }, sortOrder: 80, autoOnly: false },
  { code: 'position_filled', names: { fr: 'Poste pourvu', ar: 'تم شغل المنصب', en: 'Position filled' }, sortOrder: 900, autoOnly: true },
  { code: 'opening_closed', names: { fr: 'Recrutement clôturé', ar: 'تم إغلاق عملية التوظيف', en: 'Recruitment closed' }, sortOrder: 910, autoOnly: true },
];

/**
 * The policy row, the two approval chains and the rejection reasons (the same defaults migration 0019 gave existing
 * companies). The system employee-file category `recruitment` comes with seedDocumentDefaults (SYSTEM_FILE_CATEGORIES).
 */
export async function seedRecruitmentDefaults(db: Executor, companyId: string): Promise<void> {
  await seedWorkflowDefinitions(db, companyId, RECRUITMENT_DEFINITIONS);
  await sql`insert into recruitment_policy (company_id) values (${companyId}::uuid) on conflict do nothing`.execute(db);
  for (const r of SYSTEM_REJECTION_REASONS) {
    await sql`
      insert into recruitment_rejection_reason (company_id, code, name_fr, name_ar, name_en, sort_order, is_system, auto_only)
      values (${companyId}::uuid, ${r.code}, ${r.names.fr}, ${r.names.ar}, ${r.names.en}, ${r.sortOrder}, true, ${r.autoOnly})
      on conflict (company_id, code) do nothing`.execute(db);
  }
}

// ── generic seeding (demo data and e2e fixtures) ────────────────────────────────────────────────────────────────

export interface SeedOpeningTask {
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

export interface SeedOpening {
  id: string;
  reference: string;
  title: string;
  orgUnitId: string;
  contractType: ContractType;
  posts: number;
  hiredCount?: number;
  justification: string;
  targetDate: string;
  anemReference?: string;
  status: OpeningStatus;
  requestedBy: string;
  requestedAt: string;
  openedAt?: string;
  closed?: { at: string; by: string | null; reason: string | null };
  /** absent: an opening recorded without an approval history */
  workflow?: { instanceId: string; definition: string; finishedAt?: string; tasks: SeedOpeningTask[] };
}

export interface SeedCandidateFile {
  id: string;
  kind: FileKind;
  title: string;
  originalFilename: string;
  mime: 'application/pdf' | 'image/png';
  content: Buffer;
}

export interface SeedCandidate {
  id: string;
  lastName: string;
  firstName: string;
  lastNameAr?: string | null;
  firstNameAr?: string | null;
  birthDate?: string | null;
  birthPlace?: string | null;
  sex?: 'M' | 'F' | null;
  nin?: string | null;
  email?: string | null;
  phone?: string | null;
  personId?: string | null;
  informedOn?: string | null;
  createdBy: string;
  createdAt: string;
  files?: SeedCandidateFile[];
}

export interface SeedTransition {
  to: Stage;
  at: string;
  by: string | null;
  /** a rejection's reason code */
  reason?: string;
  comment?: string;
  autoCause?: AutoCause;
}

export interface SeedApplication {
  id: string;
  openingId: string;
  /** null: an application already purged (the anonymous count) — `purgedAt` is then required */
  candidateId: string | null;
  source: Source;
  createdBy: string;
  /** the first one is the creation (to `received`) */
  transitions: SeedTransition[];
  expectedSalary?: string;
  notes?: { id: string; body: string; by: string; at: string }[];
  employmentId?: string;
  purgedAt?: string;
}

export interface SeedRecruitment {
  openings: readonly SeedOpening[];
  candidates: readonly SeedCandidate[];
  applications: readonly SeedApplication[];
}

/** A deterministic uuid for the n-th child row (stage, note) of a seeded parent. */
function childId(parentId: string, kind: string, n: number): string {
  const h = createHash('sha256').update(`${parentId}:${kind}:${n}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Inserts openings (with their approval history), candidates (with their files) and applications of one company. */
export async function seedRecruitment(db: Executor, companyId: string, data: SeedRecruitment): Promise<{ openings: number; candidates: number; applications: number }> {
  const definitions = new Map((await db.selectFrom('workflow_definition').select(['id', 'code']).where('company_id', '=', companyId).execute()).map((d) => [d.code, d.id]));
  const reasons = new Map((await db.selectFrom('recruitment_rejection_reason').select(['id', 'code']).where('company_id', '=', companyId).execute()).map((r) => [r.code, r.id]));
  const created = { openings: 0, candidates: 0, applications: 0 };

  for (const o of data.openings) {
    const inserted = await sql`
      insert into recruitment_opening (id, company_id, reference, title, org_unit_id, contract_type, posts, hired_count, justification, target_date,
                                       anem_reference, status, requested_by, requested_at, opened_at, closed_at, closed_by, close_reason)
      values (${o.id}::uuid, ${companyId}::uuid, ${o.reference}, ${o.title}, ${o.orgUnitId}::uuid, ${o.contractType}, ${o.posts}, ${o.hiredCount ?? 0},
              ${o.justification}, ${o.targetDate}::date, ${o.anemReference ?? null}, ${o.status}, ${o.requestedBy}::uuid, ${o.requestedAt}::timestamptz,
              ${o.openedAt ?? null}::timestamptz, ${o.closed?.at ?? null}::timestamptz, ${o.closed?.by ?? null}::uuid, ${o.closed?.reason ?? null})
      on conflict do nothing`.execute(db);
    if (Number(inserted.numAffectedRows ?? 0) === 0) continue;
    created.openings += 1;
    // the counter never goes back: a later request of that year takes the next number
    const [, year, seq] = /^REC-(\d{4})-(\d+)$/.exec(o.reference) ?? [];
    if (year && seq) {
      await sql`
        insert into recruitment_opening_sequence (company_id, year, last_value) values (${companyId}::uuid, ${Number(year)}, ${Number(seq)})
        on conflict (company_id, year) do update set last_value = greatest(recruitment_opening_sequence.last_value, excluded.last_value)`.execute(db);
    }
    if (!o.workflow) continue;
    const definitionId = definitions.get(o.workflow.definition);
    if (!definitionId) throw new Error(`recruitment seed: workflow definition ${o.workflow.definition} missing (seed the defaults first)`);
    const status = o.status === 'pending' || o.status === 'rejected' || o.status === 'cancelled' ? o.status : 'approved';
    await sql`
      insert into workflow_instance (id, company_id, definition_id, subject_type, subject_id, status, current_step, started_by, started_at, finished_at)
      values (${o.workflow.instanceId}::uuid, ${companyId}::uuid, ${definitionId}::uuid, 'recruitment_opening', ${o.id}::uuid, ${status},
              ${Math.max(0, o.workflow.tasks.length - 1)}, ${o.requestedBy}::uuid, ${o.requestedAt}::timestamptz, ${o.workflow.finishedAt ?? null}::timestamptz)`.execute(db);
    for (const [k, t] of o.workflow.tasks.entries()) {
      await sql`
        insert into workflow_task (id, company_id, instance_id, step_key, step_index, assignee_kind, assignee_user_id, permission, scope_unit_id,
                                   status, outcome, acted_by, acted_at, comment, created_at)
        values (${childId(o.workflow.instanceId, 'task', k)}::uuid, ${companyId}::uuid, ${o.workflow.instanceId}::uuid, ${t.step}, ${k}, ${t.kind},
                ${t.kind === 'user' ? (t.user ?? null) : null}::uuid, ${t.kind === 'permission' ? HR_STEP.permission : null}, ${o.orgUnitId}::uuid,
                ${t.status}, ${t.outcome ?? null}, ${t.actedBy ?? null}::uuid, ${t.actedAt ?? null}::timestamptz, ${t.comment ?? null}, ${t.at}::timestamptz)`.execute(db);
    }
    await sql`update recruitment_opening set workflow_instance_id = ${o.workflow.instanceId}::uuid where id = ${o.id}::uuid`.execute(db);
  }

  for (const c of data.candidates) {
    const inserted = await sql`
      insert into recruitment_candidate (id, company_id, last_name, first_name, last_name_ar, first_name_ar, birth_date, birth_place, sex, nin, email,
                                         phone, phone_key, person_id, informed_on, created_by, created_at)
      values (${c.id}::uuid, ${companyId}::uuid, ${c.lastName}, ${c.firstName}, ${c.lastNameAr ?? null}, ${c.firstNameAr ?? null}, ${c.birthDate ?? null}::date,
              ${c.birthPlace ?? null}, ${c.sex ?? null}, ${c.nin ?? null}, ${c.email ?? null}, ${c.phone ?? null}, ${phoneKey(c.phone)},
              ${c.personId ?? null}::uuid, ${c.informedOn ?? null}::date, ${c.createdBy}::uuid, ${c.createdAt}::timestamptz)
      on conflict do nothing`.execute(db);
    if (Number(inserted.numAffectedRows ?? 0) === 0) continue;
    created.candidates += 1;
    for (const f of c.files ?? []) {
      await sql`
        insert into recruitment_candidate_file (id, company_id, candidate_id, kind, title, original_filename, mime, size_bytes, sha256, uploaded_by, uploaded_at)
        values (${f.id}::uuid, ${companyId}::uuid, ${c.id}::uuid, ${f.kind}, ${f.title}, ${f.originalFilename}, ${f.mime}, ${f.content.length},
                ${createHash('sha256').update(f.content).digest()}, ${c.createdBy}::uuid, ${c.createdAt}::timestamptz)`.execute(db);
      await sql`insert into recruitment_candidate_file_content (file_id, company_id, content) values (${f.id}::uuid, ${companyId}::uuid, ${f.content})`.execute(db);
    }
  }

  for (const a of data.applications) {
    const last = a.transitions.at(-1);
    const first = a.transitions[0];
    if (!last || !first) throw new Error(`recruitment seed: application ${a.id} has no transition`);
    const inserted = await sql`
      insert into recruitment_application (id, company_id, opening_id, candidate_id, source, stage, stage_since, decided_at, employment_id, created_by,
                                           created_at, purged_at)
      values (${a.id}::uuid, ${companyId}::uuid, ${a.openingId}::uuid, ${a.candidateId}::uuid, ${a.source}, ${last.to}, ${last.at}::timestamptz,
              ${isFinalStage(last.to) ? last.at : null}::timestamptz, ${a.employmentId ?? null}::uuid, ${a.createdBy}::uuid, ${first.at}::timestamptz,
              ${a.purgedAt ?? null}::timestamptz)
      on conflict do nothing`.execute(db);
    if (Number(inserted.numAffectedRows ?? 0) === 0) continue;
    created.applications += 1;
    let from: Stage | null = null;
    for (const [k, t] of a.transitions.entries()) {
      const reasonId = t.reason ? reasons.get(t.reason) : undefined;
      if (t.reason && !reasonId) throw new Error(`recruitment seed: rejection reason ${t.reason} missing (seed the defaults first)`);
      await sql`
        insert into recruitment_application_stage (id, company_id, application_id, from_stage, to_stage, rejection_reason_id, comment, auto_cause, moved_by, moved_at)
        values (${childId(a.id, 'stage', k)}::uuid, ${companyId}::uuid, ${a.id}::uuid, ${from}, ${t.to}, ${reasonId ?? null}::uuid,
                ${a.purgedAt ? null : (t.comment ?? null)}, ${t.autoCause ?? null}, ${t.by}::uuid, ${t.at}::timestamptz)`.execute(db);
      from = t.to;
    }
    if (a.purgedAt) continue;
    if (a.expectedSalary) {
      await sql`
        insert into recruitment_application_salary (application_id, company_id, expected_salary)
        values (${a.id}::uuid, ${companyId}::uuid, ${a.expectedSalary}::numeric)`.execute(db);
    }
    for (const n of a.notes ?? []) {
      await sql`
        insert into recruitment_note (id, company_id, application_id, body, created_by, created_at)
        values (${n.id}::uuid, ${companyId}::uuid, ${a.id}::uuid, ${n.body}, ${n.by}::uuid, ${n.at}::timestamptz)`.execute(db);
    }
  }
  return created;
}

// ── DEMO (docs/contracts/recruitment.md › Seed) ─────────────────────────────────────────────────────────────────

const fixed = (kind: number, n: number) => `0190a5d0-0000-7000-9b0${kind}-${n.toString(16).padStart(12, '0')}`;
const DEMO = DEMO_ORGANIZATION.company.id;
const DAY_MS = 86_400_000;

function unitId(code: string): string {
  const unit = DEMO_ORGANIZATION.units.find((u) => u.code === code);
  if (!unit) throw new Error(`recruitment seed: unknown unit ${code}`);
  return unit.id;
}

function user(email: string): string {
  const found = DEMO_USERS.find((u) => u.email === email);
  if (!found) throw new Error(`recruitment seed: unknown user ${email}`);
  return found.id;
}

/** Fixed ids of the demo openings. */
export const DEMO_OPENINGS = {
  /** REC-2026-0001, Agence Annaba, open, seven applications */
  annaba: fixed(1, 1),
  /** REC-2026-0002, Service Clientèle (Annaba), pending at the manager step (rh.est) */
  accueil: fixed(1, 2),
  /** REC-2026-0003, Agence Constantine, filled */
  cne: fixed(1, 3),
  /** REC-2026-0004, Agence Oran, closed */
  oranClosed: fixed(1, 4),
  /** REC-2026-0005, Agence Annaba, rejected at the HR step */
  chauffeur: fixed(1, 5),
  /** REC-2026-0006, Agence Oran, open */
  oran: fixed(1, 6),
  /** REC-2025-0001, Agence Tlemcen, closed 14 months ago, three purged applications */
  tlemcen: fixed(1, 7),
} as const;

/** Fixed ids of the demo candidates: 1–7 on REC-2026-0001, 8–10 on 0003, 11–12 on 0004 (11 also on 0006), 13–14 on 0006. */
export const demoCandidate = (n: number): string => fixed(2, n);
/** Fixed ids of the demo applications (same numbering as the candidates; 15 = candidate 11 on 0006; 21–23 purged). */
export const demoApplication = (n: number): string => fixed(3, n);
export const demoCandidateFile = (n: number): string => fixed(4, n);

/** TEST DATA — fictitious people (names from a hat, NIN "…99…" test marker, example.test addresses). */
const PEOPLE: readonly [last: string, first: string, lastAr: string, firstAr: string, sex: 'M' | 'F', year: number][] = [
  ['Saadi', 'Nour', 'سعدي', 'نور', 'F', 1996],
  ['Mekki', 'Ilyes', 'مكي', 'إلياس', 'M', 1994],
  ['Rahmani', 'Sabrina', 'رحماني', 'صبرينة', 'F', 1992],
  ['', '', '', '', 'M', 0], // 4: the former employee (identity of the demo person)
  ['Ferhat', 'Walid', 'فرحات', 'وليد', 'M', 1990],
  ['Ghezali', 'Imane', 'غزالي', 'إيمان', 'F', 1999],
  ['Bouras', 'Hakim', 'بوراس', 'حكيم', 'M', 1988],
  ['', '', '', '', 'M', 0], // 8: the hired candidate (identity of the demo employee)
  ['Tebbal', 'Meriem', 'طبال', 'مريم', 'F', 1995],
  ['Laouar', 'Sofiane', 'لعور', 'سفيان', 'M', 1993],
  ['Hamdi', 'Yasmine', 'حمدي', 'ياسمين', 'F', 1997],
  ['Kebir', 'Anis', 'كبير', 'أنيس', 'M', 1991],
  ['Zerrouki', 'Lamia', 'زروقي', 'لمياء', 'F', 1998],
  ['Belaid', 'Rachid', 'بلعيد', 'رشيد', 'M', 1989],
];

/**
 * The DEMO data: openings in every status with their approval history, fictitious candidates across the stages with
 * a small generated CV, an already purged opening (the anonymous counts). Instants are relative to `nowMs`.
 */
export function demoRecruitment(nowMs: number): SeedRecruitment {
  const at = (daysAgo: number, hour = 9) => new Date(Math.floor(nowMs / DAY_MS) * DAY_MS - daysAgo * DAY_MS + hour * 3_600_000).toISOString();
  const date = (daysAhead: number) => new Date(nowMs + daysAhead * DAY_MS).toISOString().slice(0, 10);
  const admin = user('rh.admin@demo.dz');
  const karim = user('rh.est@demo.dz');
  const chef = LEAVE_DEMO.chef.userId;
  const employees = demoEmployees();
  /** EMP-0025: Agence Constantine, resigned 2026-06-30, not rehired */
  const former = employees[24];
  /** EMP-0028: an active employee of Agence Constantine — the person REC-2026-0003 hired */
  const hired = employees[27];
  if (!former || !hired) throw new Error('recruitment seed: demo employees missing');

  const openings: SeedOpening[] = [
    {
      id: DEMO_OPENINGS.annaba, reference: 'REC-2026-0001', title: 'Chargé(e) de clientèle', orgUnitId: unitId('AG-ANNABA'), contractType: 'cdi', posts: 2,
      justification: 'Deux départs à la retraite prévus au guichet ; maintien des horaires d’ouverture.', targetDate: date(45), anemReference: 'ANEM-23-2026-0417',
      status: 'open', requestedBy: chef, requestedAt: at(40), openedAt: at(37, 11),
      workflow: {
        instanceId: fixed(5, 1), definition: 'recruitment.manager_then_hr', finishedAt: at(37, 11),
        tasks: [
          // the chef heads the unit himself: the manager step goes to the head above (Région Est, rh.est)
          { step: 'manager', kind: 'user', user: karim, status: 'done', outcome: 'approve', actedBy: karim, at: at(40), actedAt: at(39, 10) },
          { step: 'hr', kind: 'permission', status: 'done', outcome: 'approve', actedBy: admin, at: at(39, 10), actedAt: at(37, 11), comment: 'Budget confirmé.' },
        ],
      },
    },
    {
      id: DEMO_OPENINGS.accueil, reference: 'REC-2026-0002', title: 'Agent d’accueil', orgUnitId: unitId('SRV-CLI-ANB'), contractType: 'cdd', posts: 1,
      justification: 'Renfort saisonnier de l’accueil pendant la campagne de fin d’année.', targetDate: date(30),
      status: 'pending', requestedBy: chef, requestedAt: at(2),
      workflow: { instanceId: fixed(5, 2), definition: 'recruitment.manager_then_hr', tasks: [{ step: 'manager', kind: 'user', user: karim, status: 'open', at: at(2) }] },
    },
    {
      id: DEMO_OPENINGS.cne, reference: 'REC-2026-0003', title: 'Technicien réseau', orgUnitId: unitId('AG-CNE'), contractType: 'cdi', posts: 1, hiredCount: 1,
      justification: 'Remplacement du technicien de l’agence après une mobilité interne.', targetDate: date(-20),
      status: 'filled', requestedBy: karim, requestedAt: at(110), openedAt: at(108, 14), closed: { at: at(25, 15), by: null, reason: null },
      workflow: {
        instanceId: fixed(5, 3), definition: 'recruitment.manager_then_hr', finishedAt: at(108, 14),
        tasks: [
          // the head of Agence Constantine has no account: the step is skipped
          { step: 'manager', kind: 'none', status: 'skipped', outcome: 'escalated', at: at(110), comment: 'manager-not-linked' },
          { step: 'hr', kind: 'permission', status: 'done', outcome: 'approve', actedBy: admin, at: at(110), actedAt: at(108, 14) },
        ],
      },
    },
    {
      // the Région Ouest openings were recorded by central HR directly (no approval history)
      id: DEMO_OPENINGS.oranClosed, reference: 'REC-2026-0004', title: 'Assistant(e) administratif(ve)', orgUnitId: unitId('AG-ORAN'), contractType: 'cdd', posts: 1,
      justification: 'Surcroît d’activité du secrétariat de l’agence.', targetDate: date(-5),
      status: 'closed', requestedBy: admin, requestedAt: at(70), openedAt: at(70), closed: { at: at(12, 16), by: admin, reason: 'Budget reporté' },
    },
    {
      id: DEMO_OPENINGS.chauffeur, reference: 'REC-2026-0005', title: 'Chauffeur', orgUnitId: unitId('AG-ANNABA'), contractType: 'cdd', posts: 1,
      justification: 'Mise à disposition d’un second véhicule de service.', targetDate: date(60),
      status: 'rejected', requestedBy: chef, requestedAt: at(18),
      workflow: {
        instanceId: fixed(5, 5), definition: 'recruitment.manager_then_hr', finishedAt: at(15, 10),
        tasks: [
          { step: 'manager', kind: 'user', user: karim, status: 'done', outcome: 'approve', actedBy: karim, at: at(18), actedAt: at(17, 9) },
          { step: 'hr', kind: 'permission', status: 'done', outcome: 'reject', actedBy: admin, at: at(17, 9), actedAt: at(15, 10), comment: 'Poste non budgétisé cette année' },
        ],
      },
    },
    {
      id: DEMO_OPENINGS.oran, reference: 'REC-2026-0006', title: 'Conseiller(ère) commercial(e)', orgUnitId: unitId('AG-ORAN'), contractType: 'cdi', posts: 1,
      justification: 'Ouverture d’un portefeuille professionnels à l’agence.', targetDate: date(50),
      status: 'open', requestedBy: admin, requestedAt: at(20), openedAt: at(20),
    },
    {
      id: DEMO_OPENINGS.tlemcen, reference: 'REC-2025-0001', title: 'Agent commercial', orgUnitId: unitId('AG-TLEMCEN'), contractType: 'cdi', posts: 1,
      justification: 'Développement de la clientèle de l’agence.', targetDate: new Date(nowMs - 420 * DAY_MS).toISOString().slice(0, 10),
      status: 'closed', requestedBy: admin, requestedAt: at(470), openedAt: at(470), closed: { at: at(425, 10), by: admin, reason: 'Recrutement abandonné' },
    },
  ];

  const person = (n: number, createdBy: string, createdAt: string, extra: Partial<SeedCandidate> = {}): SeedCandidate => {
    const [lastName, firstName, lastNameAr, firstNameAr, sex, year] = PEOPLE[n - 1] ?? ['Test', 'Candidat', '', '', 'M', 1990];
    return {
      id: demoCandidate(n),
      lastName,
      firstName,
      lastNameAr: lastNameAr || null,
      firstNameAr: firstNameAr || null,
      sex,
      birthDate: `${year}-${String((n % 12) + 1).padStart(2, '0')}-${String((n * 3) % 28 || 1).padStart(2, '0')}`,
      birthPlace: 'Annaba',
      // TEST DATA — fictitious: the employees' pattern with a 9-prefixed sequence, so it equals no person's NIN
      nin: `${sex === 'M' ? 1 : 2}${String(year).slice(2)}99${String(9_000_000_000_000 + n)}`,
      email: `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.test',
      phone: `0550 00 00 ${String(n).padStart(2, '0')}`,
      informedOn: createdAt.slice(0, 10),
      createdBy,
      createdAt,
      files: [
        { id: demoCandidateFile(n), kind: 'cv', title: 'CV', originalFilename: `cv-${n}.pdf`, mime: 'application/pdf', content: demoPdf(`TEST DATA - CV candidat ${n}`) },
      ],
      ...extra,
    };
  };
  const personOf = (e: (typeof employees)[number]) => ({
    lastName: e.lastName,
    firstName: e.firstName,
    lastNameAr: e.lastNameAr,
    firstNameAr: e.firstNameAr,
    sex: e.sex,
    birthDate: e.birthDate,
    birthPlace: e.birthPlace,
    nin: e.nin,
    personId: e.personId,
  });

  const candidates: SeedCandidate[] = [
    person(1, karim, at(35)),
    // a NIN equal to no person, no e-mail
    person(2, karim, at(33), { email: null }),
    person(3, karim, at(32)),
    // the former employee: the person of EMP-0025 (ended, not rehired), linked by HR
    person(4, karim, at(30), { ...personOf(former), email: 'ancien.salarie@example.test' }),
    person(5, karim, at(30), {
      files: [
        { id: demoCandidateFile(5), kind: 'cv', title: 'CV', originalFilename: 'cv-5.pdf', mime: 'application/pdf', content: demoPdf('TEST DATA - CV candidat 5') },
        { id: demoCandidateFile(105), kind: 'diploma', title: 'Licence en commerce', originalFilename: 'diplome.png', mime: 'image/png', content: demoLogoPng() },
      ],
    }),
    person(6, karim, at(34)),
    person(7, karim, at(31)),
    person(8, karim, at(100), { ...personOf(hired), email: 'recrute@example.test', birthPlace: hired.birthPlace }),
    person(9, karim, at(98), { birthPlace: 'Constantine' }),
    person(10, karim, at(97), { birthPlace: 'Constantine' }),
    person(11, admin, at(60), { birthPlace: 'Oran' }),
    person(12, admin, at(58), { birthPlace: 'Oran' }),
    person(13, admin, at(15), { birthPlace: 'Oran' }),
    person(14, admin, at(14), { birthPlace: 'Oran' }),
  ];

  const received = (daysAgo: number, by: string): SeedTransition => ({ to: 'received', at: at(daysAgo), by });
  const A = DEMO_OPENINGS.annaba;
  const applications: SeedApplication[] = [
    // REC-2026-0001: 2 received, 1 shortlisted, 2 interview, 1 rejected, 1 withdrawn
    { id: demoApplication(1), openingId: A, candidateId: demoCandidate(1), source: 'anem', createdBy: karim, transitions: [received(35, karim)] },
    { id: demoApplication(2), openingId: A, candidateId: demoCandidate(2), source: 'spontaneous', createdBy: karim, transitions: [received(33, karim)] },
    {
      id: demoApplication(3), openingId: A, candidateId: demoCandidate(3), source: 'referral', createdBy: karim, expectedSalary: '68000.00',
      transitions: [received(32, karim), { to: 'shortlisted', at: at(26, 10), by: karim }],
      notes: [{ id: fixed(6, 3), body: 'Bon dossier, cinq ans en agence bancaire. À recevoir rapidement.', by: karim, at: at(26, 11) }],
    },
    {
      id: demoApplication(4), openingId: A, candidateId: demoCandidate(4), source: 'internal', createdBy: karim,
      transitions: [received(30, karim), { to: 'shortlisted', at: at(27, 9), by: karim }, { to: 'interview', at: at(20, 14), by: karim }],
      notes: [{ id: fixed(6, 4), body: 'Ancien salarié de l’agence de Constantine : vérifier les conditions de départ.', by: admin, at: at(20, 15) }],
    },
    {
      id: demoApplication(5), openingId: A, candidateId: demoCandidate(5), source: 'job_board', createdBy: karim,
      transitions: [received(30, karim), { to: 'interview', at: at(18, 10), by: karim }],
      notes: [{ id: fixed(6, 5), body: 'Disponible sous un mois.', by: karim, at: at(18, 11) }],
    },
    {
      id: demoApplication(6), openingId: A, candidateId: demoCandidate(6), source: 'anem', createdBy: karim,
      transitions: [received(34, karim), { to: 'rejected', at: at(28, 16), by: karim, reason: 'experience', comment: 'Première expérience, sans pratique du guichet.' }],
    },
    {
      id: demoApplication(7), openingId: A, candidateId: demoCandidate(7), source: 'social', createdBy: karim,
      transitions: [received(31, karim), { to: 'shortlisted', at: at(27, 9), by: karim }, { to: 'withdrawn', at: at(22, 12), by: karim, comment: 'A accepté un autre poste.' }],
    },
    // REC-2026-0003 (filled): one hired, two closed by the fill
    {
      id: demoApplication(8), openingId: DEMO_OPENINGS.cne, candidateId: demoCandidate(8), source: 'anem', createdBy: karim, employmentId: hired.employmentId,
      transitions: [
        received(100, karim), { to: 'shortlisted', at: at(90), by: karim }, { to: 'interview', at: at(70), by: karim },
        { to: 'offer', at: at(40), by: karim }, { to: 'hired', at: at(25, 15), by: karim },
      ],
    },
    {
      id: demoApplication(9), openingId: DEMO_OPENINGS.cne, candidateId: demoCandidate(9), source: 'spontaneous', createdBy: karim,
      transitions: [received(98, karim), { to: 'interview', at: at(68), by: karim }, { to: 'rejected', at: at(25, 15), by: karim, reason: 'position_filled', autoCause: 'opening_filled' }],
    },
    {
      id: demoApplication(10), openingId: DEMO_OPENINGS.cne, candidateId: demoCandidate(10), source: 'job_board', createdBy: karim,
      transitions: [received(97, karim), { to: 'shortlisted', at: at(88), by: karim }, { to: 'rejected', at: at(25, 15), by: karim, reason: 'position_filled', autoCause: 'opening_filled' }],
    },
    // REC-2026-0004 (closed): two closed by the closing
    {
      id: demoApplication(11), openingId: DEMO_OPENINGS.oranClosed, candidateId: demoCandidate(11), source: 'anem', createdBy: admin,
      transitions: [received(60, admin), { to: 'shortlisted', at: at(50), by: admin }, { to: 'rejected', at: at(12, 16), by: admin, reason: 'opening_closed', autoCause: 'opening_closed' }],
    },
    {
      id: demoApplication(12), openingId: DEMO_OPENINGS.oranClosed, candidateId: demoCandidate(12), source: 'spontaneous', createdBy: admin,
      transitions: [received(58, admin), { to: 'rejected', at: at(12, 16), by: admin, reason: 'opening_closed', autoCause: 'opening_closed' }],
    },
    // REC-2026-0006 (open): candidate 11 applied here too
    { id: demoApplication(15), openingId: DEMO_OPENINGS.oran, candidateId: demoCandidate(11), source: 'internal', createdBy: admin, transitions: [received(11, admin)] },
    {
      id: demoApplication(13), openingId: DEMO_OPENINGS.oran, candidateId: demoCandidate(13), source: 'job_board', createdBy: admin,
      transitions: [received(15, admin), { to: 'shortlisted', at: at(9), by: admin }],
    },
    {
      id: demoApplication(14), openingId: DEMO_OPENINGS.oran, candidateId: demoCandidate(14), source: 'referral', createdBy: admin,
      transitions: [received(14, admin), { to: 'interview', at: at(6), by: admin }],
    },
    // REC-2025-0001: three applications already purged — anonymous rows, no candidate
    ...[21, 22, 23].map(
      (n, k): SeedApplication => ({
        id: demoApplication(n), openingId: DEMO_OPENINGS.tlemcen, candidateId: null, source: (['anem', 'spontaneous', 'job_board'] as const)[k] ?? 'other',
        createdBy: admin, purgedAt: at(40, 3),
        transitions:
          k === 2
            ? [received(465, admin), { to: 'withdrawn', at: at(440), by: admin }]
            : [received(465 - k, admin), { to: 'rejected', at: at(425, 10), by: admin, reason: 'opening_closed', autoCause: 'opening_closed' }],
      }),
    ),
  ];
  return { openings, candidates, applications };
}

/** seed:dev: the defaults and the DEMO data (re-running adds nothing). */
export async function seedDemoRecruitment(db: Executor, nowMs: number): Promise<{ openings: number; candidates: number; applications: number }> {
  await seedRecruitmentDefaults(db, DEMO);
  return seedRecruitment(db, DEMO, demoRecruitment(nowMs));
}
