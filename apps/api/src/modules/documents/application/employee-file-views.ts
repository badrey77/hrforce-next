/** Response shapes of docs/contracts/documents.md › Phase B › Endpoints (the API layer returns them as-is). */
import type { AccessClass } from '../domain/employee-files.js';
import type { CategoryRow } from '../infra/employee-files.repository.js';
import type { Labels, UserRefView } from './document-views.js';

export interface EmployeeFileCategoryView {
  id: string;
  code: string;
  labels: Labels;
  accessClass: AccessClass;
  retentionYearsAfterEnd: number | null;
  active: boolean;
  isSystem: boolean;
  sortOrder: number;
}

export interface EmployeeFileView {
  id: string;
  employmentId: string;
  category: { id: string; code: string; labels: Labels; accessClass: AccessClass };
  title: string;
  originalFilename: string;
  mime: string;
  sizeBytes: number;
  /** hex */
  sha256: string;
  documentDate: string | null;
  expiresOn: string | null;
  uploadedAt: string;
  uploadedBy: UserRefView | null;
  deleted: { at: string; by: UserRefView | null; reason: string } | null;
  purgedAt: string | null;
  _actions: 'delete'[];
}

export interface EmployeeFileListView {
  items: EmployeeFileView[];
  /** `medical` when the caller cannot see medical files of this employee (whether or not there are any) */
  _redacted: 'medical'[];
  _actions: ('upload' | 'upload_medical')[];
}

export function categoryView(c: CategoryRow): EmployeeFileCategoryView {
  return {
    id: c.id,
    code: c.code,
    labels: { fr: c.nameFr, ar: c.nameAr, en: c.nameEn },
    accessClass: c.accessClass,
    retentionYearsAfterEnd: c.retentionYearsAfterEnd,
    active: c.active,
    isSystem: c.isSystem,
    sortOrder: c.sortOrder,
  };
}
