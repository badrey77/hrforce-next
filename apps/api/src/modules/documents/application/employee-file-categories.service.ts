import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ProblemException } from '../../../platform/http/problem-details.js';
import { DOCUMENT_PERMISSIONS as P } from '../domain/types.js';
import { pgError } from '../infra/documents.repository.js';
import { EmployeeFilesRepository } from '../infra/employee-files.repository.js';
import { caller } from './documents.service.js';
import { categoryView, type EmployeeFileCategoryView } from './employee-file-views.js';

export interface CategoryInput {
  code: string;
  labels: { fr: string; ar: string; en: string };
  retentionYearsAfterEnd?: number | null | undefined;
}

export interface CategoryPatch {
  labels?: { fr: string; ar: string; en: string } | undefined;
  retentionYearsAfterEnd?: number | null | undefined;
  active?: boolean | undefined;
}

const taken = () =>
  new ProblemException(409, 'category-code-taken', 'Another category already uses this code.', [{ field: 'code', code: 'taken', message: 'Already used.' }]);

/**
 * Employee file categories (docs/contracts/documents.md › Phase B › Endpoints /employee-files/categories): read by
 * anyone signed in; created (standard class only) and edited with `document.configure` over the WHOLE company (else
 * 403 forbidden-scope, like the other document settings). The code, class and system flag never change (DB guard).
 */
@Injectable()
export class EmployeeFileCategoriesService {
  constructor(
    private readonly repo: EmployeeFilesRepository,
    private readonly scopes: ScopeService,
  ) {}

  private async assertCompanyWide(): Promise<void> {
    if (!(await this.scopes.coversCompany(P.configure))) {
      throw new ProblemException(403, 'forbidden-scope', 'Document settings apply to the whole company: document.configure over the root unit is needed.');
    }
  }

  async list(): Promise<{ items: EmployeeFileCategoryView[] }> {
    const { companyId } = caller();
    return { items: (await this.repo.categories(companyId)).map(categoryView) };
  }

  private async view(companyId: string, id: string): Promise<EmployeeFileCategoryView> {
    const row = (await this.repo.categories(companyId)).find((c) => c.id === id);
    if (!row) throw new NotFoundException('Category not found');
    return categoryView(row);
  }

  async create(input: CategoryInput): Promise<EmployeeFileCategoryView> {
    const { companyId } = caller();
    await this.assertCompanyWide();
    const existing = await this.repo.categories(companyId);
    if (existing.some((c) => c.code === input.code)) throw taken();
    let id: string;
    try {
      id = await this.repo.insertCategory(companyId, {
        code: input.code,
        nameFr: input.labels.fr,
        nameAr: input.labels.ar,
        nameEn: input.labels.en,
        retentionYearsAfterEnd: input.retentionYearsAfterEnd ?? null,
        sortOrder: Math.max(0, ...existing.map((c) => c.sortOrder)) + 10,
      });
    } catch (error) {
      if (pgError(error)?.constraint === 'employee_file_category_company_code_uk') throw taken();
      throw error;
    }
    return this.view(companyId, id);
  }

  async update(id: string, input: CategoryPatch): Promise<EmployeeFileCategoryView> {
    const { companyId } = caller();
    if (!(await this.repo.categories(companyId)).some((c) => c.id === id)) throw new NotFoundException('Category not found');
    await this.assertCompanyWide();
    const patch: Record<string, unknown> = {};
    if (input.labels) Object.assign(patch, { name_fr: input.labels.fr, name_ar: input.labels.ar, name_en: input.labels.en });
    if (input.retentionYearsAfterEnd !== undefined) patch['retention_years_after_end'] = input.retentionYearsAfterEnd;
    if (input.active !== undefined) patch['active'] = input.active;
    await this.repo.updateCategory(companyId, id, patch);
    return this.view(companyId, id);
  }
}
