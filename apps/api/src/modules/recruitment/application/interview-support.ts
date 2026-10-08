import { Injectable } from '@nestjs/common';
import { Notifier, type NotificationData, type NotificationType } from '../../../platform/notifications/notifier.js';
import { algiersDateTime, interviewState, rawMean, round1, type Recommendation } from '../domain/rules.js';
import { InterviewsRepository, type InterviewerRow, type InterviewRow, type OpeningCriterionRow, type ScoreRow } from '../infra/interviews.repository.js';
import { caller, RecruitmentAccess, RecruitmentClock } from './recruitment-access.js';
import type { CriterionRef, EvaluationView, InterviewView, UserRef } from './recruitment-views.js';

export interface LoadedInterviewer extends InterviewerRow {
  scores: ScoreRow[];
}

export interface LoadedInterview {
  row: InterviewRow;
  interviewers: LoadedInterviewer[];
}

/** What the lists show of an application's interviews. */
export interface InterviewStats {
  /** non-cancelled interviews */
  interviews: number;
  /** the next scheduled interview that has not started */
  nextInterviewAt: Date | null;
  submitted: number;
  expected: number;
  /** evaluations still expected of interviews already held */
  pendingEvaluations: number;
  /** the mean of the submitted evaluators' overalls (one decimal); null when nothing is submitted — or hidden */
  average: number | null;
  /** the caller is an interviewer of the application who has not submitted: they see no other evaluation yet */
  hidden: boolean;
}

type Ref = (id: string | null) => UserRef | null;

export function criterionRef(c: Pick<OpeningCriterionRow, 'id' | 'nameFr' | 'nameAr' | 'nameEn'>): CriterionRef {
  return { id: c.id, labels: { fr: c.nameFr, ar: c.nameAr, en: c.nameEn } };
}

/** An evaluator's overall: the mean of their scores, unrounded (null before they submit, or without any criterion). */
export function overallOf(w: LoadedInterviewer): number | null {
  return w.submittedAt ? rawMean(w.scores.map((s) => s.score)) : null;
}

function evaluationOf(w: LoadedInterviewer, order: readonly string[]): Omit<EvaluationView, 'interviewer'> {
  const rank = (id: string) => {
    const k = order.indexOf(id);
    return k < 0 ? order.length : k;
  };
  return {
    submittedAt: w.submittedAt ? w.submittedAt.toISOString() : null,
    scores: w.submittedAt ? w.scores.map((s) => ({ criterionId: s.criterionId, score: s.score })).toSorted((a, b) => rank(a.criterionId) - rank(b.criterionId)) : [],
    overall: round1(overallOf(w)),
    recommendation: w.submittedAt ? w.recommendation : null,
    comment: w.submittedAt ? w.comment : null,
  };
}

/**
 * Reads of interviews and evaluations shared by the HR views, the heads' view, the comparison and « my interviews »
 * (docs/contracts/recruitment.md › Criteria and evaluations): an evaluator's overall is the mean of their scores, an
 * application's average the mean of the submitted evaluators' overalls over its non-cancelled interviews — both
 * rounded to one decimal, null when nothing is submitted. An interviewer who has not submitted sees no other
 * evaluation of that application, by whatever route (HR, head): averages come back null and the others' scores,
 * recommendations and comments are left out until they submit.
 */
@Injectable()
export class InterviewReads {
  constructor(
    private readonly repo: InterviewsRepository,
    private readonly clock: RecruitmentClock,
  ) {}

  /** The interviews of the applications (soonest first) with their interviewers and scores. */
  async load(companyId: string, applicationIds: readonly string[]): Promise<Map<string, LoadedInterview[]>> {
    const out = new Map<string, LoadedInterview[]>();
    const rows = await this.repo.interviewsOfApplications(companyId, applicationIds);
    return this.attach(companyId, rows, out);
  }

  async loadRows(companyId: string, rows: readonly InterviewRow[]): Promise<LoadedInterview[]> {
    return [...(await this.attach(companyId, rows, new Map())).values()].flat();
  }

  private async attach(companyId: string, rows: readonly InterviewRow[], out: Map<string, LoadedInterview[]>): Promise<Map<string, LoadedInterview[]>> {
    const interviewers = await this.repo.interviewers(companyId, rows.map((r) => r.id));
    const scores = await this.repo.scores(companyId, interviewers.map((w) => w.id));
    for (const row of rows) {
      const list = out.get(row.applicationId) ?? [];
      list.push({ row, interviewers: interviewers.filter((w) => w.interviewId === row.id).map((w) => ({ ...w, scores: scores.filter((s) => s.interviewerId === w.id) })) });
      out.set(row.applicationId, list);
    }
    return out;
  }

  /** The caller owes an evaluation of this interview (they are one of its interviewers and have not submitted). */
  owes(interview: LoadedInterview, userId: string): boolean {
    return interview.row.status === 'scheduled' && interview.interviewers.some((w) => w.userId === userId && w.submittedAt === null);
  }

  stats(list: readonly LoadedInterview[], userId: string): InterviewStats {
    const now = this.clock.nowMs();
    const live = list.filter((i) => i.row.status === 'scheduled');
    const evaluators = live.flatMap((i) => i.interviewers);
    const hidden = live.some((i) => this.owes(i, userId));
    const overalls = evaluators.map(overallOf).filter((v): v is number => v !== null);
    const next = live.find((i) => i.row.scheduledAt.getTime() > now);
    return {
      interviews: live.length,
      nextInterviewAt: next ? next.row.scheduledAt : null,
      submitted: evaluators.filter((w) => w.submittedAt !== null).length,
      expected: evaluators.length,
      pendingEvaluations: live.filter((i) => i.row.scheduledAt.getTime() <= now).flatMap((i) => i.interviewers).filter((w) => w.submittedAt === null).length,
      average: hidden ? null : round1(rawMean(overalls)),
      hidden,
    };
  }

  /** The HR view of one interview. `criteria`: the opening's criteria ids, in order (the order of the scores). */
  view(interview: LoadedInterview, ref: Ref, userId: string, criteria: readonly string[], actions: InterviewView['_actions']): InterviewView {
    const { row, interviewers } = interview;
    const hidden = this.owes(interview, userId);
    const submitted = interviewers.filter((w) => w.submittedAt !== null);
    const { date, time } = algiersDateTime(row.scheduledAt);
    return {
      id: row.id,
      applicationId: row.applicationId,
      label: row.label,
      scheduledAt: row.scheduledAt.toISOString(),
      date,
      time,
      durationMinutes: row.durationMinutes,
      mode: row.mode,
      location: row.location,
      status: row.status,
      state: interviewState(row, submitted.length, interviewers.length, this.clock.nowMs()),
      cancelReason: row.cancelReason,
      createdBy: ref(row.createdBy),
      evaluations: interviewers.map((w) => {
        const evaluation = evaluationOf(w, criteria);
        const masked = hidden && w.userId !== userId;
        return {
          interviewer: ref(w.userId) ?? { id: w.userId, displayName: w.userId },
          ...(masked ? { submittedAt: evaluation.submittedAt, scores: [], overall: null, recommendation: null, comment: null } : evaluation),
        };
      }),
      average: hidden || row.status === 'cancelled' ? null : round1(rawMean(interviewers.map(overallOf).filter((v): v is number => v !== null))),
      evaluationsHidden: hidden,
      _actions: actions,
    };
  }

  /** The caller's own evaluation of an interview (never another one). */
  ownEvaluation(interview: LoadedInterview, userId: string, criteria: readonly string[]): Omit<EvaluationView, 'interviewer'> {
    const own = interview.interviewers.find((w) => w.userId === userId);
    return own ? evaluationOf(own, criteria) : { submittedAt: null, scores: [], overall: null, recommendation: null, comment: null };
  }
}

export const EMPTY_RECOMMENDATIONS = (): Record<Recommendation, number> => ({ strong_yes: 0, yes: 0, no: 0, strong_no: 0 });

/**
 * The notifications of interviews (docs/contracts/recruitment.md › Notifications (Phase B)) and what happens to the
 * interviews and the offer of an application that leaves the pipeline. Subject `recruitment_interview`; the data name
 * the POST and the appointment — never the candidate (a notification row would outlive the erasure). The Notifier
 * drops the acting user.
 */
@Injectable()
export class InterviewNotices {
  constructor(
    private readonly repo: InterviewsRepository,
    private readonly access: RecruitmentAccess,
    private readonly notifier: Notifier,
    private readonly clock: RecruitmentClock,
  ) {}

  private async data(row: InterviewRow): Promise<NotificationData> {
    const { userId } = caller();
    const { date, time } = algiersDateTime(row.scheduledAt);
    const actor = (await this.access.userRefs())(userId);
    return { interviewId: row.id, openingId: row.openingId, reference: row.reference, title: row.title, date, time, mode: row.mode, actorName: actor?.displayName ?? null };
  }

  private async send(type: NotificationType, row: InterviewRow, userIds: readonly string[], extra: NotificationData = {}): Promise<void> {
    if (userIds.length === 0) return;
    await this.notifier.notify({
      type,
      subject: { type: 'recruitment_interview', id: row.id },
      data: { ...(await this.data(row)), ...extra },
      recipients: userIds.map((userId) => ({ userId, audience: 'approver' as const })),
    });
  }

  /** An interview is scheduled, an interviewer added, or its date / time / place changed (`rescheduled`). */
  assigned(row: InterviewRow, userIds: readonly string[], rescheduled = false): Promise<void> {
    return this.send('recruitment.interview_assigned', row, userIds, rescheduled ? { rescheduled: 1 } : {});
  }

  /** An interview is cancelled, or an interviewer removed. */
  cancelled(row: InterviewRow, userIds: readonly string[]): Promise<void> {
    return this.send('recruitment.interview_cancelled', row, userIds);
  }

  /** The last expected evaluation is in: the user who scheduled the interview (ids only — never a name). */
  complete(row: InterviewRow): Promise<void> {
    return this.send('recruitment.evaluations_complete', row, [row.createdBy], { applicationId: row.applicationId, candidateId: row.candidateId });
  }

  /**
   * Applications that left the pipeline (rejected, withdrawn, closed with their opening): their offer in progress is
   * cancelled, their interviews that have not started are cancelled with `reason`, and the interviewers are told.
   */
  async applicationsClosed(companyId: string, applicationIds: readonly string[], reason: string): Promise<void> {
    if (applicationIds.length === 0) return;
    await this.repo.cancelProposedOf(companyId, applicationIds);
    const cancelled = await this.repo.cancelFutureOf(companyId, applicationIds, reason, new Date(this.clock.nowMs()));
    if (cancelled.length === 0) return;
    const interviewers = await this.repo.interviewers(companyId, cancelled.map((i) => i.id));
    for (const row of cancelled) {
      await this.cancelled(row, interviewers.filter((w) => w.interviewId === row.id).map((w) => w.userId));
    }
  }
}
