import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder, type Transaction } from 'kysely';
import type { UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import type { DB } from '../../../platform/db/schema.js';
import { ACTIVE_STAGES, FINAL_STAGES, likeContains, type AutoCause, type FileKind, type OpeningStatus, type Source, type Stage } from '../domain/rules.js';
import { ids } from './recruitment.repository.js';

export interface CandidateRow {
  id: string;
  lastName: string;
  firstName: string;
  lastNameAr: string | null;
  firstNameAr: string | null;
  birthDate: string | null;
  birthPlace: string | null;
  sex: 'M' | 'F' | null;
  nationality: string;
  nin: string | null;
  email: string | null;
  phone: string | null;
  phoneKey: string | null;
  personId: string | null;
  informedOn: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export type CandidateFields = Omit<CandidateRow, 'id' | 'personId' | 'createdBy' | 'createdAt'>;

/** An application with its opening's identity and, when rejected, the reason of its latest transition. */
export interface ApplicationRow {
  id: string;
  openingId: string;
  candidateId: string | null;
  source: Source;
  stage: Stage;
  stageSince: Date;
  decidedAt: Date | null;
  employmentId: string | null;
  createdBy: string | null;
  createdAt: Date;
  purgedAt: Date | null;
  reference: string;
  title: string;
  unitId: string;
  openingStatus: OpeningStatus;
  reasonCode: string | null;
  reasonFr: string | null;
  reasonAr: string | null;
  reasonEn: string | null;
}

export interface ListedApplicationRow extends ApplicationRow {
  lastName: string;
  firstName: string;
  lastNameAr: string | null;
  firstNameAr: string | null;
  hasCv: boolean;
}

export interface StageRow {
  id: string;
  applicationId: string;
  fromStage: Stage | null;
  toStage: Stage;
  comment: string | null;
  autoCause: AutoCause | null;
  movedBy: string | null;
  movedAt: Date;
  reasonCode: string | null;
  reasonFr: string | null;
  reasonAr: string | null;
  reasonEn: string | null;
}

export interface NoteRow {
  id: string;
  applicationId: string;
  body: string;
  createdBy: string;
  createdAt: Date;
}

export interface FileRow {
  id: string;
  candidateId: string;
  kind: FileKind;
  title: string;
  originalFilename: string;
  mime: 'application/pdf' | 'image/jpeg' | 'image/png';
  sizeBytes: number;
  sha256: string;
  uploadedBy: string | null;
  uploadedAt: Date;
}

export interface MatchInput {
  nin?: string | null | undefined;
  email?: string | null | undefined;
  phoneKey?: string | null | undefined;
  /** both names and the birth date, or none of the three */
  name?: { lastName: string; firstName: string; birthDate: string } | undefined;
  excludeCandidateId?: string | undefined;
}

export interface MatchRow extends CandidateRow {
  onNin: boolean;
  onEmail: boolean;
  onPhone: boolean;
  onName: boolean;
}

export type ApplicationSort = 'name' | 'stageSince' | 'createdAt';

export interface ApplicationListQuery {
  /** recruitment.read scope: the opening's unit must be in it */
  scope: UnitIdQuery;
  q?: string | undefined;
  openingId?: string | undefined;
  stage?: Stage | undefined;
  state: 'active' | 'final' | 'all';
  /** active applications whose stage has not moved since this instant */
  idleBefore?: Date | undefined;
  units?: readonly string[] | undefined;
  sort: ApplicationSort;
  dir: 'asc' | 'desc';
  lang: 'fr' | 'ar' | 'en';
  limit: number;
  offset: number;
}

const CANDIDATE = sql`
  c.id, c.last_name as "lastName", c.first_name as "firstName", c.last_name_ar as "lastNameAr", c.first_name_ar as "firstNameAr",
  c.birth_date::text as "birthDate", c.birth_place as "birthPlace", c.sex, c.nationality, c.nin, c.email, c.phone, c.phone_key as "phoneKey",
  c.person_id as "personId", c.informed_on::text as "informedOn", c.created_by as "createdBy", c.created_at as "createdAt"`;

const APPLICATION = sql`
  a.id, a.opening_id as "openingId", a.candidate_id as "candidateId", a.source, a.stage, a.stage_since as "stageSince",
  a.decided_at as "decidedAt", a.employment_id as "employmentId", a.created_by as "createdBy", a.created_at as "createdAt",
  a.purged_at as "purgedAt", o.reference, o.title, o.org_unit_id as "unitId", o.status as "openingStatus",
  r.code as "reasonCode", r.name_fr as "reasonFr", r.name_ar as "reasonAr", r.name_en as "reasonEn"`;

/** `from` of every application read: its opening and the reason of its latest transition when it is rejected. */
const APPLICATION_FROM = sql`
  recruitment_application a
  join recruitment_opening o on o.company_id = a.company_id and o.id = a.opening_id
  left join lateral (
    select s.rejection_reason_id from recruitment_application_stage s
     where s.company_id = a.company_id and s.application_id = a.id
     order by s.seq desc limit 1
  ) ls on a.stage = 'rejected'
  left join recruitment_rejection_reason r on r.company_id = a.company_id and r.id = ls.rejection_reason_id`;

const FILE = sql`
  f.id, f.candidate_id as "candidateId", f.kind, f.title, f.original_filename as "originalFilename", f.mime, f.size_bytes as "sizeBytes",
  encode(f.sha256, 'hex') as sha256, f.uploaded_by as "uploadedBy", f.uploaded_at as "uploadedAt"`;

const stageList = (stages: readonly string[]): RawBuilder<unknown> => sql.join(stages.map((s) => sql`${s}`));

/**
 * Candidates, applications, their stage history, salary, notes and files (docs/contracts/recruitment.md) — through
 * the request transaction, always filtered by company too (RLS is the backstop).
 */
@Injectable()
export class CandidatesRepository {
  // ── candidates ──────────────────────────────────────────────────────────────────────────────────────────────────

  async insertCandidate(companyId: string, c: CandidateFields, createdBy: string): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into recruitment_candidate (company_id, last_name, first_name, last_name_ar, first_name_ar, birth_date, birth_place, sex, nationality,
                                         nin, email, phone, phone_key, informed_on, created_by)
      values (${companyId}::uuid, ${c.lastName}, ${c.firstName}, ${c.lastNameAr}, ${c.firstNameAr}, ${c.birthDate}::date, ${c.birthPlace}, ${c.sex},
              ${c.nationality}, ${c.nin}, ${c.email}, ${c.phone}, ${c.phoneKey}, ${c.informedOn}::date, ${createdBy}::uuid)
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('recruitment_candidate insert returned no id');
    return id;
  }

  async updateCandidate(companyId: string, id: string, c: CandidateFields): Promise<void> {
    await sql`
      update recruitment_candidate
         set last_name = ${c.lastName}, first_name = ${c.firstName}, last_name_ar = ${c.lastNameAr}, first_name_ar = ${c.firstNameAr},
             birth_date = ${c.birthDate}::date, birth_place = ${c.birthPlace}, sex = ${c.sex}, nationality = ${c.nationality}, nin = ${c.nin},
             email = ${c.email}, phone = ${c.phone}, phone_key = ${c.phoneKey}, informed_on = ${c.informedOn}::date
       where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async setPerson(companyId: string, id: string, personId: string | null): Promise<void> {
    await sql`update recruitment_candidate set person_id = ${personId}::uuid where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async candidate(companyId: string, id: string, { lock = false } = {}): Promise<CandidateRow | undefined> {
    const { rows } = await sql<CandidateRow>`
      select ${CANDIDATE} from recruitment_candidate c where c.company_id = ${companyId}::uuid and c.id = ${id}::uuid
      ${lock ? sql`for update` : sql``}`.execute(currentTx());
    return rows[0];
  }

  async candidates(companyId: string, list: readonly string[]): Promise<CandidateRow[]> {
    if (list.length === 0) return [];
    const { rows } = await sql<CandidateRow>`
      select ${CANDIDATE} from recruitment_candidate c where c.company_id = ${companyId}::uuid and c.id in (${ids(list)})`.execute(currentTx());
    return rows;
  }

  /**
   * Candidates VISIBLE to the caller (at least one application on an opening of `scope`) that match on the NIN, the
   * e-mail, the phone key, or the folded names + birth date — never company-wide, so the answer reveals nothing about
   * another region.
   */
  async match(companyId: string, scope: UnitIdQuery, input: MatchInput, limit: number): Promise<MatchRow[]> {
    const nin = input.nin ?? null;
    const email = input.email ?? null;
    const key = input.phoneKey ?? null;
    const name = input.name ?? null;
    if (!nin && !email && !key && !name) return [];
    const onName = name
      ? sql<boolean>`(c.sort_name = search_normalize(${`${name.lastName} ${name.firstName}`}) and c.birth_date = ${name.birthDate}::date)`
      : sql<boolean>`false`;
    const { rows } = await sql<MatchRow>`
      select m.* from (
        select ${CANDIDATE},
               (${nin}::text is not null and c.nin = ${nin}) as "onNin",
               (${email}::text is not null and c.email = ${email}) as "onEmail",
               (${key}::text is not null and c.phone_key = ${key}) as "onPhone",
               ${onName} as "onName"
          from recruitment_candidate c
         where c.company_id = ${companyId}::uuid
           ${input.excludeCandidateId ? sql`and c.id <> ${input.excludeCandidateId}::uuid` : sql``}
           and exists (
             select 1 from recruitment_application a
               join recruitment_opening o on o.company_id = a.company_id and o.id = a.opening_id
              where a.company_id = c.company_id and a.candidate_id = c.id and o.org_unit_id in (${scope}))
      ) m
      where m."onNin" or m."onEmail" or m."onPhone" or m."onName"
      order by m."onNin" desc, m."onEmail" desc, m."onPhone" desc, m."createdAt" desc
      limit ${limit}`.execute(currentTx());
    return rows;
  }

  // ── applications ────────────────────────────────────────────────────────────────────────────────────────────────

  async insertApplication(companyId: string, a: { openingId: string; candidateId: string; source: Source; createdBy: string }): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into recruitment_application (company_id, opening_id, candidate_id, source, created_by)
      values (${companyId}::uuid, ${a.openingId}::uuid, ${a.candidateId}::uuid, ${a.source}, ${a.createdBy}::uuid)
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('recruitment_application insert returned no id');
    return id;
  }

  /** An application (purged ones included: `candidateId` null). `lock`: row lock until the transaction ends. */
  async application(companyId: string, id: string, { lock = false } = {}): Promise<ApplicationRow | undefined> {
    const { rows } = await sql<ApplicationRow>`
      select ${APPLICATION} from ${APPLICATION_FROM}
       where a.company_id = ${companyId}::uuid and a.id = ${id}::uuid
      ${lock ? sql`for update of a` : sql``}`.execute(currentTx());
    return rows[0];
  }

  /** Every application of the candidates (any opening, visible or not), newest first. */
  async applicationsOfCandidates(companyId: string, candidateIds: readonly string[]): Promise<ApplicationRow[]> {
    if (candidateIds.length === 0) return [];
    const { rows } = await sql<ApplicationRow>`
      select ${APPLICATION} from ${APPLICATION_FROM}
       where a.company_id = ${companyId}::uuid and a.candidate_id in (${ids(candidateIds)})
       order by a.created_at desc, a.id desc`.execute(currentTx());
    return rows;
  }

  async alreadyApplied(companyId: string, openingId: string, candidateId: string): Promise<boolean> {
    const { rows } = await sql<{ id: string }>`
      select id from recruitment_application
       where company_id = ${companyId}::uuid and opening_id = ${openingId}::uuid and candidate_id = ${candidateId}::uuid limit 1`.execute(currentTx());
    return rows.length > 0;
  }

  /** The unpurged applications of an opening with their candidate's name and CV flag, oldest stage first. */
  async applicationsOfOpening(companyId: string, openingId: string, options: { stages?: readonly Stage[] } = {}): Promise<ListedApplicationRow[]> {
    const { rows } = await sql<ListedApplicationRow>`
      select ${APPLICATION}, c.last_name as "lastName", c.first_name as "firstName", c.last_name_ar as "lastNameAr", c.first_name_ar as "firstNameAr",
             exists (select 1 from recruitment_candidate_file f where f.company_id = a.company_id and f.candidate_id = a.candidate_id and f.kind = 'cv') as "hasCv"
        from ${APPLICATION_FROM}
        join recruitment_candidate c on c.company_id = a.company_id and c.id = a.candidate_id
       where a.company_id = ${companyId}::uuid and a.opening_id = ${openingId}::uuid and a.purged_at is null
         ${options.stages ? sql`and a.stage in (${stageList(options.stages)})` : sql``}
       order by a.stage_since, a.id`.execute(currentTx());
    return rows;
  }

  async unpurgedCount(companyId: string, openingId: string): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from recruitment_application
       where company_id = ${companyId}::uuid and opening_id = ${openingId}::uuid and purged_at is null`.execute(currentTx());
    return rows[0]?.n ?? 0;
  }

  async purgedCount(companyId: string, openingId: string): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from recruitment_application
       where company_id = ${companyId}::uuid and opening_id = ${openingId}::uuid and purged_at is not null`.execute(currentTx());
    return rows[0]?.n ?? 0;
  }

  /** GET /recruitment/candidates: one row per visible, unpurged application. */
  async list(companyId: string, query: ApplicationListQuery): Promise<{ rows: ListedApplicationRow[]; total: number }> {
    if (query.units !== undefined && query.units.length === 0) return { rows: [], total: 0 };
    const filters: RawBuilder<unknown>[] = [sql`a.company_id = ${companyId}::uuid`, sql`a.purged_at is null`, sql`o.org_unit_id in (${query.scope})`];
    if (query.openingId) filters.push(sql`a.opening_id = ${query.openingId}::uuid`);
    if (query.stage) filters.push(sql`a.stage = ${query.stage}`);
    if (query.state === 'active') filters.push(sql`a.stage in (${stageList(ACTIVE_STAGES)})`);
    if (query.state === 'final') filters.push(sql`a.stage in (${stageList(FINAL_STAGES)})`);
    if (query.idleBefore) filters.push(sql`a.stage in (${stageList(ACTIVE_STAGES)}) and a.stage_since < ${query.idleBefore}`);
    if (query.units) filters.push(sql`o.org_unit_id in (${ids(query.units)})`);
    if (query.q) {
      const like = likeContains(query.q);
      const digits = query.q.replace(/\D/g, '');
      filters.push(sql`(c.search_text like search_normalize(${like}) or c.email like lower(${like})
        ${digits.length >= 3 ? sql`or c.phone_key like ${`%${digits.replace(/^(00213|213|0)/, '')}%`}` : sql``})`);
    }
    const dir = query.dir === 'asc' ? sql`asc` : sql`desc`;
    // sort=name&lang=ar: the Arabic names (collation ar-x-icu), falling back to the Latin ones — as GET /employees
    const byName =
      query.lang === 'ar'
        ? sql`coalesce(nullif(btrim(c.last_name_ar), ''), c.last_name) collate "ar-x-icu" ${dir},
              coalesce(nullif(btrim(c.first_name_ar), ''), c.first_name) collate "ar-x-icu" ${dir}, a.id ${dir}`
        : sql`c.sort_name ${dir}, a.id ${dir}`;
    const order = { name: byName, stageSince: sql`a.stage_since ${dir}, a.id ${dir}`, createdAt: sql`a.created_at ${dir}, a.id ${dir}` }[query.sort];
    const { rows } = await sql<ListedApplicationRow & { total: number }>`
      select ${APPLICATION}, c.last_name as "lastName", c.first_name as "firstName", c.last_name_ar as "lastNameAr", c.first_name_ar as "firstNameAr",
             exists (select 1 from recruitment_candidate_file f where f.company_id = a.company_id and f.candidate_id = a.candidate_id and f.kind = 'cv') as "hasCv",
             count(*) over ()::int as total
        from ${APPLICATION_FROM}
        join recruitment_candidate c on c.company_id = a.company_id and c.id = a.candidate_id
       where ${sql.join(filters, sql` and `)}
       order by ${order}
       limit ${query.limit} offset ${query.offset}`.execute(currentTx());
    return { rows: rows.map(({ total: _t, ...r }) => r), total: rows[0]?.total ?? 0 };
  }

  async setStage(companyId: string, id: string, stage: Stage, decided: boolean): Promise<void> {
    await sql`
      update recruitment_application set stage = ${stage}, stage_since = now(), decided_at = ${decided ? sql`now()` : sql`null`}
       where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async setSource(companyId: string, id: string, source: Source): Promise<void> {
    await sql`update recruitment_application set source = ${source} where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  /** The opening's applications in an active stage, locked in id order (the opening row is locked first). */
  async lockActive(companyId: string, openingId: string): Promise<{ id: string; stage: Stage }[]> {
    const { rows } = await sql<{ id: string; stage: Stage }>`
      select a.id, a.stage from recruitment_application a
       where a.company_id = ${companyId}::uuid and a.opening_id = ${openingId}::uuid and a.purged_at is null
         and a.stage in (${stageList(ACTIVE_STAGES)})
       order by a.id
       for update`.execute(currentTx());
    return rows;
  }

  /**
   * The opening's unpurged applications whose LATEST transition has `cause` (the automatic closing to undo), with
   * that transition's from_stage — locked in id order.
   */
  async lockClosedBy(companyId: string, openingId: string, cause: AutoCause): Promise<{ id: string; stage: Stage; fromStage: Stage | null }[]> {
    const { rows } = await sql<{ id: string; stage: Stage; fromStage: Stage | null }>`
      select a.id, a.stage, s.from_stage as "fromStage"
        from recruitment_application a
        join lateral (
          select x.from_stage, x.auto_cause from recruitment_application_stage x
           where x.company_id = a.company_id and x.application_id = a.id
           order by x.seq desc limit 1
        ) s on true
       where a.company_id = ${companyId}::uuid and a.opening_id = ${openingId}::uuid and a.purged_at is null and s.auto_cause = ${cause}
       order by a.id
       for update of a`.execute(currentTx());
    return rows;
  }

  // ── stage history ───────────────────────────────────────────────────────────────────────────────────────────────

  async insertStage(
    companyId: string,
    s: { applicationId: string; from: Stage | null; to: Stage; reasonId?: string | null; comment?: string | null; autoCause?: AutoCause | null; movedBy: string | null },
  ): Promise<void> {
    await sql`
      insert into recruitment_application_stage (company_id, application_id, from_stage, to_stage, rejection_reason_id, comment, auto_cause, moved_by)
      values (${companyId}::uuid, ${s.applicationId}::uuid, ${s.from}, ${s.to}, ${s.reasonId ?? null}::uuid, ${s.comment ?? null}, ${s.autoCause ?? null},
              ${s.movedBy}::uuid)`.execute(currentTx());
  }

  /** The latest transition's from_stage (what a reopen restores). */
  async latestFrom(companyId: string, applicationId: string): Promise<Stage | null> {
    const { rows } = await sql<{ fromStage: Stage | null }>`
      select s.from_stage as "fromStage" from recruitment_application_stage s
       where s.company_id = ${companyId}::uuid and s.application_id = ${applicationId}::uuid
       order by s.seq desc limit 1`.execute(currentTx());
    return rows[0]?.fromStage ?? null;
  }

  /** Oldest first. */
  async stages(companyId: string, applicationId: string): Promise<StageRow[]> {
    const { rows } = await sql<StageRow>`
      select s.id, s.application_id as "applicationId", s.from_stage as "fromStage", s.to_stage as "toStage", s.comment, s.auto_cause as "autoCause",
             s.moved_by as "movedBy", s.moved_at as "movedAt", r.code as "reasonCode", r.name_fr as "reasonFr", r.name_ar as "reasonAr", r.name_en as "reasonEn"
        from recruitment_application_stage s
        left join recruitment_rejection_reason r on r.company_id = s.company_id and r.id = s.rejection_reason_id
       where s.company_id = ${companyId}::uuid and s.application_id = ${applicationId}::uuid
       order by s.seq`.execute(currentTx());
    return rows;
  }

  // ── salary ──────────────────────────────────────────────────────────────────────────────────────────────────────

  async expectedSalary(companyId: string, applicationId: string): Promise<string | null> {
    const { rows } = await sql<{ expected: string | null }>`
      select expected_salary::text as expected from recruitment_application_salary
       where company_id = ${companyId}::uuid and application_id = ${applicationId}::uuid`.execute(currentTx());
    return rows[0]?.expected ?? null;
  }

  /** Sets the expected salary; a row left with no amount at all is removed. */
  async setExpectedSalary(companyId: string, applicationId: string, expected: string | null): Promise<void> {
    if (expected === null) {
      await sql`
        update recruitment_application_salary set expected_salary = null
         where company_id = ${companyId}::uuid and application_id = ${applicationId}::uuid and expected_salary is not null`.execute(currentTx());
      await sql`
        delete from recruitment_application_salary
         where company_id = ${companyId}::uuid and application_id = ${applicationId}::uuid and expected_salary is null and proposed_salary is null`.execute(currentTx());
      return;
    }
    await sql`
      insert into recruitment_application_salary (application_id, company_id, expected_salary)
      values (${applicationId}::uuid, ${companyId}::uuid, ${expected}::numeric)
      on conflict (application_id) do update set expected_salary = excluded.expected_salary
      where recruitment_application_salary.expected_salary is distinct from excluded.expected_salary`.execute(currentTx());
  }

  // ── notes ───────────────────────────────────────────────────────────────────────────────────────────────────────

  async insertNote(companyId: string, applicationId: string, body: string, createdBy: string): Promise<NoteRow> {
    const { rows } = await sql<NoteRow>`
      insert into recruitment_note (company_id, application_id, body, created_by)
      values (${companyId}::uuid, ${applicationId}::uuid, ${body}, ${createdBy}::uuid)
      returning id, application_id as "applicationId", body, created_by as "createdBy", created_at as "createdAt"`.execute(currentTx());
    const row = rows[0];
    if (!row) throw new Error('recruitment_note insert returned no row');
    return row;
  }

  /** Newest first. */
  async notes(companyId: string, applicationId: string): Promise<NoteRow[]> {
    const { rows } = await sql<NoteRow>`
      select n.id, n.application_id as "applicationId", n.body, n.created_by as "createdBy", n.created_at as "createdAt"
        from recruitment_note n
       where n.company_id = ${companyId}::uuid and n.application_id = ${applicationId}::uuid
       order by n.created_at desc, n.id desc`.execute(currentTx());
    return rows;
  }

  async note(companyId: string, id: string): Promise<NoteRow | undefined> {
    const { rows } = await sql<NoteRow>`
      select n.id, n.application_id as "applicationId", n.body, n.created_by as "createdBy", n.created_at as "createdAt"
        from recruitment_note n where n.company_id = ${companyId}::uuid and n.id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  async deleteNote(companyId: string, id: string): Promise<void> {
    await sql`delete from recruitment_note where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async noteCounts(companyId: string, applicationIds: readonly string[]): Promise<Map<string, number>> {
    if (applicationIds.length === 0) return new Map();
    const { rows } = await sql<{ id: string; n: number }>`
      select n.application_id as id, count(*)::int as n from recruitment_note n
       where n.company_id = ${companyId}::uuid and n.application_id in (${ids(applicationIds)})
       group by n.application_id`.execute(currentTx());
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  // ── files ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Newest first. */
  async files(companyId: string, candidateIds: readonly string[]): Promise<FileRow[]> {
    if (candidateIds.length === 0) return [];
    const { rows } = await sql<FileRow>`
      select ${FILE} from recruitment_candidate_file f
       where f.company_id = ${companyId}::uuid and f.candidate_id in (${ids(candidateIds)})
       order by f.uploaded_at desc, f.id desc`.execute(currentTx());
    return rows;
  }

  async file(companyId: string, id: string): Promise<FileRow | undefined> {
    const { rows } = await sql<FileRow>`
      select ${FILE} from recruitment_candidate_file f where f.company_id = ${companyId}::uuid and f.id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  async fileCount(companyId: string, candidateId: string): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from recruitment_candidate_file where company_id = ${companyId}::uuid and candidate_id = ${candidateId}::uuid`.execute(currentTx());
    return rows[0]?.n ?? 0;
  }

  async duplicateFile(companyId: string, candidateId: string, sha256: Buffer): Promise<boolean> {
    const { rows } = await sql<{ id: string }>`
      select id from recruitment_candidate_file
       where company_id = ${companyId}::uuid and candidate_id = ${candidateId}::uuid and sha256 = ${sha256} limit 1`.execute(currentTx());
    return rows.length > 0;
  }

  async insertFile(
    companyId: string,
    f: { candidateId: string; kind: FileKind; title: string; originalFilename: string; mime: string; sha256: Buffer; uploadedBy: string; content: Buffer },
  ): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into recruitment_candidate_file (company_id, candidate_id, kind, title, original_filename, mime, size_bytes, sha256, uploaded_by)
      values (${companyId}::uuid, ${f.candidateId}::uuid, ${f.kind}, ${f.title}, ${f.originalFilename}, ${f.mime}, ${f.content.length}, ${f.sha256},
              ${f.uploadedBy}::uuid)
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('recruitment_candidate_file insert returned no id');
    await sql`insert into recruitment_candidate_file_content (file_id, company_id, content) values (${id}::uuid, ${companyId}::uuid, ${f.content})`.execute(currentTx());
    return id;
  }

  async content(companyId: string, fileId: string): Promise<Buffer | undefined> {
    const { rows } = await sql<{ content: Buffer }>`
      select content from recruitment_candidate_file_content where company_id = ${companyId}::uuid and file_id = ${fileId}::uuid`.execute(currentTx());
    return rows[0]?.content;
  }

  /** Hard delete: the row and (FK cascade) its bytes. */
  async deleteFile(companyId: string, id: string): Promise<void> {
    await sql`delete from recruitment_candidate_file where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }
}

// ── purge (the retention job as hrforce_worker, and the erasure on request as hrforce_app) ─────────────────────────

export interface PurgeResult {
  applications: number;
  candidates: number;
  files: number;
}

/**
 * Purges applications (docs/contracts/recruitment.md › Retention, erasure and worker), in this order: their notes and
 * salary rows are deleted, then their evaluation scores, interviewers, interviews and offers (Phase B), the comments of
 * their stage rows blanked, then `purged_at = now()` and `candidate_id = null`;
 * then every candidate of the company left with NO application loses its files (bytes by FK cascade) and its row.
 * What remains of an application is anonymous: opening, source, final stage, dates, employment, its stage rows.
 * Only decided, not yet purged applications are touched (the caller chose them; the database guard refuses the rest).
 */
export async function purgeApplications(tx: Transaction<DB>, companyId: string, applicationIds: readonly string[]): Promise<PurgeResult> {
  if (applicationIds.length === 0) return { applications: 0, candidates: 0, files: 0 };
  const list = ids(applicationIds);
  await sql`delete from recruitment_note where company_id = ${companyId}::uuid and application_id in (${list})`.execute(tx);
  await sql`delete from recruitment_application_salary where company_id = ${companyId}::uuid and application_id in (${list})`.execute(tx);
  // Phase B: evaluation scores → interviewers (recommendations, comments) → interviews → offers
  const interviews = sql`select i.id from recruitment_interview i where i.company_id = ${companyId}::uuid and i.application_id in (${list})`;
  await sql`
    delete from recruitment_evaluation_score
     where company_id = ${companyId}::uuid
       and interviewer_id in (select w.id from recruitment_interviewer w where w.company_id = ${companyId}::uuid and w.interview_id in (${interviews}))`.execute(tx);
  await sql`delete from recruitment_interviewer where company_id = ${companyId}::uuid and interview_id in (${interviews})`.execute(tx);
  await sql`delete from recruitment_interview where company_id = ${companyId}::uuid and application_id in (${list})`.execute(tx);
  await sql`delete from recruitment_offer where company_id = ${companyId}::uuid and application_id in (${list})`.execute(tx);
  await sql`
    update recruitment_application_stage set comment = null
     where company_id = ${companyId}::uuid and application_id in (${list}) and comment is not null`.execute(tx);
  const purged = await sql<{ candidateId: string }>`
    with gone as (
      select a.id, a.candidate_id from recruitment_application a
       where a.company_id = ${companyId}::uuid and a.id in (${list}) and a.purged_at is null
       for update
    ), done as (
      update recruitment_application a set purged_at = now(), candidate_id = null
        from gone where a.company_id = ${companyId}::uuid and a.id = gone.id
      returning 1
    )
    select gone.candidate_id as "candidateId" from gone, (select count(*) from done) d`.execute(tx);
  const candidateIds = [...new Set(purged.rows.map((r) => r.candidateId))];
  let candidates = 0;
  let files = 0;
  if (candidateIds.length > 0) {
    const orphans = await sql<{ id: string }>`
      select c.id from recruitment_candidate c
       where c.company_id = ${companyId}::uuid and c.id in (${ids(candidateIds)})
         and not exists (select 1 from recruitment_application a where a.company_id = c.company_id and a.candidate_id = c.id)`.execute(tx);
    // (no row lock: the worker holds no UPDATE on candidates; an application added meanwhile makes the delete fail on
    // its foreign key and the whole purge of this company is retried)
    const gone = orphans.rows.map((r) => r.id);
    if (gone.length > 0) {
      const removed = await sql<{ n: number }>`
        with f as (delete from recruitment_candidate_file where company_id = ${companyId}::uuid and candidate_id in (${ids(gone)}) returning 1)
        select count(*)::int as n from f`.execute(tx);
      files = removed.rows[0]?.n ?? 0;
      await sql`delete from recruitment_candidate where company_id = ${companyId}::uuid and id in (${ids(gone)})`.execute(tx);
      candidates = gone.length;
    }
  }
  return { applications: purged.rows.length, candidates, files };
}

/** The applications due for the retention purge on `today` (Algiers date): decided, unpurged, past the policy's months. */
export async function dueApplications(tx: Transaction<DB>, companyId: string, today: string, retentionMonths: number): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    select a.id from recruitment_application a
     where a.company_id = ${companyId}::uuid and a.purged_at is null and a.decided_at is not null
       and a.stage in (${stageList(FINAL_STAGES)})
       and ((a.decided_at at time zone 'Africa/Algiers')::date + make_interval(months => ${retentionMonths}))::date < ${today}::date
     order by a.id`.execute(tx);
  return rows.map((r) => r.id);
}

export async function retentionMonthsOf(tx: Transaction<DB>, companyId: string, fallback: number): Promise<number> {
  const row = await tx.selectFrom('recruitment_policy').select('retention_months').where('company_id', '=', companyId).executeTakeFirst();
  return row?.retention_months ?? fallback;
}
