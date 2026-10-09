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
    const { companyId, userId } = requireContext();
    if (!companyId || !userId) throw new Error('EmployeeFileImporter needs a signed-in request');
    if (files.length === 0) return 0;
    const category = (await this.repo.categories(companyId)).find((c) => c.code === RECRUITMENT_FILE_CATEGORY);
    if (!category) throw new Error(`employee-file category ${RECRUITMENT_FILE_CATEGORY} missing (seedDocumentDefaults)`);
    let copied = 0;
    const seen = new Set<string>();
    for (const file of files) {
      const sha256 = createHash('sha256').update(file.content).digest();
      const key = sha256.toString('hex');
      if (seen.has(key) || (await this.repo.liveDuplicate(companyId, employmentId, sha256))) continue;
      seen.add(key);
      await this.repo.insertFile(companyId, {
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
      copied += 1;
    }
    return copied;
  }
}
