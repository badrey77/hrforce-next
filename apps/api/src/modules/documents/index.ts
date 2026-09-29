/** Public surface of the Documents module (the only file other modules may import). */
export { DocumentsModule } from './documents.module.js';
export { algiersToday, DocumentsClock } from './application/documents-clock.js';
export { DOCUMENT_PERMISSIONS, DOCUMENT_TYPE_CODES, TEMPLATE_VERSIONS, type DocumentLanguage, type DocumentTypeCode } from './domain/types.js';
export type { DocumentSnapshot } from './domain/snapshot.js';
export { runEmployeeFileRetention, type RetentionRunResult } from './application/employee-file-retention.js';
export { EMPLOYEE_FILE_PERMISSIONS, SYSTEM_FILE_CATEGORIES } from './domain/employee-files.js';
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
