import { createHash } from 'node:crypto';
import { Inject, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { runInRequestTransaction } from '../../../platform/context/request-transaction.js';
import { KYSELY, type Database } from '../../../platform/db/database.js';
import { ProblemException, ValidationProblemException, type FieldError } from '../../../platform/http/problem-details.js';
import { toFieldErrors } from '../../../platform/http/zod-validation.pipe.js';
import { Notifier, type NotificationData } from '../../../platform/notifications/notifier.js';
import { attachmentDisposition, downloadFilename, EmployeeFileImporter, sanitizeFilename, sniffFileType, type EmployeeFileMime } from '../../documents/index.js';
import {
  bankInputSchema,
  contactInputSchema,
  emergencyInputSchema,
  familyInputSchema,
  PersonalDetailsService,
  type PersonalView,
  type ProfileFacts,
} from '../../employment/index.js';
import { StaffingClock, StaffingService, type EmployeeCard } from '../../staffing/index.js';
import { WorkflowEngine, WorkflowSubjects, type HookContext } from '../../workflow/index.js';
import {
  changedFields,
  COMMENT_MAX,
  familyToApply,
  fileTitle,
  filesRequired,
  IDENTITY_NOTE_MAX,
  isProfileSection,
  maskBankValue,
  maskNin,
  maskRib,
  modeOf,
  PROFILE_PERMISSIONS as P,
  sameSection,
  SUPPORTING_DOCUMENT_CATEGORY,
  workflowOf,
  type BankValues,
  type ContactValues,
  type EmergencyValues,
  type FamilyValues,
  type ProfileSection,
  type RequestStatus,
  type SectionPayload,
} from '../domain/profile.js';
import { ProfileRepository, type FileRow, type RequestRow } from '../infra/profile.repository.js';
import type { FileDownload, MyProfileView, ProfileRequestDetail, ProfileRequestPage, ProfileRequestView } from './profile-views.js';

export interface UploadedRequestFile {
  buffer: Buffer;
  originalname?: string;
}

export interface HrListInput {
  status?: RequestStatus | undefined;
  section?: ProfileSection | undefined;
  unitId?: string | undefined;
  includeSubUnits: boolean;
  q?: string | undefined;
  employmentId?: string | undefined;
  page: number;
  pageSize: number;
}

const notLinked = () => new ProblemException(409, 'profile-not-linked', 'Your account is not linked to an open employment.');
const requestNotFound = () => new NotFoundException('Request not found');
const fileNotFound = () => new NotFoundException('File not found');
const pending = () => new ProblemException(409, 'profile-request-pending', 'A request for this section is already waiting for HR.');

function caller(): { companyId: string; userId: string } {
  const { companyId, userId } = requireContext();
  if (!companyId || !userId) throw new NotFoundException();
  return { companyId, userId };
}

function pgConstraint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The `data` field of POST /me/profile/requests, before the section's own payload schema. */
const envelope = z.object({
  section: z.string(),
  payload: z.unknown(),
  comment: z
    .string()
    .trim()
    .max(COMMENT_MAX, { message: `At most ${COMMENT_MAX} characters` })
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
});

const identityNoteSchema = z.object({
  note: z.string().trim().min(1, { message: 'Required' }).max(IDENTITY_NOTE_MAX, { message: `At most ${IDENTITY_NOTE_MAX} characters` }),
});

/** A section's current values (what `before` records and `changedSince` compares with). */
function sectionValues(section: ProfileSection, facts: Pick<ProfileFacts, 'personal' | 'bank'>): unknown {
  const p = facts.personal;
  switch (section) {
    case 'contact': {
      const { updatedAt: _u, ...contact } = p.contact;
      return contact;
    }
    case 'emergency':
      return p.emergencyContact;
    case 'family':
      return p.family;
    case 'bank':
      return { rib: facts.bank.rib, bankName: facts.bank.bankName };
    case 'identity_note':
      return null;
  }
}

function personOf(card: EmployeeCard) {
  return { lastName: card.person.lastName, firstName: card.person.firstName, lastNameAr: card.person.lastNameAr, firstNameAr: card.person.firstNameAr };
}

/**
 * Self-service profile changes (docs/contracts/profile-changes.md › Self-service requests): an employee changes one
 * section of their own personal details — applied at once (immediate sections) or sent to HR through the workflow
 * engine (`profile.hr` / `profile.bank`) with 0–3 supporting files; APPROVING applies the request's values in the same
 * transaction through the Employment use cases and copies the files into the employee file (« Pièces justificatives »).
 * Also the HR list / detail, the file downloads and the `profile_change_request` subject hooks.
 */
@Injectable()
export class ProfileRequestsService implements OnModuleInit {
  constructor(
    private readonly repo: ProfileRepository,
    private readonly personal: PersonalDetailsService,
    private readonly staffing: StaffingService,
    private readonly clock: StaffingClock,
    private readonly scopes: ScopeService,
    private readonly engine: WorkflowEngine,
    private readonly subjects: WorkflowSubjects,
    private readonly notifier: Notifier,
    private readonly audit: AuditEvents,
    private readonly importer: EmployeeFileImporter,
    @Inject(KYSELY) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.subjects.register('profile_change_request', {
      // the definitions have no manager step
      resolveManager: () => Promise.resolve({ userId: null, reason: 'no-manager' }),
      onApproved: (c) => this.onApproved(c),
      onRejected: (c) => this.onRejected(c),
      onCancelled: (c) => this.onCancelled(c),
      summaries: (ids) => this.summaries(ids),
      notificationData: (id) => this.notificationData(id),
    });
  }

  // ── self-service ────────────────────────────────────────────────────────────────────────────────────────────────

  /** The caller's linked OPEN employment (end date unset), else 409 profile-not-linked. */
  private async ownEmployment(): Promise<ProfileFacts> {
    const { userId } = caller();
    const employmentId = await this.staffing.linkedEmploymentOf(userId);
    if (!employmentId) throw notLinked();
    const facts = await this.personal.profileFacts(employmentId);
    if (facts.endDate !== null) throw notLinked();
    return facts;
  }

  /** GET /me/profile. */
  async myProfile(): Promise<MyProfileView> {
    const { companyId } = caller();
    const facts = await this.ownEmployment();
    const [policy, requests] = await Promise.all([this.repo.policy(companyId), this.repo.requestsOf(companyId, facts.employmentId, 'pending')]);
    return {
      employee: { id: facts.employmentId, matricule: facts.matricule, person: facts.person, unit: facts.unit, jobTitle: facts.jobTitle, hireDate: facts.hireDate },
      identity: { birthDate: facts.identity.birthDate, birthPlace: facts.identity.birthPlace, nationality: facts.identity.nationality, ninMasked: maskNin(facts.identity.nin) },
      personal: facts.personal,
      bank: { ribMasked: maskRib(facts.bank.rib), bankName: facts.bank.bankName },
      modes: policy.modes,
      pending: requests.map((r) => ({ id: r.id, section: r.section, requestedAt: r.requestedAt.toISOString() })),
    };
  }

  /** GET /me/profile/requests. */
  async myRequests(status: RequestStatus | undefined): Promise<{ items: ProfileRequestView[] }> {
    const { companyId } = caller();
    const facts = await this.ownEmployment();
    const rows = await this.repo.requestsOf(companyId, facts.employmentId, status);
    return { items: await this.views(companyId, rows, { own: true }) };
  }

  /**
   * POST /me/profile/requests. The route has no request transaction (@SkipTransaction: the multipart body is read
   * first); the use case runs in its own transaction with the request's tenant, user and request id.
   */
  submit(rawData: unknown, files: readonly UploadedRequestFile[]): Promise<ProfileRequestView> {
    const { requestId, userId, companyId } = requireContext();
    return runInRequestTransaction(this.db, { requestId, userId, companyId }, () => this.submitInTx(rawData, files));
  }

  private async submitInTx(rawData: unknown, files: readonly UploadedRequestFile[]): Promise<ProfileRequestView> {
    const { companyId, userId } = caller();
    const input = parseData(rawData);
    const facts = await this.ownEmployment();
    const before = sectionValues(input.section, facts);
    const errors: FieldError[] = [];
    if (input.section === 'family') {
      for (const e of await this.personal.familyProblems(facts.employmentId, input.payload)) errors.push({ ...e, field: `payload.${e.field}` });
    }
    if (errors.length) throw new ValidationProblemException(errors);
    const changed = changedFields(input.section, before, input.payload);
    if (changed.length === 0) throw new ValidationProblemException([{ field: 'payload', code: 'unchanged', message: 'Nothing differs from the current values.' }]);

    const policy = await this.repo.policy(companyId);
    const mode = modeOf(input.section, policy.modes);
    const sniffed = sniffFiles(files);
    if (mode === 'immediate' && files.length > 0) {
      throw new ValidationProblemException([{ field: 'files', code: 'not_accepted', message: 'This change applies at once: no supporting document is needed.' }]);
    }
    if (mode === 'approval' && filesRequired(input.section, changed) && files.length === 0) {
      throw new ValidationProblemException([{ field: 'files', code: 'required', message: 'A supporting document (PDF, JPEG or PNG) is required for this change.' }]);
    }
    if ((await this.repo.requestsOf(companyId, facts.employmentId, 'pending')).some((r) => r.section === input.section)) throw pending();

    let id: string;
    try {
      id = await this.repo.insertRequest(companyId, {
        employmentId: facts.employmentId,
        personId: facts.personId,
        section: input.section,
        status: mode === 'immediate' ? 'applied' : 'pending',
        payload: input.payload ?? {},
        before,
        comment: input.comment,
        requestedBy: userId,
      });
    } catch (error) {
      if (pgConstraint(error) === 'profile_change_request_one_pending_uk') throw pending();
      throw error;
    }

    if (mode === 'immediate') {
      await this.apply(facts.employmentId, input, userId);
      await this.audit.record({ type: 'profile.applied', subject: { type: 'profile_change_request', id }, data: { section: input.section, employmentId: facts.employmentId, via: 'immediate', fields: changed } });
      return this.view(companyId, id, { own: true });
    }

    for (const file of sniffed) await this.repo.insertFile(companyId, id, file);
    const definitionId = await this.repo.definitionId(companyId, workflowOf(input.section));
    if (!definitionId) throw new Error(`workflow definition ${workflowOf(input.section)} missing`);
    if (!facts.unit.id) throw new ProblemException(409, 'profile-not-linked', 'Your employment has no unit today.');
    const instanceId = await this.engine.start({ definitionId, subjectType: 'profile_change_request', subjectId: id, scopeUnitId: facts.unit.id, subjectUserId: userId });
    await this.repo.setInstance(companyId, id, instanceId);
    await this.audit.record({
      type: 'profile.requested',
      subject: { type: 'profile_change_request', id },
      data: { section: input.section, employmentId: facts.employmentId, fields: changed, files: sniffed.length },
    });
    return this.view(companyId, id, { own: true });
  }

  /** POST /me/profile/requests/:id/cancel — own pending request only. */
  async cancel(id: string): Promise<ProfileRequestView> {
    const { companyId } = caller();
    const facts = await this.ownEmployment();
    const request = await this.repo.request(companyId, id);
    if (!request || request.employmentId !== facts.employmentId) throw requestNotFound();
    if (request.status !== 'pending' || !request.workflowInstanceId) {
      throw new ProblemException(409, 'profile-not-cancellable', 'Only a pending request can be cancelled.');
    }
    await this.engine.cancel(request.workflowInstanceId);
    return this.view(companyId, id, { own: true });
  }

  /** GET /me/profile/requests/:id/files/:fileId — the requester's own file, while the request is pending. */
  async myFile(id: string, fileId: string): Promise<FileDownload> {
    const { companyId } = caller();
    const facts = await this.ownEmployment();
    const request = await this.repo.request(companyId, id);
    if (!request || request.employmentId !== facts.employmentId || request.status !== 'pending') throw fileNotFound();
    return this.download(companyId, request, fileId, 'self');
  }

  // ── HR ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** GET /profile/requests: employee.personal.read scope (bank requests: employee.bank.read scope too). */
  async list(input: HrListInput): Promise<ProfileRequestPage> {
    const { companyId } = caller();
    const { rows, total } = await this.repo.list(companyId, {
      scope: await this.scopes.scopeOf(P.personalRead),
      bankScope: await this.scopes.scopeOf(P.bankRead),
      today: this.clock.today(),
      status: input.status,
      section: input.section,
      unitId: input.unitId,
      includeSubUnits: input.includeSubUnits,
      q: input.q,
      employmentId: input.employmentId,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });
    return { items: await this.views(companyId, rows, { own: false }), total, page: input.page, pageSize: input.pageSize };
  }

  /** GET /profile/requests/:id — a candidate of the open task, or personal.read (bank: bank.read) over the employee. */
  async detail(id: string): Promise<ProfileRequestDetail> {
    const { companyId } = caller();
    const request = await this.readable(companyId, id);
    const view = await this.view(companyId, request.id, { own: false });
    const history = request.workflowInstanceId ? ((await this.engine.history([request.workflowInstanceId])).get(request.workflowInstanceId) ?? []) : [];
    return { ...view, history };
  }

  /** GET /profile/requests/:id/files/:fileId — the detail's readers who are task candidates or hold employee_file.read. */
  async hrFile(id: string, fileId: string): Promise<FileDownload> {
    const { companyId } = caller();
    const request = await this.readable(companyId, id);
    const candidate = await this.isCandidate(request);
    if (!candidate) {
      const unitId = await this.unitOf(request.employmentId);
      if (!unitId || !(await this.scopes.inScope(P.fileRead, unitId))) throw fileNotFound();
    }
    return this.download(companyId, request, fileId, 'hr');
  }

  private async isCandidate(request: RequestRow): Promise<boolean> {
    return request.status === 'pending' && request.workflowInstanceId !== null && (await this.engine.isCandidate(request.workflowInstanceId));
  }

  private async unitOf(employmentId: string): Promise<string | undefined> {
    return (await this.staffing.cards([employmentId])).get(employmentId)?.unit.id;
  }

  /** The request when the caller may read it (else 404). */
  private async readable(companyId: string, id: string): Promise<RequestRow> {
    const request = await this.repo.request(companyId, id);
    if (!request) throw requestNotFound();
    if (await this.isCandidate(request)) return request;
    const unitId = await this.unitOf(request.employmentId);
    if (!unitId || !(await this.scopes.inScope(P.personalRead, unitId))) throw requestNotFound();
    if (request.section === 'bank' && !(await this.scopes.inScope(P.bankRead, unitId))) throw requestNotFound();
    return request;
  }

  private async download(companyId: string, request: RequestRow, fileId: string, via: 'self' | 'hr'): Promise<FileDownload> {
    const file = (await this.repo.files(companyId, [request.id])).find((f) => f.id === fileId);
    if (!file || !file.hasContent) throw fileNotFound();
    const bytes = await this.repo.content(companyId, fileId);
    if (!bytes) throw fileNotFound();
    await this.audit.record({ type: 'profile.file_downloaded', subject: { type: 'profile_change_request', id: request.id }, data: { fileId, via } });
    return { bytes, mime: file.mime, disposition: attachmentDisposition(downloadFilename(file.originalFilename, file.mime)), sha256: file.sha256 };
  }

  // ── applying ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async apply(employmentId: string, input: SectionPayload, actorUserId: string): Promise<void> {
    const actor = { userId: actorUserId };
    switch (input.section) {
      case 'contact':
        await this.personal.applyContact(employmentId, input.payload, actor);
        return;
      case 'emergency':
        await this.personal.applyEmergency(employmentId, input.payload, actor);
        return;
      case 'family': {
        const current = await this.personal.personalOf(employmentId);
        await this.personal.applyFamily(employmentId, familyToApply(input.payload, new Set(current.family.children.map((c) => c.id))), actor);
        return;
      }
      case 'bank':
        await this.personal.applyBank(employmentId, { rib: input.payload.rib ?? '', bankName: input.payload.bankName ?? '' }, actor);
        return;
      case 'identity_note':
        return;
    }
  }

  // ── workflow hooks (inside the approval / rejection / cancellation transaction) ────────────────────────────────

  /** Approved: apply the request's values as of now, copy its files into the employee file, tell the employee. */
  private async onApproved(context: HookContext): Promise<void> {
    const { companyId } = caller();
    const request = await this.repo.request(companyId, context.subjectId, { lock: true });
    if (!request) throw requestNotFound();
    await this.apply(request.employmentId, { section: request.section, payload: request.payload } as SectionPayload, context.actorUserId);
    const files = await this.repo.files(companyId, [request.id]);
    const withBytes: { file: FileRow; content: Buffer }[] = [];
    for (const file of files) {
      const content = file.hasContent ? await this.repo.content(companyId, file.id) : null;
      if (content) withBytes.push({ file, content });
    }
    const copies = await this.importer.copyEach(
      request.employmentId,
      withBytes.map(({ file, content }) => ({ title: fileTitle(request.section, request.requestedAt.toISOString()), originalFilename: file.originalFilename, mime: file.mime, content })),
      SUPPORTING_DOCUMENT_CATEGORY,
    );
    for (const [i, copy] of copies.entries()) {
      const file = withBytes[i]?.file;
      if (file) await this.repo.setEmployeeFile(companyId, file.id, copy.employeeFileId);
    }
    await this.repo.decide(companyId, request.id, 'approved');
    await this.audit.record({
      type: 'profile.applied',
      subject: { type: 'profile_change_request', id: request.id },
      data: { section: request.section, employmentId: request.employmentId, via: 'approval', fields: changedFields(request.section, request.before, request.payload), files: copies.length },
    });
    // a bank change: the security notice only (always e-mailed); anything else: change_approved
    await this.notifyEmployee(request, request.section === 'bank' ? 'profile.bank_changed' : 'profile.change_approved', context.actorUserId);
  }

  private async onRejected(context: HookContext): Promise<void> {
    const { companyId } = caller();
    const request = await this.repo.request(companyId, context.subjectId, { lock: true });
    if (!request) throw requestNotFound();
    await this.repo.decide(companyId, request.id, 'rejected');
    await this.notifyEmployee(request, 'profile.change_rejected', context.actorUserId);
  }

  private async onCancelled(context: HookContext): Promise<void> {
    const { companyId } = caller();
    await this.repo.decide(companyId, context.subjectId, 'cancelled');
    await this.audit.record({ type: 'profile.cancelled', subject: { type: 'profile_change_request', id: context.subjectId }, data: {} });
  }

  private async notifyEmployee(request: RequestRow, type: 'profile.change_approved' | 'profile.change_rejected' | 'profile.bank_changed', actorUserId: string): Promise<void> {
    const employeeUser = (await this.staffing.linkedUsersOf([request.employmentId])).get(request.employmentId) ?? null;
    await this.notifier.notify({
      type,
      subject: { type: 'profile_change_request', id: request.id },
      data: { ...(await this.notificationData(request.id)), actorName: (await this.engine.displayName(actorUserId)) || null },
      recipients: [{ userId: employeeUser, audience: 'employee' }],
    });
  }

  /** "My tasks": {type, employee, section, changedFields, changedSince, files, requestedAt} — never a value. */
  private async summaries(ids: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    const { companyId } = caller();
    const rows = await this.repo.requests(companyId, ids);
    const [cards, files] = await Promise.all([this.staffing.cards(rows.map((r) => r.employmentId)), this.repo.files(companyId, rows.map((r) => r.id))]);
    const out = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const card = cards.get(r.employmentId);
      out.set(r.id, {
        type: 'profile_change',
        employee: card ? { id: card.id, matricule: card.matricule, person: personOf(card), unit: card.unit } : null,
        section: r.section,
        changedFields: changedFields(r.section, r.before, r.payload),
        changedSince: r.status === 'pending' ? await this.changedSince(r) : false,
        files: files.filter((f) => f.requestId === r.id).length,
        requestedAt: r.requestedAt.toISOString(),
      });
    }
    return out;
  }

  /** Names and the section — never a value. */
  private async notificationData(requestId: string): Promise<NotificationData> {
    const { companyId } = caller();
    const request = await this.repo.request(companyId, requestId);
    if (!request) return { requestId };
    const person = (await this.staffing.cards([request.employmentId])).get(request.employmentId)?.person;
    return {
      requestId,
      employmentId: request.employmentId,
      employeeName: person ? `${person.firstName} ${person.lastName}` : null,
      employeeNameAr: person?.firstNameAr && person.lastNameAr ? `${person.firstNameAr} ${person.lastNameAr}` : null,
      section: request.section,
    };
  }

  // ── views ───────────────────────────────────────────────────────────────────────────────────────────────────────

  private async changedSince(request: RequestRow, current?: PersonalView, bank?: ProfileFacts['bank']): Promise<boolean> {
    if (request.section === 'identity_note') return false;
    const facts = current && bank ? { personal: current, bank } : await this.personal.profileFacts(request.employmentId);
    return !sameSection(request.section, request.before, sectionValues(request.section, facts));
  }

  private async view(companyId: string, id: string, options: { own: boolean }): Promise<ProfileRequestView> {
    const row = await this.repo.request(companyId, id);
    if (!row) throw requestNotFound();
    const [view] = await this.views(companyId, [row], options);
    if (!view) throw requestNotFound();
    return view;
  }

  /** `own`: the requester's views (its own values, cancel action); else HR (bank values masked without bank.read). */
  private async views(companyId: string, rows: readonly RequestRow[], options: { own: boolean }): Promise<ProfileRequestView[]> {
    if (rows.length === 0) return [];
    const instanceIds = rows.flatMap((r) => (r.workflowInstanceId ? [r.workflowInstanceId] : []));
    const [cards, files, progress, history] = await Promise.all([
      this.staffing.cards(rows.map((r) => r.employmentId)),
      this.repo.files(companyId, rows.map((r) => r.id)),
      this.engine.progress(instanceIds),
      this.engine.history(instanceIds),
    ]);
    const progressById = new Map(progress.map((p) => [p.instanceId, p]));
    const out: ProfileRequestView[] = [];
    for (const r of rows) {
      const card = cards.get(r.employmentId);
      if (!card) continue;
      const showBank = options.own || (await this.scopes.inScope(P.bankRead, card.unit.id));
      const mask = (v: unknown) => (r.section === 'bank' && !showBank ? maskBankValue(v) : v);
      // the requester sees the RIB it typed, never the full one on record (« Mon profil » shows it masked)
      const maskBefore = (v: unknown) => (r.section === 'bank' && (options.own || !showBank) ? maskBankValue(v) : v);
      const rejection = r.workflowInstanceId ? (history.get(r.workflowInstanceId) ?? []).find((t) => t.outcome === 'reject') : undefined;
      out.push({
        id: r.id,
        section: r.section,
        status: r.status,
        employee: { id: card.id, matricule: card.matricule, person: personOf(card), unit: { id: card.unit.id, code: card.unit.code, name: card.unit.name, nameAr: card.unit.nameAr, kind: card.unit.kind } },
        payload: mask(r.payload),
        before: maskBefore(r.before),
        changedFields: changedFields(r.section, r.before, r.payload),
        changedSince: r.status === 'pending' ? await this.changedSince(r) : false,
        comment: r.employeeComment,
        files: files
          .filter((f) => f.requestId === r.id)
          .map((f) => ({ id: f.id, filename: f.originalFilename, mime: f.mime, sizeBytes: f.sizeBytes, purged: !f.hasContent })),
        requestedAt: r.requestedAt.toISOString(),
        decidedAt: iso(r.decidedAt),
        workflow: r.workflowInstanceId ? (progressById.get(r.workflowInstanceId) ?? null) : null,
        rejectionComment: rejection?.comment ?? null,
        _actions: options.own && r.status === 'pending' ? ['cancel'] : [],
      });
    }
    return out;
  }
}

// ── input parsing ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The `data` field: JSON `{section, payload, comment?}`, the payload validated by the section's schema. */
export function parseData(raw: unknown): SectionPayload & { comment: string | null } {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ValidationProblemException([{ field: 'data', code: 'invalid_json', message: 'The field `data` must be JSON {section, payload, comment?}.' }]);
    }
  }
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new ValidationProblemException([{ field: 'data', code: 'required', message: 'The field `data` (JSON {section, payload, comment?}) is required.' }]);
  }
  const outer = envelope.safeParse(value);
  if (!outer.success) throw new ValidationProblemException(toFieldErrors(outer.error.issues));
  const { section, payload, comment } = outer.data;
  if (!isProfileSection(section)) {
    throw new ValidationProblemException([{ field: 'section', code: 'invalid_value', message: 'One of contact, emergency, family, bank, identity_note.' }]);
  }
  const parse = <S extends z.ZodType>(schema: S): z.output<S> => {
    const result = schema.safeParse(payload);
    if (!result.success) throw new ValidationProblemException(toFieldErrors(result.error.issues, 'payload'));
    return result.data;
  };
  switch (section) {
    case 'contact':
      return { section, payload: parse(contactInputSchema) as ContactValues, comment };
    case 'emergency':
      return { section, payload: parse(emergencyInputSchema.nullable()) as EmergencyValues | null, comment };
    case 'family':
      return { section, payload: parse(familyInputSchema) as FamilyValues, comment };
    case 'bank':
      return { section, payload: parse(bankInputSchema) as BankValues, comment };
    case 'identity_note':
      return { section, payload: parse(identityNoteSchema), comment };
  }
}

/** Every file sniffed (PDF / JPEG / PNG on the content), its name sanitised; errors as `files.<i>`. */
function sniffFiles(files: readonly UploadedRequestFile[]): { originalFilename: string; mime: EmployeeFileMime; sha256: Buffer; content: Buffer }[] {
  const errors: FieldError[] = [];
  const out: { originalFilename: string; mime: EmployeeFileMime; sha256: Buffer; content: Buffer }[] = [];
  files.forEach((file, i) => {
    if (file.buffer.length === 0) {
      errors.push({ field: `files.${i}`, code: 'empty', message: 'The file is empty.' });
      return;
    }
    const mime = sniffFileType(file.buffer);
    if (!mime) {
      errors.push({ field: `files.${i}`, code: 'unsupported_type', message: 'PDF, JPEG or PNG only (checked on the content).' });
      return;
    }
    out.push({ originalFilename: sanitizeFilename(file.originalname), mime, sha256: createHash('sha256').update(file.buffer).digest(), content: file.buffer });
  });
  if (errors.length) throw new ValidationProblemException(errors);
  return out;
}
