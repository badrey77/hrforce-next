import { Injectable, NotFoundException } from '@nestjs/common';
import { ProblemException, ValidationProblemException, type FieldError } from '../../../platform/http/problem-details.js';
import { StaffingService } from '../../staffing/index.js';
import {
  algiersDateTime,
  algiersInstant,
  INTERVIEWER_PICKER_MAX,
  isActiveStage,
  isPreOfferStage,
  mean,
  RECRUITMENT_PERMISSIONS as P,
  type InterviewMode,
  type Recommendation,
} from '../domain/rules.js';
import { CandidatesRepository } from '../infra/candidates.repository.js';
import { InterviewsRepository, type InterviewFields, type InterviewRow, type OpeningCriterionRow } from '../infra/interviews.repository.js';
import type { OpeningRow } from '../infra/recruitment.repository.js';
import { ApplicationsService } from './applications.service.js';
import { criterionRef, EMPTY_RECOMMENDATIONS, InterviewNotices, InterviewReads, type LoadedInterview } from './interview-support.js';
import { OpeningsService } from './openings.service.js';
import { caller, RecruitmentAccess, RecruitmentClock } from './recruitment-access.js';
import type { ComparisonRow, ComparisonView, InterviewerOption, InterviewView, MyInterviewView } from './recruitment-views.js';
import { fileView, namePair } from './view-helpers.js';

export interface ScheduleInput {
  date: string;
  time: string;
  durationMinutes?: number | undefined;
  mode: InterviewMode;
  location?: string | null | undefined;
  label?: string | null | undefined;
  interviewerIds: string[];
}

export type UpdateInterviewInput = Partial<ScheduleInput>;

export interface EvaluationInput {
  scores: { criterionId: string; score: number }[];
  recommendation: Recommendation;
  comment?: string | null | undefined;
}

const interviewNotFound = () => new NotFoundException('Interview not found');
const notOpen = () => new ProblemException(409, 'recruitment-opening-not-open', 'This opening is not open.');
const wrongStage = () => new ProblemException(409, 'recruitment-interview-stage', 'An interview is scheduled for an application that is received, shortlisted or in interview.');
const cancelled = () => new ProblemException(409, 'recruitment-interview-cancelled', 'This interview is cancelled.');

const rowName = (r: ComparisonRow) => `${r.candidate.lastName} ${r.candidate.firstName}`;

/** Lower case, without accents: the picker's search. */
const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Interviews and evaluations (docs/contracts/recruitment.md › Interviews; Criteria and evaluations): HR schedules,
 * changes and cancels interviews with 1–5 interviewers who are active users of the company; each interviewer — with NO
 * recruitment permission — sees only the candidates they must evaluate, while the interview is scheduled and the
 * application in an active stage (name, opening, appointment, files, criteria, their OWN evaluation: never the NIN,
 * birth data, contact details, salary, notes, stage history or another evaluation), and submits scores 1–5 for every
 * criterion of the opening with a recommendation. The comparison of an opening lists its interviewed applications for
 * HR and for the heads of its unit.
 */
@Injectable()
export class InterviewsService {
  constructor(
    private readonly repo: InterviewsRepository,
    private readonly candidates: CandidatesRepository,
    private readonly applications: ApplicationsService,
    private readonly openings: OpeningsService,
    private readonly reads: InterviewReads,
    private readonly notices: InterviewNotices,
    private readonly access: RecruitmentAccess,
    private readonly staffing: StaffingService,
    private readonly clock: RecruitmentClock,
  ) {}

  // ── HR: the picker ──────────────────────────────────────────────────────────────────────────────────────────────

  /** GET /recruitment/interviewers?q=: active users of the company by name or e-mail, with their employee card. */
  async picker(q: string): Promise<{ items: InterviewerOption[] }> {
    const { companyId } = caller();
    const needle = fold(q);
    const found = (await this.repo.members(companyId))
      .filter((m) => m.status === 'active' && (fold(m.displayName).includes(needle) || m.email.toLowerCase().includes(needle)))
      .slice(0, INTERVIEWER_PICKER_MAX);
    const links = new Map<string, string>();
    for (const m of found) {
      const employmentId = await this.staffing.linkedEmploymentOf(m.id);
      if (employmentId) links.set(m.id, employmentId);
    }
    const cards = await this.staffing.cards([...links.values()]);
    return {
      items: found.map((m) => {
        const card = cards.get(links.get(m.id) ?? '');
        return {
          id: m.id,
          displayName: m.displayName,
          employee: card ? { matricule: card.matricule, unit: { id: card.unit.id, code: card.unit.code, name: card.unit.name, nameAr: card.unit.nameAr, kind: card.unit.kind } } : null,
        };
      }),
    };
  }

  /**
   * 1–5 distinct active users of the company (422 `interviewerIds.<i>` `duplicate` / `not_found`); a user whose linked
   * employment belongs to the candidate's linked person never evaluates themselves (`self`).
   */
  private async assertInterviewers(companyId: string, candidateId: string | null, userIds: readonly string[]): Promise<void> {
    const active = new Set((await this.repo.members(companyId)).filter((m) => m.status === 'active').map((m) => m.id));
    const personId = candidateId ? ((await this.candidates.candidate(companyId, candidateId))?.personId ?? null) : null;
    const errors: FieldError[] = [];
    for (const [k, userId] of userIds.entries()) {
      const field = `interviewerIds.${k}`;
      if (userIds.indexOf(userId) !== k) errors.push({ field, code: 'duplicate', message: 'This user is listed twice.' });
      else if (!active.has(userId)) errors.push({ field, code: 'not_found', message: 'No such active user.' });
      else if (personId) {
        const employmentId = await this.staffing.linkedEmploymentOf(userId);
        const card = employmentId ? (await this.staffing.cards([employmentId])).get(employmentId) : undefined;
        if (card?.person.id === personId) errors.push({ field, code: 'self', message: 'A person does not evaluate their own application.' });
      }
    }
    if (errors.length > 0) throw new ValidationProblemException(errors);
  }

  // ── HR: schedule, change, cancel ────────────────────────────────────────────────────────────────────────────────

  /** POST /recruitment/applications/:id/interviews → 201. A received / shortlisted application moves to `interview`. */
  async schedule(applicationId: string, input: ScheduleInput): Promise<InterviewView> {
    const { companyId, userId } = caller();
    const application = await this.applications.manageable(companyId, applicationId, { lock: true });
    if (!isPreOfferStage(application.stage)) throw wrongStage();
    if (application.openingStatus !== 'open') throw notOpen();
    await this.assertInterviewers(companyId, application.candidateId, input.interviewerIds);
    const id = await this.repo.insertInterview(
      companyId,
      applicationId,
      { label: input.label ?? null, scheduledAt: algiersInstant(input.date, input.time), durationMinutes: input.durationMinutes ?? 60, mode: input.mode, location: input.location ?? null },
      userId,
    );
    for (const interviewer of input.interviewerIds) await this.repo.insertInterviewer(companyId, id, interviewer);
    if (application.stage !== 'interview') {
      await this.candidates.setStage(companyId, applicationId, 'interview', false);
      await this.candidates.insertStage(companyId, { applicationId, from: application.stage, to: 'interview', autoCause: 'interview_scheduled', movedBy: userId });
    }
    const row = await this.mustFind(companyId, id);
    await this.notices.assigned(row, input.interviewerIds);
    return this.viewOf(companyId, row);
  }

  /** An interview HR may change: readable (404), manageable (403), not cancelled (409). */
  private async editable(companyId: string, id: string): Promise<InterviewRow> {
    const row = await this.repo.interview(companyId, id, { lock: true });
    if (!row || row.candidateId === null || !(await this.access.can(P.read, row.unitId))) throw interviewNotFound();
    if (!(await this.access.can(P.manage, row.unitId))) {
      throw new ProblemException(403, 'forbidden-scope', 'You cannot change this interview (outside your recruitment.manage scope).');
    }
    if (row.status === 'cancelled') throw cancelled();
    return row;
  }

  /** PATCH /recruitment/interviews/:id: the appointment and the interviewers (who are told of what concerns them). */
  async update(id: string, input: UpdateInterviewInput): Promise<InterviewView> {
    const { companyId } = caller();
    const row = await this.editable(companyId, id);
    if (!isActiveStage(row.stage)) throw wrongStage();
    if (row.openingStatus !== 'open') throw notOpen();
    const current = algiersDateTime(row.scheduledAt);
    const next: InterviewFields = {
      label: input.label !== undefined ? input.label : row.label,
      scheduledAt: algiersInstant(input.date ?? current.date, input.time ?? current.time),
      durationMinutes: input.durationMinutes ?? row.durationMinutes,
      mode: input.mode ?? row.mode,
      location: input.location !== undefined ? input.location : row.location,
    };
    const existing = await this.repo.interviewers(companyId, [id]);
    let added: string[] = [];
    let removed: typeof existing = [];
    if (input.interviewerIds) {
      const wanted = input.interviewerIds;
      added = wanted.filter((u) => !existing.some((w) => w.userId === u));
      removed = existing.filter((w) => !wanted.includes(w.userId));
      await this.assertInterviewers(companyId, row.candidateId, wanted);
      if (removed.some((w) => w.submittedAt !== null)) {
        throw new ProblemException(409, 'recruitment-evaluation-exists', 'An interviewer who already submitted an evaluation cannot be removed.', [
          { field: 'interviewerIds', code: 'evaluation_exists', message: 'An interviewer who already submitted an evaluation cannot be removed.' },
        ]);
      }
    }
    const moved = next.scheduledAt.getTime() !== row.scheduledAt.getTime() || next.location !== row.location || next.mode !== row.mode;
    if (moved || next.label !== row.label || next.durationMinutes !== row.durationMinutes) await this.repo.updateInterview(companyId, id, next);
    for (const w of removed) await this.repo.deleteInterviewer(companyId, w.id);
    for (const u of added) await this.repo.insertInterviewer(companyId, id, u);
    const after = await this.mustFind(companyId, id);
    await this.notices.cancelled(row, removed.map((w) => w.userId));
    await this.notices.assigned(after, added);
    if (moved) await this.notices.assigned(after, existing.filter((w) => !removed.includes(w)).map((w) => w.userId), true);
    return this.viewOf(companyId, after);
  }

  /** POST /recruitment/interviews/:id/cancel: final; the interview leaves the averages, the interviewers are told. */
  async cancel(id: string, reason: string): Promise<InterviewView> {
    const { companyId } = caller();
    const row = await this.editable(companyId, id);
    await this.repo.cancelInterview(companyId, id, reason);
    await this.notices.cancelled(row, (await this.repo.interviewers(companyId, [id])).map((w) => w.userId));
    return this.viewOf(companyId, await this.mustFind(companyId, id));
  }

  private async mustFind(companyId: string, id: string): Promise<InterviewRow> {
    const row = await this.repo.interview(companyId, id);
    if (!row) throw interviewNotFound();
    return row;
  }

  private async viewOf(companyId: string, row: InterviewRow): Promise<InterviewView> {
    const { userId } = caller();
    const [loaded] = await this.reads.loadRows(companyId, [row]);
    if (!loaded) throw interviewNotFound();
    const [ref, manage, criteria] = await Promise.all([this.access.userRefs(), this.access.can(P.manage, row.unitId), this.repo.openingCriteria(companyId, [row.openingId])]);
    const editable = manage && row.status === 'scheduled' && row.openingStatus === 'open' && isActiveStage(row.stage);
    return this.reads.view(loaded, ref, userId, criteria.map((c) => c.id), editable ? ['update', 'cancel'] : []);
  }

  // ── the interviewer's side (no permission) ──────────────────────────────────────────────────────────────────────

  /** GET /me/recruitment/interviews?filter=: `todo` = my evaluation not submitted, `done` = submitted; soonest first. */
  async mine(filter: 'todo' | 'done'): Promise<{ items: MyInterviewView[] }> {
    const { companyId, userId } = caller();
    const loaded = await this.reads.loadRows(companyId, await this.repo.interviewsOfUser(companyId, userId));
    const wanted = loaded
      .filter((i) => (i.interviewers.find((w) => w.userId === userId)?.submittedAt !== null) === (filter === 'done'))
      .toSorted((a, b) => a.row.scheduledAt.getTime() - b.row.scheduledAt.getTime());
    return { items: await this.myViews(companyId, wanted) };
  }

  /**
   * The interview when the caller is one of its interviewers, it is scheduled and its application is in an active
   * stage — else 404 (cancelled, final, purged, somebody else's).
   */
  private async own(companyId: string, id: string, options: { lock?: boolean } = {}): Promise<LoadedInterview> {
    const { userId } = caller();
    const row = await this.repo.interview(companyId, id, options);
    if (!row || row.status !== 'scheduled' || row.candidateId === null || !isActiveStage(row.stage)) throw interviewNotFound();
    const [loaded] = await this.reads.loadRows(companyId, [row]);
    if (!loaded || !loaded.interviewers.some((w) => w.userId === userId)) throw interviewNotFound();
    return loaded;
  }

  /** GET /me/recruitment/interviews/:id. */
  async myDetail(id: string): Promise<MyInterviewView> {
    const { companyId } = caller();
    const [view] = await this.myViews(companyId, [await this.own(companyId, id)]);
    if (!view) throw interviewNotFound();
    return view;
  }

  /**
   * PUT /me/recruitment/interviews/:id/evaluation: a score 1–5 for EVERY criterion of the opening, a recommendation,
   * an optional comment — submitted and re-submitted while the application is in the stage `interview`, from the
   * interview's time on. The user who scheduled the interview is told when the last expected evaluation arrives.
   */
  async evaluate(id: string, input: EvaluationInput): Promise<MyInterviewView> {
    const { companyId, userId } = caller();
    const loaded = await this.own(companyId, id, { lock: true });
    const criteria = (await this.repo.openingCriteria(companyId, [loaded.row.openingId])).map((c) => c.id);
    const given = input.scores.map((s) => s.criterionId);
    if (given.some((c, k) => !criteria.includes(c) || given.indexOf(c) !== k)) {
      throw new ValidationProblemException([{ field: 'scores', code: 'unknown', message: 'A score names a criterion that is not one of this opening (or names it twice).' }]);
    }
    if (criteria.some((c) => !given.includes(c))) {
      throw new ValidationProblemException([{ field: 'scores', code: 'incomplete', message: 'Every criterion of the opening needs a score.' }]);
    }
    if (loaded.row.stage !== 'interview') {
      throw new ProblemException(409, 'recruitment-evaluation-closed', 'Evaluations are closed: the application is no longer in the interview stage.');
    }
    if (loaded.row.scheduledAt.getTime() > this.clock.nowMs()) {
      throw new ProblemException(409, 'recruitment-interview-not-held', 'The interview has not taken place yet.');
    }
    const own = loaded.interviewers.find((w) => w.userId === userId);
    if (!own) throw interviewNotFound();
    await this.repo.submitEvaluation(companyId, own.id, { recommendation: input.recommendation, comment: input.comment ?? null, scores: input.scores });
    // the last expected evaluation (a re-submission tells nobody again)
    if (own.submittedAt === null && loaded.interviewers.every((w) => w.id === own.id || w.submittedAt !== null)) await this.notices.complete(loaded.row);
    return this.myDetail(id);
  }

  private async myViews(companyId: string, interviews: readonly LoadedInterview[]): Promise<MyInterviewView[]> {
    if (interviews.length === 0) return [];
    const { userId } = caller();
    const candidateIds = [...new Set(interviews.flatMap((i) => (i.row.candidateId ? [i.row.candidateId] : [])))];
    const [candidates, files, criteria, org, ref] = await Promise.all([
      this.candidates.candidates(companyId, candidateIds),
      this.candidates.files(companyId, candidateIds),
      this.repo.openingCriteria(companyId, [...new Set(interviews.map((i) => i.row.openingId))]),
      this.access.org(),
      this.access.userRefs(),
    ]);
    const now = this.clock.nowMs();
    return interviews.flatMap((i) => {
      const { row } = i;
      const candidate = candidates.find((c) => c.id === row.candidateId);
      if (!candidate) return [];
      const own: OpeningCriterionRow[] = criteria.filter((c) => c.openingId === row.openingId);
      const { date, time } = algiersDateTime(row.scheduledAt);
      return [
        {
          id: row.id,
          label: row.label,
          scheduledAt: row.scheduledAt.toISOString(),
          date,
          time,
          durationMinutes: row.durationMinutes,
          mode: row.mode,
          location: row.location,
          opening: { id: row.openingId, reference: row.reference, title: row.title, unit: org.unitRef(row.unitId) },
          applicationId: row.applicationId,
          candidate: namePair(candidate),
          files: files.filter((f) => f.candidateId === candidate.id).map((f) => fileView(f, ref, false)),
          criteria: own.map(criterionRef),
          evaluation: this.reads.ownEvaluation(i, userId, own.map((c) => c.id)),
          _actions: row.stage === 'interview' && row.scheduledAt.getTime() <= now ? (['evaluate'] as const).slice() : [],
        },
      ];
    });
  }

  // ── comparison ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** GET /recruitment/openings/:id/comparison (recruitment.read over the unit). */
  async comparison(openingId: string): Promise<ComparisonView> {
    const { companyId } = caller();
    return this.comparisonOf(companyId, await this.openings.readable(companyId, openingId));
  }

  /** GET /me/recruitment/openings/:id/comparison: a head of the opening's unit (or of a unit above), else 404. */
  async myComparison(openingId: string): Promise<ComparisonView> {
    const { companyId } = caller();
    const { row, head } = await this.openings.own(companyId, openingId);
    if (!head) throw new NotFoundException('Opening not found');
    return this.comparisonOf(companyId, row);
  }

  /**
   * One row per unpurged application with at least one non-cancelled interview: the average per criterion, the overall
   * average, the recommendations counted, the interviewers' comments — best average first (null last), then name.
   * No NIN, contact detail, salary or HR note is part of it. A row the caller still owes an evaluation for is `hidden`.
   */
  private async comparisonOf(companyId: string, opening: OpeningRow): Promise<ComparisonView> {
    const { userId } = caller();
    const [applications, criteria, ref] = await Promise.all([
      this.candidates.applicationsOfOpening(companyId, opening.id),
      this.repo.openingCriteria(companyId, [opening.id]),
      this.access.userRefs(),
    ]);
    const interviews = await this.reads.load(companyId, applications.map((a) => a.id));
    const rows: ComparisonRow[] = [];
    for (const a of applications) {
      const live = (interviews.get(a.id) ?? []).filter((i) => i.row.status === 'scheduled');
      if (live.length === 0 || a.candidateId === null) continue;
      const stats = this.reads.stats(live, userId);
      const submitted = stats.hidden ? [] : live.flatMap((i) => i.interviewers.filter((w) => w.submittedAt !== null).map((w) => ({ w, label: i.row.label })));
      const recommendations = EMPTY_RECOMMENDATIONS();
      for (const { w } of submitted) if (w.recommendation) recommendations[w.recommendation] += 1;
      rows.push({
        applicationId: a.id,
        candidate: { id: a.candidateId, ...namePair(a) },
        stage: a.stage,
        interviews: stats.interviews,
        evaluations: { submitted: stats.submitted, expected: stats.expected },
        criteria: criteria.map((c) => ({ criterionId: c.id, average: mean(submitted.flatMap(({ w }) => w.scores.filter((s) => s.criterionId === c.id).map((s) => s.score))) })),
        average: stats.average,
        recommendations,
        comments: submitted.flatMap(({ w, label }) =>
          w.recommendation ? [{ interviewer: ref(w.userId) ?? { id: w.userId, displayName: w.userId }, interviewLabel: label, recommendation: w.recommendation, comment: w.comment }] : [],
        ),
        hidden: stats.hidden,
      });
    }
    rows.sort((x, y) => (y.average ?? -1) - (x.average ?? -1) || rowName(x).localeCompare(rowName(y)));
    return { opening: await this.openings.openingRef(opening), criteria: criteria.map(criterionRef), rows };
  }
}
