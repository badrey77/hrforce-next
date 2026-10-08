import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { Notifier, type NotificationData, type NotificationType } from '../../../platform/notifications/notifier.js';
import { StaffingService } from '../../staffing/index.js';
import { WorkflowEngine, WorkflowSubjects, type HookContext, type ManagerCandidate, type TaskHistoryView, type WorkflowProgressView } from '../../workflow/index.js';
import {
  AUTO_REASON,
  isActiveStage,
  MY_OPENINGS_MAX,
  OPENING_CRITERIA_MAX,
  openingReference,
  RECRUITMENT_PERMISSIONS as P,
  restoredStage,
  type AutoCause,
  type ContractType,
  type OpeningStatus,
} from '../domain/rules.js';
import { CandidatesRepository } from '../infra/candidates.repository.js';
import { InterviewsRepository } from '../infra/interviews.repository.js';
import { criterionRef, InterviewNotices, InterviewReads } from './interview-support.js';
import { emptyCounts, RecruitmentRepository, type OpeningRow, type OpeningSort } from '../infra/recruitment.repository.js';
import { caller, RecruitmentAccess, RecruitmentClock } from './recruitment-access.js';
import type {
  CriterionRef,
  HeadApplicationView,
  MyOpeningDetailView,
  MyOpeningView,
  MySummaryView,
  OpeningAction,
  OpeningDetailView,
  OpeningPage,
  OpeningRef,
  OpeningView,
  RequestableUnit,
  StageCounts,
  SummaryView,
} from './recruitment-views.js';
import { fileView } from './view-helpers.js';

export interface RequestOpeningInput {
  title: string;
  orgUnitId: string;
  siteId?: string | null | undefined;
  contractType: ContractType;
  posts: number;
  justification: string;
  targetDate: string;
}

export interface UpdateOpeningInput {
  targetDate?: string | undefined;
  siteId?: string | null | undefined;
  anemReference?: string | null | undefined;
  posts?: number | undefined;
}

export interface OpeningListInput {
  status: OpeningStatus | 'active' | 'all';
  unitId?: string | undefined;
  includeSubUnits: boolean;
  contractType?: ContractType | undefined;
  q?: string | undefined;
  sort: OpeningSort;
  dir?: 'asc' | 'desc' | undefined;
  page: number;
  pageSize: number;
}

const SUBJECT = 'recruitment_opening' as const;
const openingNotFound = () => new NotFoundException('Opening not found');
const notOpen = () => new ProblemException(409, 'recruitment-opening-not-open', 'This opening is not open.');
const forbiddenScope = (permission: string) =>
  new ProblemException(403, 'forbidden-scope', `You cannot do this for this opening (outside your ${permission} scope).`);

type OpeningBase = Omit<OpeningView, 'counts' | '_actions'>;

/**
 * Job openings (docs/contracts/recruitment.md › Openings): the request by a unit head or HR, its approval through the
 * workflow engine (subject type `recruitment_opening`; the manager step goes to the head of the opening's unit, or to
 * the nearest head above when the requester is that head), the HR list and detail, edits while open, close / fill
 * (which reject the applications still in progress) and reopen (which restores exactly those), the requester's and
 * the heads' restricted view, the home counts. Nothing about a candidate ever goes through the workflow engine.
 */
@Injectable()
export class OpeningsService implements OnModuleInit {
  constructor(
    private readonly repo: RecruitmentRepository,
    private readonly candidates: CandidatesRepository,
    private readonly interviews: InterviewsRepository,
    private readonly interviewReads: InterviewReads,
    private readonly notices: InterviewNotices,
    private readonly access: RecruitmentAccess,
    private readonly scopes: ScopeService,
    private readonly staffing: StaffingService,
    private readonly workflow: WorkflowEngine,
    private readonly subjects: WorkflowSubjects,
    private readonly notifier: Notifier,
    private readonly clock: RecruitmentClock,
  ) {}

  onModuleInit(): void {
    this.subjects.register(SUBJECT, {
      resolveManager: (id) => this.resolveManager(id),
      onApproved: (c) => this.onApproved(c),
      onRejected: (c) => this.onRejected(c),
      onCancelled: (c) => this.onCancelled(c),
      summaries: (ids) => this.summaries(ids),
      notificationData: (id) => this.notificationData(id),
    });
  }

  // ── access ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The opening when recruitment.read covers its unit, else 404 (unknown, other company, out of scope). */
  async readable(companyId: string, id: string, options: { lock?: boolean } = {}): Promise<OpeningRow> {
    const row = await this.repo.opening(companyId, id, options);
    if (!row || !(await this.access.can(P.read, row.orgUnitId))) throw openingNotFound();
    return row;
  }

  /** {@link readable} + `permission` over the unit (else 403 forbidden-scope). */
  async writable(companyId: string, id: string, permission: string, options: { lock?: boolean } = {}): Promise<OpeningRow> {
    const row = await this.readable(companyId, id, options);
    if (!(await this.access.can(permission, row.orgUnitId))) throw forbiddenScope(permission);
    return row;
  }

  /** Assumption 2: the head of the unit (or of a unit above it), or HR holding recruitment.manage over it. */
  private async mayRequestFor(unitId: string): Promise<boolean> {
    return (await this.access.headUnits()).has(unitId) || (await this.access.can(P.manage, unitId));
  }

  // ── request ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** POST /recruitment/openings → 201 OpeningDetailView. */
  async request(input: RequestOpeningInput): Promise<OpeningDetailView> {
    const { companyId, userId } = caller();
    if (!(await this.repo.unitExists(companyId, input.orgUnitId))) {
      throw new ValidationProblemException([{ field: 'orgUnitId', code: 'not_found', message: 'The org unit does not exist.' }]);
    }
    if (!(await this.mayRequestFor(input.orgUnitId))) {
      const detail = 'Only the head of the unit (or of a unit above it) or HR in charge of it may request an opening for it.';
      throw new ProblemException(403, 'forbidden-scope', detail, [{ field: 'orgUnitId', code: 'forbidden_scope', message: detail }]);
    }
    const siteId = input.siteId ?? null;
    if (siteId !== null && !(await this.repo.siteExists(companyId, siteId))) {
      throw new ValidationProblemException([{ field: 'siteId', code: 'not_found', message: 'The site does not exist.' }]);
    }
    const today = this.clock.today();
    if (input.targetDate < today) {
      throw new ValidationProblemException([{ field: 'targetDate', code: 'past', message: 'The target date is in the past.' }]);
    }
    const policy = await this.repo.policy(companyId);
    const definitionId = await this.repo.definitionId(companyId, policy.openingWorkflowCode);
    if (!definitionId) throw new Error(`workflow definition ${policy.openingWorkflowCode} missing`);
    const year = Number(today.slice(0, 4));
    const reference = openingReference(year, await this.repo.nextSequence(companyId, year));
    const id = await this.repo.insertOpening(companyId, {
      reference,
      title: input.title,
      orgUnitId: input.orgUnitId,
      siteId,
      contractType: input.contractType,
      posts: input.posts,
      justification: input.justification,
      targetDate: input.targetDate,
      requestedBy: userId,
    });
    // nobody is the "subject" of an opening: only the requester is kept from approving it
    const instanceId = await this.workflow.start({ definitionId, subjectType: SUBJECT, subjectId: id, scopeUnitId: input.orgUnitId, subjectUserId: null });
    await this.repo.setInstance(companyId, id, instanceId);
    return this.detailOf(companyId, id);
  }

  // ── HR reads ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** GET /recruitment/openings. */
  async list(input: OpeningListInput): Promise<OpeningPage> {
    const { companyId } = caller();
    let units: string[] | undefined;
    if (input.unitId) units = input.includeSubUnits ? [...(await this.access.org()).subtree([input.unitId])] : [input.unitId];
    const statuses: readonly OpeningStatus[] | undefined = input.status === 'all' ? undefined : input.status === 'active' ? ['pending', 'open'] : [input.status];
    const { rows, total } = await this.repo.listOpenings(companyId, {
      scope: await this.scopes.scopeOf(P.read),
      statuses,
      units,
      contractType: input.contractType,
      q: input.q,
      sort: input.sort,
      dir: input.dir ?? (input.sort === 'requestedAt' ? 'desc' : 'asc'),
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });
    return { items: await this.openingViews(companyId, rows), total, page: input.page, pageSize: input.pageSize };
  }

  /** GET /recruitment/openings/:id. */
  async detail(id: string): Promise<OpeningDetailView> {
    const { companyId } = caller();
    await this.readable(companyId, id);
    return this.detailOf(companyId, id);
  }

  /** GET /recruitment/summary: the counts of the caller's recruitment.read scope. */
  async summary(): Promise<SummaryView> {
    const { companyId } = caller();
    const scope = await this.scopes.scopeOf(P.read);
    const now = this.clock.nowMs();
    return {
      openings: await this.repo.statusCounts(companyId, scope),
      applications: await this.repo.activeStageCounts(companyId, scope),
      interviewsNext7Days: await this.interviews.interviewsBetween(companyId, scope, new Date(now), new Date(now + 7 * 86_400_000)),
      offersPending: await this.interviews.offersPending(companyId, scope),
    };
  }

  // ── HR writes ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** PATCH /recruitment/openings/:id: while open; `posts` downwards only, lowering it to the hires fills the opening. */
  async update(id: string, input: UpdateOpeningInput): Promise<OpeningDetailView> {
    const { companyId, userId } = caller();
    const row = await this.writable(companyId, id, P.manage, { lock: true });
    if (row.status !== 'open') throw notOpen();
    if (input.siteId && !(await this.repo.siteExists(companyId, input.siteId))) {
      throw new ValidationProblemException([{ field: 'siteId', code: 'not_found', message: 'The site does not exist.' }]);
    }
    if (input.targetDate !== undefined && input.targetDate !== row.targetDate && input.targetDate < this.clock.today()) {
      throw new ValidationProblemException([{ field: 'targetDate', code: 'past', message: 'The target date is in the past.' }]);
    }
    if (input.posts !== undefined && input.posts > row.posts) {
      throw new ValidationProblemException([{ field: 'posts', code: 'increase', message: 'More posts need a new opening request (the approval is not bypassed).' }]);
    }
    if (input.posts !== undefined && input.posts < Math.max(1, row.hiredCount)) {
      throw new ValidationProblemException([{ field: 'posts', code: 'below_hired', message: `At least ${Math.max(1, row.hiredCount)}.` }]);
    }
    // offers in progress + hires never exceed the posts (lowering to the hires fills the opening and cancels the offers)
    if (input.posts !== undefined && input.posts !== row.hiredCount && input.posts < row.hiredCount + (await this.interviews.proposedCount(companyId, id))) {
      throw new ValidationProblemException([{ field: 'posts', code: 'below_offers', message: 'Offers in progress would exceed the posts: cancel one first.' }]);
    }
    const patch: { targetDate?: string; siteId?: string | null; anemReference?: string | null; posts?: number } = {};
    if (input.targetDate !== undefined) patch.targetDate = input.targetDate;
    if (input.siteId !== undefined) patch.siteId = input.siteId;
    if (input.anemReference !== undefined) patch.anemReference = input.anemReference;
    if (input.posts !== undefined) patch.posts = input.posts;
    await this.repo.updateOpening(companyId, id, patch);
    if (input.posts !== undefined && row.hiredCount > 0 && input.posts === row.hiredCount) await this.fill(companyId, id, userId);
    return this.detailOf(companyId, id);
  }

  /**
   * PUT /recruitment/openings/:id/criteria: the criteria interviewers score (1–8 active ones, in order), while the
   * opening is open and none of its evaluations is submitted.
   */
  async setCriteria(id: string, criterionIds: readonly string[]): Promise<OpeningDetailView> {
    const { companyId } = caller();
    const row = await this.writable(companyId, id, P.manage, { lock: true });
    if (row.status !== 'open') throw notOpen();
    const known = new Map((await this.interviews.criteria(companyId)).map((c) => [c.id, c]));
    const errors: { field: string; code: string; message: string }[] = [];
    for (const [k, criterionId] of criterionIds.entries()) {
      const criterion = known.get(criterionId);
      if (criterionIds.indexOf(criterionId) !== k) errors.push({ field: `criterionIds.${k}`, code: 'duplicate', message: 'This criterion is listed twice.' });
      else if (!criterion) errors.push({ field: `criterionIds.${k}`, code: 'not_found', message: 'No such criterion.' });
      else if (!criterion.active) errors.push({ field: `criterionIds.${k}`, code: 'inactive', message: 'This criterion is no longer used.' });
    }
    if (errors.length > 0) throw new ValidationProblemException(errors);
    if ((await this.interviews.openingsWithEvaluations(companyId, [id])).has(id)) {
      throw new ProblemException(409, 'recruitment-criteria-locked', 'An evaluation of this opening is already submitted: its criteria no longer change.');
    }
    await this.interviews.replaceOpeningCriteria(companyId, id, criterionIds.slice(0, OPENING_CRITERIA_MAX));
    return this.detailOf(companyId, id);
  }

  /** POST /recruitment/openings/:id/close: open → closed; the applications in progress are rejected (`opening_closed`). */
  async close(id: string, reason: string): Promise<OpeningDetailView> {
    const { companyId, userId } = caller();
    const row = await this.writable(companyId, id, P.manage, { lock: true });
    if (row.status !== 'open') throw notOpen();
    await this.repo.markClosed(companyId, id, userId, reason);
    await this.rejectActive(companyId, id, 'opening_closed', userId);
    return this.detailOf(companyId, id);
  }

  /** POST /recruitment/openings/:id/reopen: closed → open; the applications the closing rejected come back. */
  async reopen(id: string): Promise<OpeningDetailView> {
    const { companyId, userId } = caller();
    const row = await this.writable(companyId, id, P.manage, { lock: true });
    if (row.status !== 'closed') throw new ProblemException(409, 'recruitment-opening-not-closed', 'Only a closed opening can be reopened.');
    if (row.hiredCount >= row.posts) throw new ProblemException(409, 'recruitment-no-post-left', 'Every post of this opening is filled.');
    await this.repo.markReopened(companyId, id);
    await this.restore(companyId, id, 'opening_closed', 'opening_reopened', userId);
    return this.detailOf(companyId, id);
  }

  /**
   * open → filled (hires = posts; the opening row is already locked by the caller): the applications still in progress
   * are rejected with the system reason `position_filled`. Also what the Phase B hire calls for the last post.
   */
  async fill(companyId: string, id: string, actorUserId: string): Promise<void> {
    await this.repo.markFilled(companyId, id);
    await this.rejectActive(companyId, id, 'opening_filled', actorUserId);
  }

  /** Every application in an active stage → `rejected` with the automatic reason of `cause`, locked in id order. */
  private async rejectActive(companyId: string, openingId: string, cause: 'opening_closed' | 'opening_filled', actorUserId: string): Promise<void> {
    const active = await this.candidates.lockActive(companyId, openingId);
    if (active.length === 0) return;
    const reason = await this.repo.reasonByCode(companyId, AUTO_REASON[cause]);
    if (!reason) throw new Error(`rejection reason ${AUTO_REASON[cause]} missing`);
    for (const a of active) {
      await this.candidates.setStage(companyId, a.id, 'rejected', true);
      await this.candidates.insertStage(companyId, { applicationId: a.id, from: a.stage, to: 'rejected', reasonId: reason.id, autoCause: cause, movedBy: actorUserId });
    }
    // their offers in progress and their interviews to come are cancelled, the interviewers told
    await this.notices.applicationsClosed(companyId, active.map((a) => a.id), reason.nameFr);
  }

  /**
   * Undoes an automatic closing: every unpurged application whose LATEST transition has `closedBy` returns to that
   * transition's from_stage (`interview` when it was `offer`), decided_at null.
   */
  async restore(companyId: string, openingId: string, closedBy: AutoCause, cause: 'opening_reopened' | 'hire_undone', actorUserId: string): Promise<void> {
    for (const a of await this.candidates.lockClosedBy(companyId, openingId, closedBy)) {
      const back = restoredStage(a.fromStage);
      await this.candidates.setStage(companyId, a.id, back, false);
      await this.candidates.insertStage(companyId, { applicationId: a.id, from: a.stage, to: back, autoCause: cause, movedBy: actorUserId });
    }
  }

  // ── the requester's and the heads' view ─────────────────────────────────────────────────────────────────────────

  /** GET /me/recruitment/summary: never 404 — zeros and false for a user with nothing. */
  async mySummary(): Promise<MySummaryView> {
    const { companyId, userId } = caller();
    const headUnits = await this.access.headUnits();
    const counts = await this.repo.myOpeningCounts(companyId, userId, [...headUnits]);
    const mine = await this.interviews.interviewsOfUser(companyId, userId);
    const own = new Map((await this.interviews.interviewers(companyId, mine.map((i) => i.id))).filter((w) => w.userId === userId).map((w) => [w.interviewId, w]));
    const now = this.clock.nowMs();
    return {
      canRequestOpening: headUnits.size > 0 || (await this.scopes.unitIds(P.manage)).size > 0,
      openings: counts.openings,
      pendingOpenings: counts.pending,
      interviews: mine.length,
      evaluationsTodo: mine.filter((i) => i.stage === 'interview' && i.scheduledAt.getTime() <= now && own.get(i.id)?.submittedAt === null).length,
    };
  }

  /**
   * GET /me/recruitment/units: the units the caller may request an opening for AS A HEAD — the units their linked
   * employment heads today and all their sub-units — whatever their org_unit.read (owner decision 2026-10-08: the
   * request form offers a head's sub-units). Tree order: a unit before its sub-units, siblings by code.
   */
  async myUnits(): Promise<{ items: RequestableUnit[] }> {
    const [headUnits, org] = await Promise.all([this.access.headUnits(), this.access.org()]);
    return { items: org.tree(headUnits).map(({ unit, parentId, depth }) => ({ ...unit, site: org.siteRef(org.effectiveSite(unit.id)), parentId, depth })) };
  }

  /** GET /me/recruitment/openings: the openings the caller requested or heads, newest first. */
  async mine(): Promise<{ items: MyOpeningView[] }> {
    const { companyId, userId } = caller();
    const headUnits = await this.access.headUnits();
    const rows = await this.repo.myOpenings(companyId, userId, [...headUnits], MY_OPENINGS_MAX);
    return { items: await this.myViews(companyId, rows, userId, headUnits) };
  }

  /** The opening when the caller requested it or heads its unit (or one above), else 404. */
  async own(companyId: string, id: string): Promise<{ row: OpeningRow; head: boolean; requester: boolean }> {
    const { userId } = caller();
    const row = await this.repo.opening(companyId, id);
    if (!row) throw openingNotFound();
    const head = (await this.access.headUnits()).has(row.orgUnitId);
    const requester = row.requestedBy === userId;
    if (!head && !requester) throw openingNotFound();
    return { row, head, requester };
  }

  /** GET /me/recruitment/openings/:id: + history, and — for a head — the applications in the restricted view. */
  async myDetail(id: string): Promise<MyOpeningDetailView> {
    const { companyId, userId } = caller();
    const { row, head } = await this.own(companyId, id);
    const [view] = await this.myViews(companyId, [row], userId, await this.access.headUnits());
    if (!view) throw openingNotFound();
    const history = row.workflowInstanceId ? ((await this.workflow.history([row.workflowInstanceId])).get(row.workflowInstanceId) ?? []) : [];
    return { ...view, history, applications: head ? await this.headApplications(companyId, id) : null };
  }

  /**
   * The head's restricted view (assumption 9): the name, the stage and — while the stage is active — the files; never
   * the NIN, birth data, contact details, salary or HR notes.
   */
  private async headApplications(companyId: string, openingId: string): Promise<HeadApplicationView[]> {
    const rows = await this.candidates.applicationsOfOpening(companyId, openingId);
    const active = rows.filter((r) => isActiveStage(r.stage) && r.candidateId !== null);
    const files = await this.candidates.files(companyId, [...new Set(active.map((r) => r.candidateId as string))]);
    const ref = await this.access.userRefs();
    const { userId } = caller();
    const interviews = await this.interviewReads.load(companyId, rows.map((r) => r.id));
    return rows.map((r) => {
      const stats = this.interviewReads.stats(interviews.get(r.id) ?? [], userId);
      return {
        id: r.id,
        candidate: { lastName: r.lastName, firstName: r.firstName, lastNameAr: r.lastNameAr, firstNameAr: r.firstNameAr },
        stage: r.stage,
        stageSince: r.stageSince.toISOString(),
        files: isActiveStage(r.stage) ? files.filter((f) => f.candidateId === r.candidateId).map((f) => fileView(f, ref, false)) : [],
        average: stats.average,
        interviews: stats.interviews,
      };
    });
  }

  /** POST /me/recruitment/openings/:id/cancel: the requester, while pending. */
  async cancelOwn(id: string): Promise<MyOpeningDetailView> {
    const { companyId, userId } = caller();
    const row = await this.repo.opening(companyId, id);
    if (!row || row.requestedBy !== userId) throw openingNotFound();
    if (row.status !== 'pending' || !row.workflowInstanceId) {
      throw new ProblemException(409, 'recruitment-opening-not-cancellable', 'Only a pending opening request can be cancelled.');
    }
    await this.workflow.cancel(row.workflowInstanceId);
    return this.myDetail(id);
  }

  // ── views ───────────────────────────────────────────────────────────────────────────────────────────────────────

  async openingRef(row: Pick<OpeningRow, 'id' | 'reference' | 'title' | 'orgUnitId' | 'status'>): Promise<OpeningRef> {
    return { id: row.id, reference: row.reference, title: row.title, unit: (await this.access.org()).unitRef(row.orgUnitId), status: row.status };
  }

  private async bases(rows: readonly OpeningRow[], options: { withWorkflow?: boolean } = {}): Promise<Map<string, OpeningBase>> {
    const out = new Map<string, OpeningBase>();
    if (rows.length === 0) return out;
    const withWorkflow = options.withWorkflow !== false;
    const instanceIds = rows.flatMap((r) => (r.workflowInstanceId ? [r.workflowInstanceId] : []));
    const { companyId } = caller();
    const criteria = new Map<string, CriterionRef[]>();
    for (const c of await this.interviews.openingCriteria(companyId, rows.map((r) => r.id))) criteria.set(c.openingId, [...(criteria.get(c.openingId) ?? []), criterionRef(c)]);
    const [org, ref, progress, history] = await Promise.all([
      this.access.org(),
      this.access.userRefs(),
      withWorkflow ? this.workflow.progress(instanceIds) : Promise.resolve([] as WorkflowProgressView[]),
      withWorkflow ? this.workflow.history(instanceIds) : Promise.resolve(new Map<string, TaskHistoryView[]>()),
    ]);
    const progressById = new Map(progress.map((p) => [p.instanceId, p]));
    for (const r of rows) {
      const rejection = r.workflowInstanceId ? (history.get(r.workflowInstanceId) ?? []).find((t) => t.outcome === 'reject') : undefined;
      out.set(r.id, {
        id: r.id,
        reference: r.reference,
        title: r.title,
        unit: org.unitRef(r.orgUnitId),
        site: org.siteRef(r.siteId ?? org.effectiveSite(r.orgUnitId)),
        siteInherited: r.siteId === null,
        contractType: r.contractType,
        posts: r.posts,
        hiredCount: r.hiredCount,
        justification: r.justification,
        targetDate: r.targetDate,
        anemReference: r.anemReference,
        status: r.status,
        requestedAt: r.requestedAt.toISOString(),
        requestedBy: ref(r.requestedBy),
        openedAt: r.openedAt ? r.openedAt.toISOString() : null,
        closed: r.closedAt ? { at: r.closedAt.toISOString(), by: ref(r.closedBy), reason: r.closeReason } : null,
        workflow: r.workflowInstanceId ? (progressById.get(r.workflowInstanceId) ?? null) : null,
        rejectionComment: rejection?.comment ?? null,
        criteria: criteria.get(r.id) ?? [],
      });
    }
    return out;
  }

  /** `_actions` of the HR view: what recruitment.manage over the unit allows in the opening's status. */
  private async actions(row: OpeningRow, evaluated: ReadonlySet<string>): Promise<OpeningAction[]> {
    if (!(await this.access.can(P.manage, row.orgUnitId))) return [];
    if (row.status === 'open') return ['update', 'close', 'add_application', ...(evaluated.has(row.id) ? [] : (['set_criteria'] as const))];
    return row.status === 'closed' && row.hiredCount < row.posts ? ['reopen'] : [];
  }

  async openingViews(companyId: string, rows: readonly OpeningRow[]): Promise<OpeningView[]> {
    const [bases, counts, evaluated] = await Promise.all([
      this.bases(rows),
      this.repo.stageCounts(companyId, rows.map((r) => r.id)),
      this.interviews.openingsWithEvaluations(companyId, rows.filter((r) => r.status === 'open').map((r) => r.id)),
    ]);
    const out: OpeningView[] = [];
    for (const r of rows) {
      const base = bases.get(r.id);
      if (base) out.push({ ...base, counts: counts.get(r.id) ?? emptyCounts(), _actions: await this.actions(r, evaluated) });
    }
    return out;
  }

  async openingView(companyId: string, row: OpeningRow): Promise<OpeningView> {
    const [view] = await this.openingViews(companyId, [row]);
    if (!view) throw openingNotFound();
    return view;
  }

  private async detailOf(companyId: string, id: string): Promise<OpeningDetailView> {
    const row = await this.repo.opening(companyId, id);
    if (!row) throw openingNotFound();
    const view = await this.openingView(companyId, row);
    const history = row.workflowInstanceId ? ((await this.workflow.history([row.workflowInstanceId])).get(row.workflowInstanceId) ?? []) : [];
    return { ...view, history };
  }

  private async myViews(companyId: string, rows: readonly OpeningRow[], userId: string, headUnits: ReadonlySet<string>): Promise<MyOpeningView[]> {
    const headed = rows.filter((r) => headUnits.has(r.orgUnitId));
    const [bases, counts] = await Promise.all([this.bases(rows), this.repo.stageCounts(companyId, headed.map((r) => r.id))]);
    return rows.flatMap((r) => {
      const base = bases.get(r.id);
      if (!base) return [];
      const head = headUnits.has(r.orgUnitId);
      const requester = r.requestedBy === userId;
      const roles: ('requester' | 'head')[] = [...(requester ? (['requester'] as const) : []), ...(head ? (['head'] as const) : [])];
      const stageCounts: StageCounts | null = head ? (counts.get(r.id) ?? emptyCounts()) : null;
      return [{ ...base, roles, counts: stageCounts, _actions: requester && r.status === 'pending' ? (['cancel'] as const).slice() : [] }];
    });
  }

  // ── workflow hooks (inside the request transaction that changes the workflow) ───────────────────────────────────

  /**
   * The manager step: the head (today) of the opening's unit, else of its nearest ancestor that has one, SKIPPING the
   * requester's own employment — a unit head's own request goes to the head above (owner decision 2026-10-07).
   */
  private async resolveManager(id: string): Promise<ManagerCandidate> {
    const { companyId } = caller();
    const row = await this.repo.opening(companyId, id);
    if (!row) return { userId: null, reason: 'no-manager' };
    const requesterEmployment = await this.staffing.linkedEmploymentOf(row.requestedBy);
    const head = await this.staffing.headAtOrAbove(row.orgUnitId, this.clock.today(), requesterEmployment);
    if (!head) return { userId: null, reason: 'no-manager' };
    return head.userId ? { userId: head.userId } : { userId: null, reason: 'manager-not-linked' };
  }

  private async onApproved(context: HookContext): Promise<void> {
    const { companyId } = caller();
    await this.repo.markOpen(companyId, context.subjectId);
    // the company's active criteria become the opening's (adjustable until the first evaluation)
    await this.interviews.copyActiveCriteria(companyId, context.subjectId);
    await this.notifyOutcome('recruitment.opening_approved', context);
  }

  private async onRejected(context: HookContext): Promise<void> {
    const { companyId } = caller();
    await this.repo.markEnded(companyId, context.subjectId, 'rejected');
    await this.notifyOutcome('recruitment.opening_rejected', context);
  }

  private async onCancelled(context: HookContext): Promise<void> {
    const { companyId } = caller();
    await this.repo.markEnded(companyId, context.subjectId, 'cancelled');
  }

  /** The requester (never the actor: the Notifier drops them). */
  private async notifyOutcome(type: NotificationType, context: HookContext): Promise<void> {
    const { companyId } = caller();
    const row = await this.repo.opening(companyId, context.subjectId);
    if (!row) return;
    await this.notifier.notify({
      type,
      subject: { type: SUBJECT, id: row.id },
      data: { ...(await this.notificationData(row.id)), actorName: (await this.workflow.displayName(context.actorUserId)) || null },
      recipients: [{ userId: row.requestedBy, audience: 'requester' }],
    });
  }

  /** "My tasks": everything an approver needs, so a head above (with no permission) needs no other route. */
  private async summaries(subjectIds: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    const { companyId } = caller();
    const rows = await this.repo.openings(companyId, subjectIds);
    const bases = await this.bases(rows, { withWorkflow: false });
    const out = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const b = bases.get(r.id);
      if (!b) continue;
      out.set(r.id, {
        type: SUBJECT,
        id: r.id,
        reference: b.reference,
        title: b.title,
        unit: b.unit,
        site: b.site,
        contractType: b.contractType,
        posts: b.posts,
        justification: b.justification,
        targetDate: b.targetDate,
        requestedBy: b.requestedBy,
      });
    }
    return out;
  }

  /** The post, never a person: no candidate name ever reaches a notification (it would outlive the erasure). */
  private async notificationData(id: string): Promise<NotificationData> {
    const { companyId } = caller();
    const row = await this.repo.opening(companyId, id);
    if (!row) return { openingId: id };
    const unit = (await this.access.org()).unitRef(row.orgUnitId);
    return { openingId: id, reference: row.reference, title: row.title, unitName: unit.name, unitNameAr: unit.nameAr, posts: row.posts };
  }
}
