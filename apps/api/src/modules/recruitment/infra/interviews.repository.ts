import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import { ACTIVE_STAGES, type ContractType, type InterviewMode, type OfferStatus, type OpeningStatus, type Recommendation, type Stage } from '../domain/rules.js';
import { ids } from './recruitment.repository.js';

export interface CriterionRow {
  id: string;
  code: string;
  nameFr: string;
  nameAr: string;
  nameEn: string;
  active: boolean;
  sortOrder: number;
  isSystem: boolean;
}

export interface OpeningCriterionRow {
  openingId: string;
  id: string;
  nameFr: string;
  nameAr: string;
  nameEn: string;
  position: number;
}

/** An interview with what decides who may see it: its application, that application's stage and opening. */
export interface InterviewRow {
  id: string;
  applicationId: string;
  label: string | null;
  scheduledAt: Date;
  durationMinutes: number;
  mode: InterviewMode;
  location: string | null;
  status: 'scheduled' | 'cancelled';
  cancelReason: string | null;
  createdBy: string;
  createdAt: Date;
  candidateId: string | null;
  stage: Stage;
  openingId: string;
  reference: string;
  title: string;
  unitId: string;
  openingStatus: OpeningStatus;
}

export interface InterviewerRow {
  id: string;
  interviewId: string;
  userId: string;
  recommendation: Recommendation | null;
  comment: string | null;
  submittedAt: Date | null;
}

export interface ScoreRow {
  interviewerId: string;
  criterionId: string;
  score: number;
}

export interface OfferRow {
  id: string;
  applicationId: string;
  jobTitle: string;
  orgUnitId: string;
  siteId: string | null;
  contractType: ContractType;
  startDate: string;
  note: string | null;
  status: OfferStatus;
  decidedAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface MemberRow {
  id: string;
  email: string;
  displayName: string;
  status: string;
}

export interface InterviewFields {
  label: string | null;
  scheduledAt: Date;
  durationMinutes: number;
  mode: InterviewMode;
  location: string | null;
}

export interface OfferFields {
  jobTitle: string;
  orgUnitId: string;
  siteId: string | null;
  contractType: ContractType;
  startDate: string;
  note: string | null;
}

const CRITERION = sql`k.id, k.code, k.name_fr as "nameFr", k.name_ar as "nameAr", k.name_en as "nameEn", k.active, k.sort_order as "sortOrder",
  k.is_system as "isSystem"`;

const INTERVIEW = sql`
  i.id, i.application_id as "applicationId", i.label, i.scheduled_at as "scheduledAt", i.duration_minutes as "durationMinutes", i.mode, i.location,
  i.status, i.cancel_reason as "cancelReason", i.created_by as "createdBy", i.created_at as "createdAt",
  a.candidate_id as "candidateId", a.stage, a.opening_id as "openingId", o.reference, o.title, o.org_unit_id as "unitId", o.status as "openingStatus"`;

const INTERVIEW_FROM = sql`
  recruitment_interview i
  join recruitment_application a on a.company_id = i.company_id and a.id = i.application_id
  join recruitment_opening o on o.company_id = a.company_id and o.id = a.opening_id`;

const INTERVIEWER = sql`w.id, w.interview_id as "interviewId", w.user_id as "userId", w.recommendation, w.comment, w.submitted_at as "submittedAt"`;

const OFFER = sql`
  f.id, f.application_id as "applicationId", f.job_title as "jobTitle", f.org_unit_id as "orgUnitId", f.site_id as "siteId",
  f.contract_type as "contractType", f.start_date::text as "startDate", f.note, f.status, f.decided_at as "decidedAt", f.created_by as "createdBy",
  f.created_at as "createdAt"`;

const activeStages = (): RawBuilder<unknown> => sql.join(ACTIVE_STAGES.map((s) => sql`${s}`));

/**
 * Criteria, interviews, interviewers, evaluation scores and offers (docs/contracts/recruitment.md › Phase B) — through
 * the request transaction, always filtered by company too (RLS is the backstop).
 */
@Injectable()
export class InterviewsRepository {
  // ── criteria ────────────────────────────────────────────────────────────────────────────────────────────────────

  async criteria(companyId: string): Promise<CriterionRow[]> {
    const { rows } = await sql<CriterionRow>`
      select ${CRITERION} from recruitment_criterion k where k.company_id = ${companyId}::uuid order by k.sort_order, k.code`.execute(currentTx());
    return rows;
  }

  async criterion(companyId: string, id: string): Promise<CriterionRow | undefined> {
    const { rows } = await sql<CriterionRow>`
      select ${CRITERION} from recruitment_criterion k where k.company_id = ${companyId}::uuid and k.id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  async criterionByCode(companyId: string, code: string): Promise<CriterionRow | undefined> {
    const { rows } = await sql<CriterionRow>`
      select ${CRITERION} from recruitment_criterion k where k.company_id = ${companyId}::uuid and k.code = ${code}`.execute(currentTx());
    return rows[0];
  }

  /** A new criterion goes last. */
  async insertCriterion(companyId: string, c: { code: string; nameFr: string; nameAr: string; nameEn: string }): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into recruitment_criterion (company_id, code, name_fr, name_ar, name_en, sort_order)
      select ${companyId}::uuid, ${c.code}, ${c.nameFr}, ${c.nameAr}, ${c.nameEn},
             coalesce((select max(x.sort_order) from recruitment_criterion x where x.company_id = ${companyId}::uuid), 0) + 10
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('recruitment_criterion insert returned no id');
    return id;
  }

  async updateCriterion(companyId: string, id: string, patch: { nameFr?: string; nameAr?: string; nameEn?: string; active?: boolean; sortOrder?: number }): Promise<void> {
    await sql`
      update recruitment_criterion
         set name_fr = coalesce(${patch.nameFr ?? null}, name_fr), name_ar = coalesce(${patch.nameAr ?? null}, name_ar),
             name_en = coalesce(${patch.nameEn ?? null}, name_en), active = coalesce(${patch.active ?? null}::boolean, active),
             sort_order = coalesce(${patch.sortOrder ?? null}::int, sort_order)
       where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  /** The criteria of the openings, in order. */
  async openingCriteria(companyId: string, openingIds: readonly string[]): Promise<OpeningCriterionRow[]> {
    if (openingIds.length === 0) return [];
    const { rows } = await sql<OpeningCriterionRow>`
      select c.opening_id as "openingId", k.id, k.name_fr as "nameFr", k.name_ar as "nameAr", k.name_en as "nameEn", c.position
        from recruitment_opening_criterion c
        join recruitment_criterion k on k.company_id = c.company_id and k.id = c.criterion_id
       where c.company_id = ${companyId}::uuid and c.opening_id in (${ids(openingIds)})
       order by c.opening_id, c.position, k.code`.execute(currentTx());
    return rows;
  }

  async replaceOpeningCriteria(companyId: string, openingId: string, criterionIds: readonly string[]): Promise<void> {
    await sql`delete from recruitment_opening_criterion where company_id = ${companyId}::uuid and opening_id = ${openingId}::uuid`.execute(currentTx());
    for (const [k, id] of criterionIds.entries()) {
      await sql`
        insert into recruitment_opening_criterion (company_id, opening_id, criterion_id, position)
        values (${companyId}::uuid, ${openingId}::uuid, ${id}::uuid, ${k + 1})`.execute(currentTx());
    }
  }

  /** An opening that opens gets the company's active criteria (the first eight, in order). */
  async copyActiveCriteria(companyId: string, openingId: string): Promise<void> {
    await sql`
      insert into recruitment_opening_criterion (company_id, opening_id, criterion_id, position)
      select ${companyId}::uuid, ${openingId}::uuid, x.id, x.n
        from (select k.id, row_number() over (order by k.sort_order, k.code) as n
                from recruitment_criterion k where k.company_id = ${companyId}::uuid and k.active) x
       where x.n <= 8
      on conflict do nothing`.execute(currentTx());
  }

  /** The openings (of `openingIds`) that hold at least one submitted evaluation: their criteria are locked. */
  async openingsWithEvaluations(companyId: string, openingIds: readonly string[]): Promise<Set<string>> {
    if (openingIds.length === 0) return new Set();
    const { rows } = await sql<{ id: string }>`
      select distinct a.opening_id as id
        from recruitment_interviewer w
        join recruitment_interview i on i.company_id = w.company_id and i.id = w.interview_id
        join recruitment_application a on a.company_id = i.company_id and a.id = i.application_id
       where w.company_id = ${companyId}::uuid and w.submitted_at is not null and a.opening_id in (${ids(openingIds)})`.execute(currentTx());
    return new Set(rows.map((r) => r.id));
  }

  // ── members ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The company's members with their account status (auth.company_members: current members only). */
  async members(companyId: string): Promise<MemberRow[]> {
    const { rows } = await sql<MemberRow>`
      select user_id as id, email, display_name as "displayName", status from auth.company_members(${companyId}::uuid)`.execute(currentTx());
    return rows;
  }

  // ── interviews ──────────────────────────────────────────────────────────────────────────────────────────────────

  async insertInterview(companyId: string, applicationId: string, f: InterviewFields, createdBy: string): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into recruitment_interview (company_id, application_id, label, scheduled_at, duration_minutes, mode, location, created_by)
      values (${companyId}::uuid, ${applicationId}::uuid, ${f.label}, ${f.scheduledAt}, ${f.durationMinutes}, ${f.mode}, ${f.location}, ${createdBy}::uuid)
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('recruitment_interview insert returned no id');
    return id;
  }

  async updateInterview(companyId: string, id: string, f: InterviewFields): Promise<void> {
    await sql`
      update recruitment_interview
         set label = ${f.label}, scheduled_at = ${f.scheduledAt}, duration_minutes = ${f.durationMinutes}, mode = ${f.mode}, location = ${f.location}
       where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async cancelInterview(companyId: string, id: string, reason: string): Promise<void> {
    await sql`
      update recruitment_interview set status = 'cancelled', cancel_reason = ${reason}
       where company_id = ${companyId}::uuid and id = ${id}::uuid and status = 'scheduled'`.execute(currentTx());
  }

  async interview(companyId: string, id: string, { lock = false } = {}): Promise<InterviewRow | undefined> {
    const { rows } = await sql<InterviewRow>`
      select ${INTERVIEW} from ${INTERVIEW_FROM}
       where i.company_id = ${companyId}::uuid and i.id = ${id}::uuid
      ${lock ? sql`for update of i` : sql``}`.execute(currentTx());
    return rows[0];
  }

  /** Every interview of the applications, soonest first. */
  async interviewsOfApplications(companyId: string, applicationIds: readonly string[]): Promise<InterviewRow[]> {
    if (applicationIds.length === 0) return [];
    const { rows } = await sql<InterviewRow>`
      select ${INTERVIEW} from ${INTERVIEW_FROM}
       where i.company_id = ${companyId}::uuid and i.application_id in (${ids(applicationIds)})
       order by i.scheduled_at, i.id`.execute(currentTx());
    return rows;
  }

  /**
   * The interviews a user must evaluate and may still see: `scheduled`, on an application in an ACTIVE stage (not
   * purged) — soonest first.
   */
  async interviewsOfUser(companyId: string, userId: string): Promise<InterviewRow[]> {
    const { rows } = await sql<InterviewRow>`
      select ${INTERVIEW} from ${INTERVIEW_FROM}
        join recruitment_interviewer w on w.company_id = i.company_id and w.interview_id = i.id
       where i.company_id = ${companyId}::uuid and w.user_id = ${userId}::uuid and i.status = 'scheduled'
         and a.purged_at is null and a.stage in (${activeStages()})
       order by i.scheduled_at, i.id`.execute(currentTx());
    return rows;
  }

  /** Whether the user is an interviewer of a scheduled interview of the application. */
  async isInterviewerOf(companyId: string, applicationId: string, userId: string): Promise<boolean> {
    const { rows } = await sql<{ id: string }>`
      select w.id from recruitment_interviewer w
        join recruitment_interview i on i.company_id = w.company_id and i.id = w.interview_id
       where w.company_id = ${companyId}::uuid and w.user_id = ${userId}::uuid and i.application_id = ${applicationId}::uuid and i.status = 'scheduled'
       limit 1`.execute(currentTx());
    return rows.length > 0;
  }

  /**
   * Cancels the scheduled interviews of the applications that have not started yet → what was cancelled, to tell the
   * interviewers (an application closed, rejected or withdrawn: nobody should come to its interview).
   */
  async cancelFutureOf(companyId: string, applicationIds: readonly string[], reason: string, now: Date): Promise<InterviewRow[]> {
    if (applicationIds.length === 0) return [];
    const { rows } = await sql<{ id: string }>`
      update recruitment_interview set status = 'cancelled', cancel_reason = ${reason}
       where company_id = ${companyId}::uuid and application_id in (${ids(applicationIds)}) and status = 'scheduled' and scheduled_at > ${now}
      returning id`.execute(currentTx());
    if (rows.length === 0) return [];
    const cancelled = await sql<InterviewRow>`
      select ${INTERVIEW} from ${INTERVIEW_FROM}
       where i.company_id = ${companyId}::uuid and i.id in (${ids(rows.map((r) => r.id))})
       order by i.scheduled_at, i.id`.execute(currentTx());
    return cancelled.rows;
  }

  // ── interviewers and evaluations ────────────────────────────────────────────────────────────────────────────────

  async interviewers(companyId: string, interviewIds: readonly string[]): Promise<InterviewerRow[]> {
    if (interviewIds.length === 0) return [];
    const { rows } = await sql<InterviewerRow>`
      select ${INTERVIEWER} from recruitment_interviewer w
       where w.company_id = ${companyId}::uuid and w.interview_id in (${ids(interviewIds)})
       order by w.interview_id, w.id`.execute(currentTx());
    return rows;
  }

  async scores(companyId: string, interviewerIds: readonly string[]): Promise<ScoreRow[]> {
    if (interviewerIds.length === 0) return [];
    const { rows } = await sql<ScoreRow>`
      select s.interviewer_id as "interviewerId", s.criterion_id as "criterionId", s.score::int as score
        from recruitment_evaluation_score s
       where s.company_id = ${companyId}::uuid and s.interviewer_id in (${ids(interviewerIds)})`.execute(currentTx());
    return rows;
  }

  async insertInterviewer(companyId: string, interviewId: string, userId: string): Promise<void> {
    await sql`
      insert into recruitment_interviewer (company_id, interview_id, user_id)
      values (${companyId}::uuid, ${interviewId}::uuid, ${userId}::uuid)`.execute(currentTx());
  }

  /** Removes an interviewer who has not submitted (their row holds no score). */
  async deleteInterviewer(companyId: string, id: string): Promise<void> {
    await sql`delete from recruitment_evaluation_score where company_id = ${companyId}::uuid and interviewer_id = ${id}::uuid`.execute(currentTx());
    await sql`delete from recruitment_interviewer where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  /** One submission: the scores are replaced, the recommendation, the comment and the instant set. */
  async submitEvaluation(companyId: string, interviewerId: string, e: { recommendation: Recommendation; comment: string | null; scores: readonly { criterionId: string; score: number }[] }): Promise<void> {
    await sql`delete from recruitment_evaluation_score where company_id = ${companyId}::uuid and interviewer_id = ${interviewerId}::uuid`.execute(currentTx());
    for (const s of e.scores) {
      await sql`
        insert into recruitment_evaluation_score (company_id, interviewer_id, criterion_id, score)
        values (${companyId}::uuid, ${interviewerId}::uuid, ${s.criterionId}::uuid, ${s.score})`.execute(currentTx());
    }
    await sql`
      update recruitment_interviewer set recommendation = ${e.recommendation}, comment = ${e.comment}, submitted_at = clock_timestamp()
       where company_id = ${companyId}::uuid and id = ${interviewerId}::uuid`.execute(currentTx());
  }

  // ── offers ──────────────────────────────────────────────────────────────────────────────────────────────────────

  async insertOffer(companyId: string, applicationId: string, f: OfferFields, createdBy: string): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into recruitment_offer (company_id, application_id, job_title, org_unit_id, site_id, contract_type, start_date, note, created_by)
      values (${companyId}::uuid, ${applicationId}::uuid, ${f.jobTitle}, ${f.orgUnitId}::uuid, ${f.siteId}::uuid, ${f.contractType}, ${f.startDate}::date,
              ${f.note}, ${createdBy}::uuid)
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('recruitment_offer insert returned no id');
    return id;
  }

  async updateOffer(companyId: string, id: string, f: OfferFields): Promise<void> {
    await sql`
      update recruitment_offer
         set job_title = ${f.jobTitle}, org_unit_id = ${f.orgUnitId}::uuid, site_id = ${f.siteId}::uuid, contract_type = ${f.contractType},
             start_date = ${f.startDate}::date, note = ${f.note}
       where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  /** accepted / declined / cancelled (decided now), or back to `proposed` (a hire undone). */
  async setOfferStatus(companyId: string, id: string, status: OfferStatus): Promise<void> {
    await sql`
      update recruitment_offer set status = ${status}, decided_at = ${status === 'proposed' ? sql`null` : sql`now()`}
       where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  /** The offer in progress of an application. */
  async proposedOffer(companyId: string, applicationId: string): Promise<OfferRow | undefined> {
    const { rows } = await sql<OfferRow>`
      select ${OFFER} from recruitment_offer f
       where f.company_id = ${companyId}::uuid and f.application_id = ${applicationId}::uuid and f.status = 'proposed'`.execute(currentTx());
    return rows[0];
  }

  /** The latest offer of each application, whatever its status. */
  async latestOffers(companyId: string, applicationIds: readonly string[]): Promise<Map<string, OfferRow>> {
    if (applicationIds.length === 0) return new Map();
    const { rows } = await sql<OfferRow>`
      select distinct on (f.application_id) ${OFFER} from recruitment_offer f
       where f.company_id = ${companyId}::uuid and f.application_id in (${ids(applicationIds)})
       order by f.application_id, f.created_at desc, f.id desc`.execute(currentTx());
    return new Map(rows.map((r) => [r.applicationId, r]));
  }

  /** Offers in progress of an opening (with the hires, never more than its posts). */
  async proposedCount(companyId: string, openingId: string): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from recruitment_offer f
        join recruitment_application a on a.company_id = f.company_id and a.id = f.application_id
       where f.company_id = ${companyId}::uuid and a.opening_id = ${openingId}::uuid and f.status = 'proposed'`.execute(currentTx());
    return rows[0]?.n ?? 0;
  }

  /** The offers in progress of applications that leave the pipeline are cancelled. */
  async cancelProposedOf(companyId: string, applicationIds: readonly string[]): Promise<void> {
    if (applicationIds.length === 0) return;
    await sql`
      update recruitment_offer set status = 'cancelled', decided_at = now()
       where company_id = ${companyId}::uuid and application_id in (${ids(applicationIds)}) and status = 'proposed'`.execute(currentTx());
  }

  async salary(companyId: string, applicationId: string): Promise<{ expected: string | null; proposed: string | null }> {
    const { rows } = await sql<{ expected: string | null; proposed: string | null }>`
      select expected_salary::text as expected, proposed_salary::text as proposed from recruitment_application_salary
       where company_id = ${companyId}::uuid and application_id = ${applicationId}::uuid`.execute(currentTx());
    return rows[0] ?? { expected: null, proposed: null };
  }

  /** Sets the proposed salary; a row left with no amount at all is removed. */
  async setProposedSalary(companyId: string, applicationId: string, proposed: string | null): Promise<void> {
    if (proposed === null) {
      await sql`
        update recruitment_application_salary set proposed_salary = null
         where company_id = ${companyId}::uuid and application_id = ${applicationId}::uuid and proposed_salary is not null`.execute(currentTx());
      await sql`
        delete from recruitment_application_salary
         where company_id = ${companyId}::uuid and application_id = ${applicationId}::uuid and expected_salary is null and proposed_salary is null`.execute(currentTx());
      return;
    }
    await sql`
      insert into recruitment_application_salary (application_id, company_id, proposed_salary)
      values (${applicationId}::uuid, ${companyId}::uuid, ${proposed}::numeric)
      on conflict (application_id) do update set proposed_salary = excluded.proposed_salary
      where recruitment_application_salary.proposed_salary is distinct from excluded.proposed_salary`.execute(currentTx());
  }

  // ── hire ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** offer → hired, with the employment the hire created (the stage row is written by the caller). */
  async markHired(companyId: string, applicationId: string, employmentId: string): Promise<void> {
    await sql`
      update recruitment_application set stage = 'hired', stage_since = now(), decided_at = now(), employment_id = ${employmentId}::uuid
       where company_id = ${companyId}::uuid and id = ${applicationId}::uuid`.execute(currentTx());
  }

  /** hired → offer (or interview, without an offer to restore): the employment link goes. */
  async markHireUndone(companyId: string, applicationId: string, to: Stage): Promise<void> {
    await sql`
      update recruitment_application set stage = ${to}, stage_since = now(), decided_at = null, employment_id = null
       where company_id = ${companyId}::uuid and id = ${applicationId}::uuid`.execute(currentTx());
  }

  async addHire(companyId: string, openingId: string): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      update recruitment_opening set hired_count = hired_count + 1
       where company_id = ${companyId}::uuid and id = ${openingId}::uuid returning hired_count as n`.execute(currentTx());
    return rows[0]?.n ?? 0;
  }

  /** One hire less; a filled opening is open again (one statement: the opening's checks tie the count to the status). */
  async removeHire(companyId: string, openingId: string): Promise<void> {
    await sql`
      update recruitment_opening
         set hired_count = hired_count - 1,
             status = case when status = 'filled' then 'open' else status end,
             closed_at = case when status = 'filled' then null else closed_at end
       where company_id = ${companyId}::uuid and id = ${openingId}::uuid`.execute(currentTx());
  }

  /** The end date of an employment, whoever asks (the undo needs it ended; no scope: the hire permission decided). */
  async employment(companyId: string, employmentId: string): Promise<{ endDate: string | null; personId: string } | undefined> {
    const { rows } = await sql<{ endDate: string | null; personId: string }>`
      select e.end_date::text as "endDate", e.person_id as "personId" from employment e
       where e.company_id = ${companyId}::uuid and e.id = ${employmentId}::uuid`.execute(currentTx());
    return rows[0];
  }

  // ── counts ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Scheduled interviews of applications in progress between two instants, in the scope. */
  async interviewsBetween(companyId: string, scope: UnitIdQuery, from: Date, to: Date): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from ${INTERVIEW_FROM}
       where i.company_id = ${companyId}::uuid and i.status = 'scheduled' and i.scheduled_at >= ${from} and i.scheduled_at < ${to}
         and a.purged_at is null and a.stage in (${activeStages()}) and o.org_unit_id in (${scope})`.execute(currentTx());
    return rows[0]?.n ?? 0;
  }

  /** Offers in progress of the open openings of the scope. */
  async offersPending(companyId: string, scope: UnitIdQuery): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from recruitment_offer f
        join recruitment_application a on a.company_id = f.company_id and a.id = f.application_id
        join recruitment_opening o on o.company_id = a.company_id and o.id = a.opening_id
       where f.company_id = ${companyId}::uuid and f.status = 'proposed' and o.status = 'open' and o.org_unit_id in (${scope})`.execute(currentTx());
    return rows[0]?.n ?? 0;
  }
}
