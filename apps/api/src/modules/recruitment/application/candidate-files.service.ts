import { createHash } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { runInRequestTransaction } from '../../../platform/context/request-transaction.js';
import { KYSELY, type Database } from '../../../platform/db/database.js';
import { ProblemException, ValidationProblemException, type FieldError } from '../../../platform/http/problem-details.js';
import { attachmentDisposition, downloadFilename, sanitizeFilename, sniffFileType, type EmployeeFileMime, type UploadedFile } from '../../documents/index.js';
import { isActiveStage, MAX_FILES_PER_CANDIDATE, type FileKind } from '../domain/rules.js';
import { CandidatesRepository, type FileRow } from '../infra/candidates.repository.js';
import { InterviewsRepository } from '../infra/interviews.repository.js';
import { constraintOf } from '../infra/recruitment.repository.js';
import { ApplicationsService } from './applications.service.js';
import { caller, RecruitmentAccess } from './recruitment-access.js';
import type { CandidateFileView } from './recruitment-views.js';
import { fileView } from './view-helpers.js';

export interface FileDownload {
  bytes: Buffer;
  mime: EmployeeFileMime;
  disposition: string;
  sha256: string;
}

const fileNotFound = () => new NotFoundException('File not found');
const duplicate = () =>
  new ProblemException(409, 'recruitment-file-duplicate', 'This file is already attached to this candidate.', [
    { field: 'file', code: 'duplicate', message: 'The same file is already attached to this candidate.' },
  ]);

/**
 * Candidate files (docs/contracts/recruitment.md › Candidate files): a parallel table to the employee file, with the
 * SAME validation and download rules — the pieces come from the Documents module (bounded multipart outside the
 * request transaction, type by content, sanitised UTF-8 names, attachment + nosniff + sandbox CSP + no-store, the
 * extension following the sniffed type). Deleting is a hard delete: nothing about a candidate outlives the erasure.
 * Every download is audited (`recruitment.file_downloaded {kind, via}` — never the name or the hash).
 */
@Injectable()
export class CandidateFilesService {
  constructor(
    private readonly repo: CandidatesRepository,
    private readonly interviews: InterviewsRepository,
    private readonly applications: ApplicationsService,
    private readonly access: RecruitmentAccess,
    private readonly audit: AuditEvents,
    @Inject(KYSELY) private readonly db: Database,
  ) {}

  /**
   * POST /recruitment/candidates/:id/files. The route has no request transaction (@SkipTransaction): the multipart
   * body is read (bounded by EMPLOYEE_FILE_MAX_BYTES) before any database connection is taken; this use case then
   * runs in its own transaction with the request's tenant, user and request id (RLS and the audit trigger apply).
   */
  upload(candidateId: string, input: { kind: FileKind; title: string }, file: UploadedFile | undefined): Promise<CandidateFileView> {
    const { requestId, userId, companyId } = requireContext();
    return runInRequestTransaction(this.db, { requestId, userId, companyId }, () => this.uploadInTx(candidateId, input, file));
  }

  private async uploadInTx(candidateId: string, input: { kind: FileKind; title: string }, file: UploadedFile | undefined): Promise<CandidateFileView> {
    const { companyId, userId } = caller();
    await this.applications.manageableCandidate(companyId, candidateId, { lock: true });

    const errors: FieldError[] = [];
    let mime: EmployeeFileMime | null = null;
    if (!file) errors.push({ field: 'file', code: 'required', message: 'A PDF, JPEG or PNG file is required.' });
    else if (file.buffer.length === 0) errors.push({ field: 'file', code: 'empty', message: 'The file is empty.' });
    else {
      mime = sniffFileType(file.buffer);
      if (!mime) errors.push({ field: 'file', code: 'unsupported_type', message: 'PDF, JPEG or PNG only (checked on the content).' });
    }
    if (errors.length || !file || !mime) throw new ValidationProblemException(errors);

    if ((await this.repo.fileCount(companyId, candidateId)) >= MAX_FILES_PER_CANDIDATE) {
      throw new ProblemException(409, 'recruitment-file-limit', `A candidate holds at most ${MAX_FILES_PER_CANDIDATE} files.`);
    }
    const sha256 = createHash('sha256').update(file.buffer).digest();
    if (await this.repo.duplicateFile(companyId, candidateId, sha256)) throw duplicate();
    let id: string;
    try {
      id = await this.repo.insertFile(companyId, {
        candidateId,
        kind: input.kind,
        title: input.title,
        originalFilename: sanitizeFilename(file.originalname),
        mime,
        sha256,
        uploadedBy: userId,
        content: file.buffer,
      });
    } catch (error) {
      if (constraintOf(error) === 'recruitment_candidate_file_sha_uk') throw duplicate();
      throw error;
    }
    const row = await this.repo.file(companyId, id);
    if (!row) throw fileNotFound();
    return fileView(row, await this.access.userRefs(), true);
  }

  private async download(companyId: string, file: FileRow, via: 'hr' | 'head' | 'interviewer'): Promise<FileDownload> {
    const bytes = await this.repo.content(companyId, file.id);
    if (!bytes) throw fileNotFound();
    await this.audit.record({ type: 'recruitment.file_downloaded', subject: { type: 'recruitment_candidate', id: file.candidateId }, data: { kind: file.kind, via } });
    return { bytes, mime: file.mime, disposition: attachmentDisposition(downloadFilename(file.originalFilename, file.mime)), sha256: file.sha256 };
  }

  /** GET /recruitment/candidates/:id/files/:fileId/content (recruitment.read over one of its applications' units). */
  async content(candidateId: string, fileId: string): Promise<FileDownload> {
    const { companyId } = caller();
    await this.applications.candidate(companyId, candidateId);
    const file = await this.repo.file(companyId, fileId);
    if (!file || file.candidateId !== candidateId) throw fileNotFound();
    return this.download(companyId, file, 'hr');
  }

  /**
   * GET /me/recruitment/applications/:id/files/:fileId/content: a head of the opening's unit (or of a unit above it),
   * or an interviewer of a scheduled interview of the application — while the application is in an ACTIVE stage, for a
   * file of its candidate; anything else is 404.
   */
  async headContent(applicationId: string, fileId: string): Promise<FileDownload> {
    const { companyId, userId } = caller();
    const application = await this.repo.application(companyId, applicationId);
    if (!application || application.candidateId === null || !isActiveStage(application.stage)) throw fileNotFound();
    const head = (await this.access.headUnits()).has(application.unitId);
    if (!head && !(await this.interviews.isInterviewerOf(companyId, applicationId, userId))) throw fileNotFound();
    const file = await this.repo.file(companyId, fileId);
    if (!file || file.candidateId !== application.candidateId) throw fileNotFound();
    return this.download(companyId, file, head ? 'head' : 'interviewer');
  }

  /** DELETE /recruitment/candidates/:id/files/:fileId → the row and its bytes are gone. */
  async delete(candidateId: string, fileId: string): Promise<void> {
    const { companyId } = caller();
    await this.applications.manageableCandidate(companyId, candidateId);
    const file = await this.repo.file(companyId, fileId);
    if (!file || file.candidateId !== candidateId) throw fileNotFound();
    await this.repo.deleteFile(companyId, fileId);
  }
}
