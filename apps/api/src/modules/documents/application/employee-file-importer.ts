import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { requireContext } from '../../../platform/context/request-context.js';
import type { EmployeeFileMime } from '../domain/employee-files.js';
import { EmployeeFilesRepository } from '../infra/employee-files.repository.js';

/** The system category the hire of a recruited candidate copies files into (migration 0019, SYSTEM_FILE_CATEGORIES). */
export const RECRUITMENT_FILE_CATEGORY = 'recruitment';

export interface ImportedFile {
  title: string;
  originalFilename: string;
  mime: EmployeeFileMime;
  content: Buffer;
}

/**
 * Copies files into an employee file from inside another use case's request transaction (docs/contracts/recruitment.md
 * › Hire, step 4): one `employee_file` + content row per file, in the system category `recruitment`, with the same
 * title, file name, type and bytes; `uploaded_by` is the caller. A file whose bytes are already live in that employee's
 * file is skipped. No employee_file.upload permission is asked: the calling use case's own permission (the hire)
 * covers the copy. The bytes were sniffed when the candidate file was uploaded (same rules, same code). Everything is
 * written through the request transaction, so a failure of the caller rolls the copies back with the rest.
 */
@Injectable()
export class EmployeeFileImporter {
  constructor(private readonly repo: EmployeeFilesRepository) {}

  /** → how many files were copied (duplicates skipped). */
  async copy(employmentId: string, files: readonly ImportedFile[]): Promise<number> {
    return (await this.copyEach(employmentId, files)).filter((r) => r.created).length;
  }

  /**
   * As {@link copy}, into the system category `categoryCode` (default `recruitment`; the profile module's approved
   * supporting documents use `supporting_document`, docs/contracts/profile-changes.md): one result per input file, in
   * order — the employee-file id (the existing live one for a duplicate) and whether it was created.
   */
  async copyEach(employmentId: string, files: readonly ImportedFile[], categoryCode: string = RECRUITMENT_FILE_CATEGORY): Promise<{ employeeFileId: string; created: boolean }[]> {
    const { companyId, userId } = requireContext();
    if (!companyId || !userId) throw new Error('EmployeeFileImporter needs a signed-in request');
    if (files.length === 0) return [];
    const category = (await this.repo.categories(companyId)).find((c) => c.code === categoryCode);
    if (!category) throw new Error(`employee-file category ${categoryCode} missing (seedDocumentDefaults)`);
    const results: { employeeFileId: string; created: boolean }[] = [];
    const seen = new Map<string, string>();
    for (const file of files) {
      const sha256 = createHash('sha256').update(file.content).digest();
      const key = sha256.toString('hex');
      const existing = seen.get(key) ?? (await this.repo.liveDuplicateId(companyId, employmentId, sha256));
      if (existing) {
        results.push({ employeeFileId: existing, created: false });
        continue;
      }
      const id = await this.repo.insertFile(companyId, {
        employmentId,
        categoryId: category.id,
        title: file.title,
        originalFilename: file.originalFilename,
        mime: file.mime,
        sha256,
        documentDate: null,
        expiresOn: null,
        uploadedBy: userId,
        content: file.content,
      });
      seen.set(key, id);
      results.push({ employeeFileId: id, created: true });
    }
    return results;
  }
}
