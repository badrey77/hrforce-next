import { HttpClient } from '@angular/common/http';
import type { Provider } from '@angular/core';
import type {
  EmployeeFileCategory,
  EmployeeFileList,
  EmployeeFileView,
} from '../app/core/employee-files/employee-files.models';
import { UPLOAD_HTTP_CLIENT } from '../app/core/http/upload-http';

/** Categories shaped like the contract's seed (docs/contracts/documents.md › Phase B › Data). */
function category(id: string, code: string, fr: string, ar: string, en: string, accessClass: 'standard' | 'medical' = 'standard'): EmployeeFileCategory {
  return { id, code, labels: { fr, ar, en }, accessClass, retentionYearsAfterEnd: null, active: true, isSystem: true };
}

export const CAT_DIPLOMA = category('c-diploma', 'diploma', 'Diplômes', 'الشهادات', 'Diplomas');
export const CAT_CONTRACT = category('c-contract', 'contract', 'Contrats et avenants', 'العقود والملاحق', 'Contracts');
export const CAT_ID = category('c-id', 'id_document', 'Pièces d’identité', 'وثائق الهوية', 'ID documents');
export const CAT_MEDICAL = category('c-medical', 'medical', 'Médical', 'طبي', 'Medical', 'medical');
export const CAT_OTHER = category('c-other', 'other', 'Autres', 'أخرى', 'Other');
export const FILE_CATEGORIES: readonly EmployeeFileCategory[] = [CAT_DIPLOMA, CAT_CONTRACT, CAT_ID, CAT_MEDICAL, CAT_OTHER];

export function categoryRef(c: EmployeeFileCategory): EmployeeFileView['category'] {
  return { id: c.id, code: c.code, labels: c.labels, accessClass: c.accessClass };
}

export function employeeFile(extra: Partial<EmployeeFileView> = {}): EmployeeFileView {
  return {
    id: 'f-1',
    employmentId: 'e-1',
    category: categoryRef(CAT_DIPLOMA),
    title: 'Licence en droit',
    originalFilename: 'licence_droit.pdf',
    mime: 'application/pdf',
    sizeBytes: 250_000,
    sha256: 'ab'.repeat(32),
    documentDate: '2012-06-30',
    expiresOn: null,
    uploadedAt: '2026-09-28T10:00:00Z',
    uploadedBy: { id: 'u-amina', displayName: 'Amina Benali' },
    deleted: null,
    purgedAt: null,
    _actions: ['delete'],
    ...extra,
  };
}

export const FILE_ID_CARD = employeeFile({
  id: 'f-2',
  category: categoryRef(CAT_ID),
  title: 'Carte nationale',
  originalFilename: 'cni.jpg',
  mime: 'image/jpeg',
  sizeBytes: 800,
  documentDate: null,
  expiresOn: '2020-01-01',
});

export function fileList(extra: Partial<EmployeeFileList> = {}): EmployeeFileList {
  return { items: [employeeFile(), FILE_ID_CARD], _redacted: [], _actions: ['upload'], ...extra };
}

/**
 * Sends uploads through the TESTING backend: the real `UPLOAD_HTTP_CLIENT` builds its own XHR-backed client
 * (core/http/upload-http.ts), which `HttpTestingController` would not see.
 */
export function provideUploadsThroughTestingBackend(): Provider {
  return { provide: UPLOAD_HTTP_CLIENT, useExisting: HttpClient };
}

/** A `File` of `size` bytes (content irrelevant). */
export function fakeFile(name: string, type: string, size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}
