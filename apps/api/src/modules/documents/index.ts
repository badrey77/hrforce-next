/** Public surface of the Documents module (the only file other modules may import). */
export { DocumentsModule } from './documents.module.js';
export { algiersToday, DocumentsClock } from './application/documents-clock.js';
export { DOCUMENT_PERMISSIONS, DOCUMENT_TYPE_CODES, TEMPLATE_VERSIONS, type DocumentLanguage, type DocumentTypeCode } from './domain/types.js';
export type { DocumentSnapshot } from './domain/snapshot.js';
export { runEmployeeFileRetention, type RetentionRunResult } from './application/employee-file-retention.js';
export {
  attachmentDisposition,
  downloadFilename,
  EMPLOYEE_FILE_DEFAULT_MAX_BYTES,
  EMPLOYEE_FILE_HARD_MAX_BYTES,
  EMPLOYEE_FILE_PERMISSIONS,
  sanitizeFilename,
  sniffFileType,
  SYSTEM_FILE_CATEGORIES,
  type EmployeeFileMime,
} from './domain/employee-files.js';
// the bounded multipart reader of the employee-file upload, reused as is by the candidate files (recruitment.md › Module boundaries)
export { EmployeeFileUploadInterceptor } from './api/employee-files.controller.js';
export type { UploadedFile } from './application/employee-files.service.js';
export {
  DEMO_SIGNATORIES,
  DOCUMENT_DEFINITION,
  demoLogoPng,
  seedCompanyProfile,
  seedDemoDocuments,
  seedDemoDocumentSettings,
  seedDocumentDefaults,
  seedSignatory,
  type SeedProfile,
} from './infra/documents-seed.js';
export { DEMO_EMPLOYEE_FILES, demoPdf, seedDemoEmployeeFiles, seedEmployeeFiles, type SeedEmployeeFile } from './infra/employee-files-seed.js';
