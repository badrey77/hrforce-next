import { createHash } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { runInRequestTransaction } from '../../../platform/context/request-transaction.js';
import { KYSELY, type Database } from '../../../platform/db/database.js';
import { ProblemException, ValidationProblemException, type FieldError } from '../../../platform/http/problem-details.js';
import {
  attachmentDisposition,
  downloadFilename,
  EMPLOYEE_FILE_PERMISSIONS as F,
  permissionsFor,
  sanitizeFilename,
  sniffFileType,
  type EmployeeFileMime,
} from '../domain/employee-files.js';
import { EmployeeFilesRepository, type CategoryRow, type EmploymentRef, type FileRow } from '../infra/employee-files.repository.js';
import { pgError } from '../infra/documents.repository.js';
import { DocumentsClock } from './documents-clock.js';
import { caller } from './documents.service.js';
import type { EmployeeFileListView, EmployeeFileView } from './employee-file-views.js';

export interface UploadInput {
  categoryId: string;
  title: string;
  documentDate: string | null;
  expiresOn: string | null;
}

export interface UploadedFile {
  buffer: Buffer;
  originalname?: string;
}

export interface FileDownload {
  bytes: Buffer;
  mime: EmployeeFileMime;
  disposition: string;
  sha256: string;
}

const employeeNotFound = () => new NotFoundException('Employee not found');
const fileNotFound = () => new NotFoundException('File not found');
const duplicate = () =>
  new ProblemException(409, 'employee-file-duplicate', 'This file is already in the employee file.', [
    { field: 'file', code: 'duplicate', message: 'The same file is already attached to this employee.' },
  ]);

/**
 * The employee file (docs/contracts/documents.md › Phase B): list, upload, download, delete. Scope: the EMPLOYEE's
 * scope unit today — out of `employee_file.read` scope (or unknown, or another company) → 404; readable but outside the
 * action's permission → 403 `forbidden-scope`. Medical files need employee.medical.read to be seen at all (else they
 * are absent and their ids answer 404) and employee.medical.update to be added or deleted (403 `forbidden-field`).
 * A request on an employment shows the files of that employment and of the person's earlier ones (rehire).
 */
@Injectable()
export class EmployeeFilesService {
  constructor(
    private readonly repo: EmployeeFilesRepository,
    private readonly scopes: ScopeService,
    private readonly clock: DocumentsClock,
    private readonly audit: AuditEvents,
    @Inject(KYSELY) private readonly db: Database,
  ) {}

  private async can(permissions: readonly string[], unitId: string): Promise<boolean> {
    for (const code of permissions) if (!(await this.scopes.inScope(code, unitId))) return false;
    return true;
  }

  /** The employment when `permission` covers its scope unit; 403 when only employee_file.read does; else 404. */
  private async employment(companyId: string, employmentId: string, permission: string): Promise<EmploymentRef> {
    const employment = await this.repo.employment(companyId, employmentId, this.clock.today());
    if (!employment) throw employeeNotFound();
    if (await this.scopes.inScope(permission, employment.unitId)) return employment;
    if (permission !== F.read && (await this.scopes.inScope(F.read, employment.unitId))) {
      throw new ProblemException(403, 'forbidden-scope', `You cannot do this for this employee (outside your ${permission} scope).`);
    }
    throw employeeNotFound();
  }

  /** A file of the request's file set that the caller may see (medical ones need employee.medical.read), else 404. */
  private async visibleFile(companyId: string, employment: EmploymentRef, fileId: string): Promise<FileRow> {
    const file = await this.repo.file(companyId, fileId);
    if (!file || !(await this.repo.fileSet(companyId, employment)).includes(file.employmentId)) throw fileNotFound();
    if (!(await this.can(permissionsFor('read', file.accessClass), employment.unitId))) throw fileNotFound();
    return file;
  }

  private async views(companyId: string, rows: readonly FileRow[], unitId: string): Promise<EmployeeFileView[]> {
    if (rows.length === 0) return [];
    const [names, categories] = await Promise.all([this.repo.names(companyId), this.repo.categories(companyId)]);
    const byId = new Map(categories.map((c) => [c.id, c]));
    const deletable = { standard: await this.can(permissionsFor('delete', 'standard'), unitId), medical: await this.can(permissionsFor('delete', 'medical'), unitId) };
    const ref = (id: string | null) => (id ? { id, displayName: names.get(id) ?? id } : null);
    return rows.map((f) => {
      const category = byId.get(f.categoryId);
      return {
        id: f.id,
        employmentId: f.employmentId,
        category: {
          id: f.categoryId,
          code: f.categoryCode,
          labels: category ? { fr: category.nameFr, ar: category.nameAr, en: category.nameEn } : { fr: f.categoryCode, ar: f.categoryCode, en: f.categoryCode },
          accessClass: f.accessClass,
        },
        title: f.title,
        originalFilename: f.originalFilename,
        mime: f.mime,
        sizeBytes: f.sizeBytes,
        sha256: f.sha256,
        documentDate: f.documentDate,
        expiresOn: f.expiresOn,
        uploadedAt: f.uploadedAt,
        uploadedBy: ref(f.uploadedBy),
        deleted: f.deletedAt ? { at: f.deletedAt, by: ref(f.deletedBy), reason: f.deleteReason ?? '' } : null,
        purgedAt: f.purgedAt,
        _actions: !f.deletedAt && !f.purgedAt && deletable[f.accessClass] ? ['delete'] : [],
      };
    });
  }

  // ── list ────────────────────────────────────────────────────────────────────────────────────────────────────────

  async list(employmentId: string, query: { categoryId?: string | undefined; includeDeleted: boolean }): Promise<EmployeeFileListView> {
    const { companyId } = caller();
    const employment = await this.employment(companyId, employmentId, F.read);
    const unitId = employment.unitId;
    const includeMedical = await this.can(permissionsFor('read', 'medical'), unitId);
    const includeDeleted = query.includeDeleted && (await this.scopes.inScope(F.delete, unitId));
    const rows = await this.repo.files(companyId, await this.repo.fileSet(companyId, employment), { categoryId: query.categoryId, includeDeleted, includeMedical });
    const actions: ('upload' | 'upload_medical')[] = [];
    if (await this.can(permissionsFor('upload', 'standard'), unitId)) actions.push('upload');
    if (await this.can(permissionsFor('upload', 'medical'), unitId)) actions.push('upload_medical');
    return { items: await this.views(companyId, rows, unitId), _redacted: includeMedical ? [] : ['medical'], _actions: actions };
  }

  // ── upload ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * POST /employees/:id/files. The route has no request transaction (@SkipTransaction): the multipart body is read
   * (bounded by EMPLOYEE_FILE_MAX_BYTES) before any database connection is taken; this use case then runs in its own
   * transaction with the request's tenant, user and request id (RLS and the audit trigger apply as usual).
   */
  upload(employmentId: string, input: UploadInput, file: UploadedFile | undefined): Promise<EmployeeFileView> {
    const { requestId, userId, companyId } = requireContext();
    return runInRequestTransaction(this.db, { requestId, userId, companyId }, () => this.uploadInTx(employmentId, input, file));
  }

  private async uploadInTx(employmentId: string, input: UploadInput, file: UploadedFile | undefined): Promise<EmployeeFileView> {
    const { companyId, userId } = caller();
    const employment = await this.employment(companyId, employmentId, F.upload);

    const errors: FieldError[] = [];
    let mime: EmployeeFileMime | null = null;
    if (!file) errors.push({ field: 'file', code: 'required', message: 'A PDF, JPEG or PNG file is required.' });
    else if (file.buffer.length === 0) errors.push({ field: 'file', code: 'empty', message: 'The file is empty.' });
    else {
      mime = sniffFileType(file.buffer);
      if (!mime) errors.push({ field: 'file', code: 'unsupported_type', message: 'PDF, JPEG or PNG only (checked on the content).' });
    }
    const category: CategoryRow | undefined = (await this.repo.categories(companyId)).find((c) => c.id === input.categoryId);
    if (!category) errors.push({ field: 'categoryId', code: 'not_found', message: 'No such category.' });
    else if (!category.active) errors.push({ field: 'categoryId', code: 'inactive', message: 'This category is no longer used.' });
    if (input.documentDate && input.expiresOn && input.expiresOn < input.documentDate) {
      errors.push({ field: 'expiresOn', code: 'before_document_date', message: 'The expiry date is before the document date.' });
    }
    if (errors.length || !file || !mime || !category) throw new ValidationProblemException(errors);

    if (!(await this.can(permissionsFor('upload', category.accessClass), employment.unitId))) {
      throw new ProblemException(403, 'forbidden-field', 'Adding medical documents needs employee.medical.update.', [
        { field: 'categoryId', code: 'forbidden', message: 'Medical category: employee.medical.update is needed.' },
      ]);
    }

    const sha256 = createHash('sha256').update(file.buffer).digest();
    if (await this.repo.liveDuplicate(companyId, employment.employmentId, sha256)) throw duplicate();
    let id: string;
    try {
      id = await this.repo.insertFile(companyId, {
        employmentId: employment.employmentId,
        categoryId: category.id,
        title: input.title,
        originalFilename: sanitizeFilename(file.originalname),
        mime,
        sha256,
        documentDate: input.documentDate,
        expiresOn: input.expiresOn,
        uploadedBy: userId,
        content: file.buffer,
      });
    } catch (error) {
      if (pgError(error)?.constraint === 'employee_file_live_sha_uk') throw duplicate();
      throw error;
    }
    const row = await this.repo.file(companyId, id);
    if (!row) throw fileNotFound();
    const [view] = await this.views(companyId, [row], employment.unitId);
    if (!view) throw fileNotFound();
    return view;
  }

  // ── download ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** GET /employees/:id/files/:fileId/content: the bytes as an attachment; every download is audited. */
  async content(employmentId: string, fileId: string): Promise<FileDownload> {
    const { companyId } = caller();
    const employment = await this.employment(companyId, employmentId, F.read);
    const file = await this.visibleFile(companyId, employment, fileId);
    if (file.deletedAt || file.purgedAt) throw fileNotFound();
    const bytes = await this.repo.content(companyId, fileId);
    if (!bytes) throw fileNotFound();
    await this.audit.record({
      type: 'employee_file.downloaded',
      subject: { type: 'employee_file', id: fileId },
      data: { fileId, categoryCode: file.categoryCode, accessClass: file.accessClass },
    });
    return { bytes, mime: file.mime, disposition: attachmentDisposition(downloadFilename(file.originalFilename, file.mime)), sha256: file.sha256 };
  }

  // ── delete ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** POST /employees/:id/files/:fileId/delete: tombstone + bytes removed in one transaction; 409 employee-file-deleted. */
  async delete(employmentId: string, fileId: string, reason: string): Promise<void> {
    const { companyId, userId } = caller();
    const employment = await this.employment(companyId, employmentId, F.read);
    const file = await this.visibleFile(companyId, employment, fileId);
    if (!(await this.scopes.inScope(F.delete, employment.unitId))) {
      throw new ProblemException(403, 'forbidden-scope', 'You cannot delete files of this employee (outside your employee_file.delete scope).');
    }
    if (!(await this.can(permissionsFor('delete', file.accessClass), employment.unitId))) {
      throw new ProblemException(403, 'forbidden-field', 'Deleting medical documents needs employee.medical.update.', [
        { field: 'categoryId', code: 'forbidden', message: 'Medical category: employee.medical.update is needed.' },
      ]);
    }
    if (file.deletedAt || file.purgedAt || !(await this.repo.deleteFile(companyId, fileId, userId, reason))) {
      throw new ProblemException(409, 'employee-file-deleted', 'This file was already deleted.');
    }
    await this.audit.record({ type: 'employee_file.deleted', subject: { type: 'employee_file', id: fileId }, data: { fileId, reason } });
  }
}

